/**
 * Backup tier inventory, read from the rotation layout the setup suite writes.
 */
import fsp from "fs/promises";
import path from "path";

import type { InstanceConfig } from "../config/types.js";
import type { BackupDirInfo, BackupSummary } from "../contracts/wire.js";

export function createBackups(cfg: InstanceConfig) {
async function getBackups(): Promise<BackupSummary> {
  if (!cfg.backupsPath) return { dirs: [], totalBytes: 0 };

  const subdirs = [
    "hourly",
    "archives/daily",
    "archives/weekly",
    "archives/monthly",
    "archives/update",
  ];
  const backupsPath = cfg.backupsPath;

  // Backup tiers accumulate thousands of archives, and this used to be
  // five synchronous readdir + stat passes on the event loop — every other
  // request, /health included, waited behind it. Async, and the five tiers
  // in parallel.
  async function readTier(dir: string): Promise<BackupDirInfo | null> {
    const fullDir = path.join(backupsPath, dir);
    let files: string[];
    try {
      files = (await fsp.readdir(fullDir)).filter(
        (f) => f.endsWith(".tar.zst") || f.endsWith(".tar.gz"),
      );
    } catch {
      return null; // tier not present
    }
    if (!files.length) return null;

    files.sort().reverse();
    const latest = files[0]!;
    // A-06: backup rotation can delete the file between readdir and stat;
    // skip this tier rather than fail the whole response.
    try {
      const stat = await fsp.stat(path.join(fullDir, latest));
      return {
        dir,
        count: files.length,
        latestFile: latest,
        latestMtimeMs: stat.mtimeMs,
        latestSizeBytes: stat.size,
      };
    } catch {
      return null;
    }
  }

  const dirs = (await Promise.all(subdirs.map(readTier))).filter(
    (d): d is BackupDirInfo => d !== null,
  );
  return {
    dirs,
    totalBytes: dirs.reduce((sum, d) => sum + d.latestSizeBytes, 0),
  };
}

  return { getBackups };
}
