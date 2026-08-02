/**
 * The setup-suite shell scripts this wrapper is allowed to run, and the
 * capability probe that reports which of them exist.
 *
 * SCRIPT_MAP is the allowlist: an action not named here cannot be spawned,
 * and the manifest advertises exactly these keys.
 */
import fsp from "fs/promises";
import path from "path";
import { spawn } from "child_process";

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

  return new Promise((resolve, reject) => {
    const child = spawn(
      "sudo",
      ["-n", "-u", cfg.linuxUser, "bash", scriptPath, ...(args ?? [])],
      {
        cwd: cfg.scriptsDir,
        env: { ...process.env, HOME: `/home/${cfg.linuxUser}` },
        stdio: ["ignore", "pipe", "pipe"],
        // BUG-01: process-group leader so the A-02 group kill below
        // (process.kill(-child.pid)) actually targets a real group.
        detached: true,
      },
    );

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      // A-02: kill the process group so the actual script (already forked
      // as LINUX_USER by sudo) also receives SIGTERM.
      try {
        process.kill(-child.pid!, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      reject(
        new Error(
          `Script timed out after ${timeoutMs / 1000}s\n\nOutput:\n${stdout.slice(-500)}`,
        ),
      );
    }, timeoutMs);

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
      reject(new Error(`Failed to start script: ${err.message}`));
    });
  });
}

  return { getCapabilities, runScript };
}
