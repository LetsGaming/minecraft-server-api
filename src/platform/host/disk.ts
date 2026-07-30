/**
 * Filesystem and directory-size probes.
 *
 * `df`/`du` rather than a Node walk: both are cheap, already correct about
 * hard links and sparse files, and never block the event loop.
 */
import path from "path";

import { execSafe } from "../exec.js";
import type { DiskUsage } from "../../contracts/wire.js";
import type { InstanceConfig } from "../../config/types.js";

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
