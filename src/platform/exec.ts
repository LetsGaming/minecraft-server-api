/**
 * Thin execFile wrapper — the single place child processes are spawned
 * for read-only queries (ps, df, tail). No shell is ever involved, so
 * arguments cannot be interpreted as shell syntax. Mirrors the bot's
 * execCommand layer in spirit; kept separate so tests can stub it.
 */
import { execFile } from "child_process";

export interface ExecResult {
  stdout: string;
  ok: boolean;
}

export function execSafe(
  cmd: string,
  args: string[],
  timeoutMs = 5_000,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => {
      resolve({ stdout: stdout ?? "", ok: !err });
    });
  });
}
