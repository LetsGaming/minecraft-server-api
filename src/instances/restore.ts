/**
 * Restoring a world from one of the archives in the backups directory.
 *
 * This is its own module, and its own route, rather than another entry in
 * SCRIPT_MAP — the design constraint that forced the split is worth stating
 * plainly, because the obvious port of the old panel's code cannot work here.
 *
 * The old panel ran `restore.sh --file <absolute path> --y`, with the path
 * coming from the HTTP request. This wrapper's `/scripts/run` validates every
 * argument against SAFE_ARG, which forbids "/" precisely so a client cannot
 * hand a path to a spawned shell. So the argument shape is unportable by
 * design, and loosening SAFE_ARG to accommodate it would give away the guard
 * for every script at once.
 *
 * Instead the client sends an opaque backup id, this module resolves it
 * against the index in backupFiles.ts, and the path handed to the script is
 * one the wrapper computed. The client never names a path, which is the same
 * rule the download route follows.
 */
import { spawn } from "child_process";
import fsp from "fs/promises";
import path from "path";

import type { InstanceConfig } from "../config/types.js";
import type { ScriptResult } from "../contracts/wire.js";
import { RESTORE_SCRIPT } from "./scripts.js";

/**
 * Ten minutes. A restore unpacks a whole world, and unlike a backup it cannot
 * be retried cheaply: a timeout here SIGTERMs the script partway through
 * writing the world directory it is restoring into.
 */
const RESTORE_TIMEOUT_MS = 600_000;

export function createRestore(cfg: InstanceConfig) {
  async function scriptPath(): Promise<string | null> {
    const target = path.join(cfg.scriptsDir, RESTORE_SCRIPT);
    try {
      await fsp.access(target);
      return target;
    } catch {
      return null;
    }
  }

  /**
   * Run the suite's restore script against an already-resolved archive.
   *
   * `absPath` MUST come from backupFiles.resolve(). Nothing here re-validates
   * it, because there is exactly one caller and the containment check belongs
   * with the listing that produced the path — duplicating it would create the
   * usual second copy that drifts.
   */
  async function restore(absPath: string): Promise<ScriptResult> {
    const script = await scriptPath();
    if (!script) {
      throw new Error(`Script not found: ${path.join(cfg.scriptsDir, RESTORE_SCRIPT)}`);
    }

    return new Promise((resolve, reject) => {
      const child = spawn(
        "sudo",
        ["-n", "-u", cfg.linuxUser, "bash", script, "--file", absPath, "--y"],
        {
          cwd: cfg.scriptsDir,
          env: { ...process.env, HOME: `/home/${cfg.linuxUser}` },
          stdio: ["ignore", "pipe", "pipe"],
          // Process-group leader, so the timeout below can signal the whole
          // tree rather than just the sudo parent (BUG-01 in scripts.ts).
          detached: true,
        },
      );

      let stdout = "";
      let stderr = "";
      let killed = false;

      const timer = setTimeout(() => {
        killed = true;
        try {
          process.kill(-child.pid!, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
        reject(
          new Error(
            `Restore timed out after ${RESTORE_TIMEOUT_MS / 1000}s\n\n` +
              `Output:\n${stdout.slice(-500)}`,
          ),
        );
      }, RESTORE_TIMEOUT_MS);

      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
      });

      child.on("close", (code) => {
        if (killed) return;
        clearTimeout(timer);

        if (/\[SUDO ERROR\]/i.test(`${stdout}\n${stderr}`)) {
          reject(
            new Error(
              `Sudo not configured for '${cfg.linuxUser}'. See docs/sudoers-setup.md.`,
            ),
          );
          return;
        }

        stderr = stderr
          .split("\n")
          .filter((l) => !l.includes("[sudo]") && !l.includes("password for"))
          .join("\n")
          .trim();

        resolve({ output: stdout.trim(), stderr, exitCode: code });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`Failed to start restore: ${err.message}`));
      });
    });
  }

  return { restore, hasRestoreScript: async () => (await scriptPath()) !== null };
}
