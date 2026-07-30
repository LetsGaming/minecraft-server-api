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
import os from "os";

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
import { execSafe } from "../exec.js";
import type {
  DiskUsage,
  HostInfo,
  HostUsage,
  ProcessUsage,
} from "../../contracts/wire.js";
import type { InstanceConfig } from "../../config/types.js";

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
