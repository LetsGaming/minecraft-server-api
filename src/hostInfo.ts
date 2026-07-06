/**
 * Host metrics for GET /instances/:id/info — the wrapper half of the
 * bot's "remote host metrics + version handshake" feature. The numbers
 * mirror the bot's LOCAL implementation exactly
 * (minecraft-bot: src/core/utils/hostResources.ts), so an instance
 * reports the same values whether the bot reads them locally or through
 * this wrapper:
 *
 *   process — RAM/CPU of the biggest java process owned by the
 *             instance's linuxUser (`ps` reads other users' processes
 *             without sudo, so no extra sudoers entries are needed)
 *   disks   — `df -Pk` on the server directory and the backups
 *             directory (when configured), deduped by resolved path
 */
import path from "path";
import { execSafe } from "./exec.js";
import type { DiskUsage, HostInfo, InstanceConfig, ProcessUsage } from "./types.js";

/** `df -Pk <dir>` (POSIX output format) → parsed usage, null on failure. */
export async function getDiskUsage(dir: string): Promise<DiskUsage | null> {
  const { stdout, ok } = await execSafe("df", ["-Pk", dir]);
  if (!ok) return null;

  const line = stdout.split("\n")[1];
  if (!line) return null;
  // Filesystem 1024-blocks Used Available Capacity Mounted-on
  const parts = line.trim().split(/\s+/);
  const totalKb = Number(parts[1]);
  const availKb = Number(parts[3]);
  const usedPercent = Number((parts[4] ?? "").replace("%", ""));
  if (
    !Number.isFinite(totalKb) ||
    !Number.isFinite(availKb) ||
    !Number.isFinite(usedPercent)
  ) {
    return null;
  }
  return {
    path: dir,
    usedPercent,
    availableBytes: availKb * 1024,
    totalBytes: totalKb * 1024,
  };
}

/**
 * RAM/CPU of the instance's Java process, identified as the biggest java
 * process owned by linuxUser — same heuristic as the bot's local path.
 */
export async function getServerProcessUsage(
  linuxUser: string,
): Promise<ProcessUsage | null> {
  const { stdout, ok } = await execSafe("ps", [
    "-u",
    linuxUser,
    "-o",
    "pid=,pcpu=,rss=,comm=",
  ]);
  if (!ok) return null;

  let best: ProcessUsage | null = null;
  for (const line of stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const comm = parts.slice(3).join(" ");
    if (!comm.toLowerCase().includes("java")) continue;
    const candidate: ProcessUsage = {
      pid: Number(parts[0]),
      cpuPercent: Number(parts[1]),
      rssBytes: Number(parts[2]) * 1024,
    };
    if (!Number.isFinite(candidate.pid)) continue;
    if (!best || candidate.rssBytes > best.rssBytes) best = candidate;
  }
  return best;
}

/** The paths worth reporting for an instance: server dir + backups dir. */
export function monitoredPaths(cfg: InstanceConfig): string[] {
  const paths = [cfg.serverPath];
  if (cfg.backupsPath) paths.push(cfg.backupsPath);
  // Same filesystem → same df result; dedupe by resolved path.
  return [...new Set(paths.map((p) => path.resolve(p)))];
}

export async function getHostInfo(cfg: InstanceConfig): Promise<HostInfo> {
  const [proc, ...disks] = await Promise.all([
    getServerProcessUsage(cfg.linuxUser),
    ...monitoredPaths(cfg).map((p) => getDiskUsage(p)),
  ]);
  return {
    process: proc,
    disks: disks.filter((d): d is DiskUsage => d !== null),
  };
}
