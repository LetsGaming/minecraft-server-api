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
import fsp from "fs/promises";
import path from "path";

import { runAsInstanceUser } from "../platform/spawn.js";
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

    // Shares the spawn dance with the script and mod runners; see
    // platform/spawn.ts. The path here is one the wrapper resolved, never one
    // the client described — the reason restore is not a /scripts/run action.
    return runAsInstanceUser(cfg, ["bash", script, "--file", absPath, "--y"], {
      timeoutMs: RESTORE_TIMEOUT_MS,
      label: "Restore",
    });
  }

  return { restore, hasRestoreScript: async () => (await scriptPath()) !== null };
}
