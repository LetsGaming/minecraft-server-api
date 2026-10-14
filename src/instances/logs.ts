/**
 * On-demand log reads. The live SSE stream is a separate concern and lives
 * in platform/logStream.ts.
 */
import path from "path";

import fsp from "fs/promises";

import { isInside, tailNoFollow } from "../platform/safeFs.js";
import type { InstanceConfig } from "../config/types.js";

/** Bytes read from the end of the log for a tail; past it older lines drop. */
const TAIL_MAX_BYTES = 1024 * 1024;

export function createLogs(cfg: InstanceConfig) {
/**
 * The last `lines` lines of `logs/latest.log`. The server's user owns that
 * directory, so a `latest.log` or `logs/` swapped for a link out of the
 * server directory reads as no log rather than as whatever it points at
 * (W-007).
 */
async function tailLog(lines: number): Promise<string> {
  const logDir = path.join(cfg.serverPath, "logs");
  try {
    const [realDir, realServer] = await Promise.all([
      fsp.realpath(logDir),
      fsp.realpath(cfg.serverPath),
    ]);
    if (!isInside(realDir, realServer)) return "";
    return await tailNoFollow(path.join(realDir, "latest.log"), lines, TAIL_MAX_BYTES);
  } catch {
    return "";
  }
}

  return { tailLog };
}
