/**
 * Host metrics for GET /instances/:id/info.
 *
 * What changed in host-info v2, and why:
 *
 *   process.cpuPercent  was `ps -o pcpu`, which is the average over the
 *                       process's entire lifetime. A server that spent its
 *                       first minutes generating terrain reported ~90% CPU
 *                       forever afterwards while sitting idle. Now sampled
 *                       from /proc/<pid>/stat over a short window.
 *
 *   host                did not exist. The only figure reported was the Java
 *                       process, under a heading that said "Host" — so the
 *                       machine's actual load was never gathered by anyone.
 *
 *   disks               was `df` per monitored path. Both paths usually live
 *                       on one filesystem, so the server dir and the backups
 *                       dir printed identical numbers, which reads as two
 *                       separate disks that happen to match. Each entry now
 *                       carries the directory's own size (du) alongside the
 *                       filesystem block, with the mount point named.
 *
 * /proc is read directly rather than shelling out to top/free: no child
 * process, no locale-dependent output to parse, and it is the same source
 * those tools read.
 */
import fs from "fs/promises";
import os from "os";
import path from "path";
import { execSafe } from "./exec.js";
import type {
  DiskUsage,
  HostInfo,
  HostUsage,
  InstanceConfig,
  ProcessUsage,
} from "./types.js";

/**
 * Sampling window for both CPU figures.
 *
 * Long enough that scheduler jitter averages out, short enough that /info
 * stays responsive — the bot polls it on the 60s status pass and the
 * dashboard on demand.
 */
export const CPU_SAMPLE_MS = 250;

/** USER_HZ. Constant at 100 on every Linux target this runs on. */
const CLOCK_TICKS_PER_SEC = 100;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function readProc(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf-8");
  } catch {
    return null; // non-Linux, or the process exited between samples
  }
}

// ── Whole-machine CPU and memory ─────────────────────────────────────────

export interface CpuTotals {
  idle: number;
  total: number;
}

/** First line of /proc/stat: aggregate jiffies across all cores. */
export function parseProcStat(content: string): CpuTotals | null {
  const line = content.split("\n").find((l) => l.startsWith("cpu "));
  if (!line) return null;
  const fields = line.trim().split(/\s+/).slice(1).map(Number);
  if (fields.length < 5 || fields.some((n) => !Number.isFinite(n))) return null;
  // user nice system idle iowait irq softirq steal …
  // iowait counts as idle: the CPU is not doing work during it.
  const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
  const total = fields.reduce((sum, n) => sum + n, 0);
  return { idle, total };
}

/** MemTotal / MemAvailable in bytes, from /proc/meminfo. */
export function parseMemInfo(
  content: string,
): { totalBytes: number; availableBytes: number } | null {
  const read = (key: string): number | null => {
    const match = new RegExp(`^${key}:\\s+(\\d+) kB$`, "m").exec(content);
    return match ? Number(match[1]) * 1024 : null;
  };
  const totalBytes = read("MemTotal");
  const availableBytes = read("MemAvailable");
  if (totalBytes === null || availableBytes === null) return null;
  return { totalBytes, availableBytes };
}

/** Utilisation between two /proc/stat samples, as a 0–100 percentage. */
export function cpuPercentBetween(a: CpuTotals, b: CpuTotals): number {
  const totalDelta = b.total - a.total;
  const idleDelta = b.idle - a.idle;
  if (totalDelta <= 0) return 0;
  const busy = ((totalDelta - idleDelta) / totalDelta) * 100;
  return Math.min(100, Math.max(0, Number(busy.toFixed(1))));
}

// ── Per-process CPU ──────────────────────────────────────────────────────

/** utime + stime from /proc/<pid>/stat, in jiffies. */
export function parsePidCpuJiffies(content: string): number | null {
  // The comm field is parenthesised and may contain spaces or brackets, so
  // split after the last ')' rather than on whitespace from the start.
  const close = content.lastIndexOf(")");
  if (close === -1) return null;
  const fields = content.slice(close + 1).trim().split(/\s+/);
  // fields[0] is state; utime/stime are man-page fields 14/15, i.e. 11/12 here.
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return utime + stime;
}

/**
 * CPU share over CPU_SAMPLE_MS, normalised the way `top` reports it: a
 * process saturating two cores reads 200%.
 */
async function sampleProcessCpu(pid: number): Promise<number | null> {
  const first = await readProc(`/proc/${pid}/stat`);
  const a = first ? parsePidCpuJiffies(first) : null;
  if (a === null) return null;

  await sleep(CPU_SAMPLE_MS);

  const second = await readProc(`/proc/${pid}/stat`);
  const b = second ? parsePidCpuJiffies(second) : null;
  if (b === null) return null;

  const seconds = CPU_SAMPLE_MS / 1000;
  const percent = ((b - a) / CLOCK_TICKS_PER_SEC / seconds) * 100;
  return Math.max(0, Number(percent.toFixed(1)));
}

// ── Disk ─────────────────────────────────────────────────────────────────

