/**
 * On-demand log reads. The live SSE stream is a separate concern and lives
 * in platform/logStream.ts.
 */
import path from "path";

import { execSafe } from "../platform/exec.js";
import type { InstanceConfig } from "../config/types.js";

export function createLogs(cfg: InstanceConfig) {
async function tailLog(lines: number): Promise<string> {
  const logFile = path.join(cfg.serverPath, "logs", "latest.log");
  const { stdout, ok } = await execSafe("tail", ["-n", String(lines), logFile]);
  return ok ? stdout : "";
}

  return { tailLog };
}
