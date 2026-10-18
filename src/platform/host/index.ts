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
import fsp from "fs/promises";
import os from "os";
import path from "path";

import {
  CPU_SAMPLE_MS,
  cpuPercentBetween,
  parseMemInfo,
  parseProcStat,
  readProc,
  sampleProcessCpu,
  sleep,
} from "./cpu.js";
import { getDiskUsage, monitoredPaths } from "./disk.js";
import { isJavaRow, parsePsRows, pickServerProcess, screenAnchors, type PsRow } from "./processMatch.js";
import { cached } from "../cache.js";
import { execSafe } from "../exec.js";
import type {
  DiskUsage,
  HostInfo,
  HostUsage,
  ProcessUsage,
} from "../../contracts/wire.js";
import type { InstanceConfig } from "../../config/types.js";

/**
 * Disk sizes cost a `du -sk` full recursive walk per monitored path (the
 * server directory and the backups directory, both potentially multi-GB) and
 * disks fill slowly, so they get a long TTL. `df`/CPU/process figures are
 * cheap and change quickly, so they get a short one — one TTL could not
 * serve both without either re-walking every poll or reporting stale CPU.
 */
const DISK_FRESH_MS = 60_000;
const DISK_STALE_MS = 300_000;
const diskCachesByPath = new Map<string, ReturnType<typeof cached<DiskUsage | null>>>();

function cachedDiskUsage(dir: string): ReturnType<typeof cached<DiskUsage | null>> {
  let entry = diskCachesByPath.get(dir);
  if (!entry) {
    entry = cached(() => getDiskUsage(dir), { freshMs: DISK_FRESH_MS, staleMs: DISK_STALE_MS });
    diskCachesByPath.set(dir, entry);
  }
  return entry;
}

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
 * Which of the user's processes is this instance's server. Several instances
 * may share a Linux user, so with `serverPath` the process is matched to the
 * instance: by its working directory where /proc lets us read it, otherwise by
 * sitting below the instance's screen session or systemd main process. A user
 * process that cannot be tied to the instance is not reported. Without
 * `serverPath` the biggest java process of the user is taken. CPU is sampled
 * from /proc rather than taken from `ps`.
 */
export interface ServerProcessOptions {
  /** False for a liveness check, which does not need the 250 ms CPU sample. */
  sampleCpu?: boolean;
  /** The instance's server directory and id: match its own process instead of the user's biggest. */
  serverPath?: string;
  instanceId?: string;
  /** The working directory of a pid, or null where it cannot be read. Defaults to /proc/<pid>/cwd. */
  readCwd?: (pid: number) => Promise<string | null>;
}

async function readProcCwd(pid: number): Promise<string | null> {
  try {
    return (await fsp.readlink(`/proc/${pid}/cwd`)).replace(/ \(deleted\)$/, "");
  } catch {
    return null;
  }
}

async function sameDirectory(a: string, b: string): Promise<boolean> {
  const real = async (p: string): Promise<string> => fsp.realpath(p).catch(() => path.resolve(p));
  return (await real(a)) === (await real(b));
}

/** The unit's main pid from systemd; null when there is no unit, no sudo grant or no systemd. */
async function unitMainPid(instanceId: string): Promise<number | null> {
  const { stdout, ok } = await execSafe(
    "sudo",
    ["-n", "systemctl", "show", `${instanceId}.service`, "-p", "MainPID", "--value"],
    5_000,
  );
  const pid = ok ? parseInt(stdout.trim(), 10) : NaN;
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export async function getServerProcessUsage(
  linuxUser: string,
  { sampleCpu = true, serverPath, instanceId, readCwd = readProcCwd }: ServerProcessOptions = {},
): Promise<ProcessUsage | null> {
  const { stdout, ok } = await execSafe("ps", ["-u", linuxUser, "-o", "pid=,ppid=,rss=,args="]);
  if (!ok) return null;

  const rows = parsePsRows(stdout);
  const javas = rows.filter(isJavaRow);
  let chosen: PsRow | null = null;

  if (serverPath === undefined) {
    for (const row of javas) if (chosen === null || row.rssKb > chosen.rssKb) chosen = row;
  } else {
    const byCwd: PsRow[] = [];
    const unresolved: PsRow[] = [];
    for (const row of javas) {
      const cwd = await readCwd(row.pid);
      if (cwd === null) unresolved.push(row);
      else if (await sameDirectory(cwd, serverPath)) byCwd.push(row);
    }
    let anchors: number[] = [];
    if (byCwd.length === 0 && unresolved.length > 0 && instanceId !== undefined) {
      anchors = screenAnchors(rows, instanceId);
      if (anchors.length === 0) {
        const main = await unitMainPid(instanceId);
        if (main !== null) anchors = [main];
      }
    }
    chosen = pickServerProcess(rows, byCwd, unresolved, anchors);
  }
  if (chosen === null) return null;

  // A process that exits mid-sample yields null; 0% is the honest reading
  // for "it is no longer using any CPU".
  const cpuPercent = sampleCpu ? ((await sampleProcessCpu(chosen.pid)) ?? 0) : 0;
  return { pid: chosen.pid, rssBytes: chosen.rssKb * 1024, cpuPercent };
}

export async function getHostInfo(cfg: InstanceConfig): Promise<HostInfo> {
  // Both CPU samplers sleep for the window, so running them together costs
  // one window rather than two.
  const [proc, host, ...disks] = await Promise.all([
    getServerProcessUsage(cfg.linuxUser, { serverPath: cfg.serverPath, instanceId: cfg.id }),
    getHostUsage(),
    ...monitoredPaths(cfg).map((p) => cachedDiskUsage(p).get().then((e) => e.value)),
  ]);
  return {
    process: proc,
    host,
    disks: disks.filter((d): d is DiskUsage => d !== null),
  };
}