/** `df -Pk <dir>` (POSIX output) → filesystem figures, null on failure. */
export async function getFilesystemUsage(
  dir: string,
): Promise<DiskUsage["filesystem"] | null> {
  const { stdout, ok } = await execSafe("df", ["-Pk", dir]);
  if (!ok) return null;

  const line = stdout.split("\n")[1];
  if (!line) return null;
  // Filesystem 1024-blocks Used Available Capacity Mounted-on
  const parts = line.trim().split(/\s+/);
  const totalKb = Number(parts[1]);
  const availKb = Number(parts[3]);
  const usedPercent = Number((parts[4] ?? "").replace("%", ""));
  const mountPoint = parts.slice(5).join(" ");
  if (
    !Number.isFinite(totalKb) ||
    !Number.isFinite(availKb) ||
    !Number.isFinite(usedPercent)
  ) {
    return null;
  }
  return {
    mountPoint: mountPoint || "/",
    usedPercent,
    availableBytes: availKb * 1024,
    totalBytes: totalKb * 1024,
  };
}

/**
 * `du -sk <dir>` → the directory's own size in bytes.
 *
 * Given a longer timeout than the other probes: a backups directory with
 * many tiers can take seconds to walk on spinning disks. Returns null on
 * timeout rather than failing the whole response — the filesystem figures
 * are still worth reporting without it.
 */
export async function getDirectorySize(dir: string): Promise<number | null> {
  const { stdout, ok } = await execSafe("du", ["-sk", dir], 20_000);
  if (!ok) return null;
  const kb = Number(stdout.trim().split(/\s+/)[0]);
  return Number.isFinite(kb) ? kb * 1024 : null;
}

export async function getDiskUsage(dir: string): Promise<DiskUsage | null> {
  const [filesystem, sizeBytes] = await Promise.all([
    getFilesystemUsage(dir),
    getDirectorySize(dir),
  ]);
  if (!filesystem) return null;
  return { path: dir, sizeBytes, filesystem };
}

/** The paths worth reporting for an instance: server dir + backups dir. */
export function monitoredPaths(cfg: InstanceConfig): string[] {
  const paths = [cfg.serverPath];
  if (cfg.backupsPath) paths.push(cfg.backupsPath);
  // Identical paths collapse to one entry. Distinct paths that share a
  // filesystem are NOT deduped — they have different directory sizes, which
  // is the figure that makes them worth listing separately.
  return [...new Set(paths.map((p) => path.resolve(p)))];
}

// ── Public API ───────────────────────────────────────────────────────────

/** Whole-machine CPU and memory. null where /proc is unavailable. */
export async function getHostUsage(): Promise<HostUsage | null> {
  const first = await readProc("/proc/stat");
  const a = first ? parseProcStat(first) : null;
  if (!a) return null;

  await sleep(CPU_SAMPLE_MS);

  const [second, meminfo] = await Promise.all([
    readProc("/proc/stat"),
    readProc("/proc/meminfo"),
  ]);
  const b = second ? parseProcStat(second) : null;
  const mem = meminfo ? parseMemInfo(meminfo) : null;
  if (!b || !mem) return null;

  return {
    cpuPercent: cpuPercentBetween(a, b),
    cpuCount: os.cpus().length,
    memTotalBytes: mem.totalBytes,
    memUsedBytes: mem.totalBytes - mem.availableBytes,
    uptimeSeconds: Math.round(os.uptime()),
  };
}

/**
 * The instance's Java process: still identified as the biggest java process
 * owned by linuxUser (`ps` reads other users' processes without sudo), but
 * its CPU share is sampled rather than taken from `ps`.
 */
export async function getServerProcessUsage(
  linuxUser: string,
): Promise<ProcessUsage | null> {
  const { stdout, ok } = await execSafe("ps", [
    "-u",
    linuxUser,
    "-o",
    "pid=,rss=,comm=",
  ]);
  if (!ok) return null;

  let pid: number | null = null;
  let rssBytes = 0;
  for (const line of stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const comm = parts.slice(2).join(" ");
    if (!comm.toLowerCase().includes("java")) continue;
    const candidatePid = Number(parts[0]);
    const candidateRss = Number(parts[1]) * 1024;
    if (!Number.isFinite(candidatePid) || !Number.isFinite(candidateRss)) {
      continue;
    }
    if (pid === null || candidateRss > rssBytes) {
      pid = candidatePid;
      rssBytes = candidateRss;
    }
  }
  if (pid === null) return null;

  // A process that exits mid-sample yields null; 0% is the honest reading
  // for "it is no longer using any CPU".
  const cpuPercent = (await sampleProcessCpu(pid)) ?? 0;
  return { pid, rssBytes, cpuPercent };
}

export async function getHostInfo(cfg: InstanceConfig): Promise<HostInfo> {
  // Both CPU samplers sleep for the window, so running them together costs
  // one window rather than two.
  const [proc, host, ...disks] = await Promise.all([
    getServerProcessUsage(cfg.linuxUser),
    getHostUsage(),
    ...monitoredPaths(cfg).map((p) => getDiskUsage(p)),
  ]);
  return {
    process: proc,
    host,
    disks: disks.filter((d): d is DiskUsage => d !== null),
  };
}
