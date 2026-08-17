/**
 * The setup-suite shell scripts this wrapper is allowed to run, and the
 * capability probe that reports which of them exist.
 *
 * SCRIPT_MAP is the allowlist: an action not named here cannot be spawned,
 * and the manifest advertises exactly these keys.
 */
import fsp from "fs/promises";
import path from "path";

import { runAsInstanceUser } from "../platform/spawn.js";
import type { InstanceConfig } from "../config/types.js";
import type { Capabilities, ScriptResult } from "../contracts/wire.js";

/**
 * The restore script, deliberately outside SCRIPT_MAP.
 *
 * Everything in SCRIPT_MAP is reachable through POST /scripts/run, whose args
 * are validated by SAFE_ARG — which forbids "/" so a client cannot inject a
 * path. Restore needs an absolute path, so it can never come from a client
 * and gets its own route that resolves the file itself (routes/instance/
 * backups.ts). Naming it here keeps the capability probe in one place.
 */
export const RESTORE_SCRIPT = "backup/restore.sh";

export const SCRIPT_MAP: Record<string, string> = {
  start: "start.sh",
  stop: "shutdown.sh",
  restart: "smart_restart.sh",
  rollback: "rollback.sh",
  backup: "backup/backup.sh",
  status: "misc/status.sh",
};

const SCRIPT_TIMEOUTS: Record<string, number> = {
  start: 30_000,
  stop: 60_000,
  restart: 60_000,
  rollback: 300_000,
  // 600s, not 300s. A large modded world takes longer than five minutes to
  // archive, and the timeout does not just give up: it SIGTERMs the process
  // group, so the backup script dies partway through and leaves a truncated
  // archive where a good one should be. The old panel allowed ten minutes for
  // the same script; matching it is the conservative choice, not the generous
  // one.
  backup: 600_000,
  status: 15_000,
};

/** Non-blocking existsSync. Every probe here sits on the request path. */
async function exists(target: string): Promise<boolean> {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

export function createScripts(cfg: InstanceConfig) {
/**
 * M-13 (bot-side capability detection): report which setup-suite
 * artifacts exist for this instance. The response shape must stay in
 * sync with the bot's ServerCapabilities type — bots probe
 * GET /instances/:id/capabilities and fall back to assuming everything
 * is available when the route is missing (older wrappers).
 */
async function getCapabilities(): Promise<Capabilities> {
  const scriptExists = async (rel: string): Promise<boolean> =>
    !!cfg.scriptsDir && (await exists(path.join(cfg.scriptsDir, rel)));
  // Independent probes, so run them together rather than serially — this
  // is up to eight stat() calls on a disk the server may be hammering.
  const [
    start,
    stop,
    restart,
    rollback,
    backup,
    restore,
    status,
    backups,
    modManifest,
    variablesFile,
  ] = await Promise.all([
      scriptExists(SCRIPT_MAP.start!),
      scriptExists(SCRIPT_MAP.stop!),
      scriptExists(SCRIPT_MAP.restart!),
      scriptExists(SCRIPT_MAP.rollback!),
      scriptExists(SCRIPT_MAP.backup!),
      // Not in SCRIPT_MAP: restore takes a resolved path, so it is never
      // spawned through the generic /scripts/run allowlist. Probed here
      // anyway, because the dashboard needs to know whether to show the
      // button (see restore.ts).
      scriptExists(RESTORE_SCRIPT),
      scriptExists(SCRIPT_MAP.status!),
      cfg.backupsPath ? exists(cfg.backupsPath) : Promise.resolve(false),
      scriptExists(path.join("common", "downloaded_versions.json")),
      scriptExists(path.join("common", "variables.txt")),
    ]);
  return {
    scripts: { start, stop, restart, rollback, backup, status },
    backups,
    restore,
    modManifest,
    variablesFile,
  };
}

async function runScript(action: string, args?: string[]): Promise<ScriptResult> {
  const scriptRelPath = SCRIPT_MAP[action];
  if (!scriptRelPath) throw new Error(`Unknown script action: ${action}`);

  const scriptPath = path.join(cfg.scriptsDir, scriptRelPath);
  if (!(await exists(scriptPath)))
    throw new Error(`Script not found: ${scriptPath}`);

  const timeoutMs = SCRIPT_TIMEOUTS[action] ?? 120_000;

  // The spawn dance (process-group leader, group-kill timeout, sudoers
  // detection, [sudo] filtering) lives in platform/spawn.ts, shared with the
  // restore and mod runners so the security-relevant details cannot drift.
  return runAsInstanceUser(cfg, ["bash", scriptPath, ...(args ?? [])], {
    timeoutMs,
    label: "Script",
  });
}

  return { getCapabilities, runScript };
}
