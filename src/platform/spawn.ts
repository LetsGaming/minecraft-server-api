/**
 * The one place a child process is spawned *as the instance's Linux user*.
 *
 * Three call sites needed the identical dance and had grown three copies of
 * it: the script runner (scripts.ts), the restore runner (restore.ts) and now
 * the mod runner (mods.ts). Each spawned `sudo -n -u <user> …` as a process
 * group leader, streamed stdout/stderr, enforced a timeout by SIGTERMing the
 * whole group, detected the sudoers-misconfiguration marker, and stripped the
 * `[sudo]` prompt lines. That is a lot of security-relevant detail to keep in
 * lockstep across three files by hand — the group-kill in particular was a
 * pointed bug fix (BUG-01/A-02) that a fourth copy would be free to get wrong.
 *
 * This module owns that dance. Callers describe *what* to run — the command
 * tokens that follow the sudo user flags — and this decides *how*: as which
 * user, with what environment, under what timeout, and how a failure reads.
 * No shell is ever involved, so a token cannot be reinterpreted as syntax;
 * every argument reaches the child exactly as passed.
 */
import { spawn } from "child_process";
import path from "path";

/** What the callers below need of the instance, and nothing more. */
export interface SudoSpawnTarget {
  linuxUser: string;
  /** cwd for the child, and the root the relative script paths resolve under. */
  scriptsDir: string;
}

export interface SudoSpawnOptions {
  timeoutMs: number;
  /**
   * The noun used in failure messages: a timeout reads "<label> timed out",
   * a spawn failure reads "Failed to start <label>". "Script", "Restore",
   * "Mod operation" — capitalised, because it opens the timeout sentence.
   */
  label: string;
}

export interface SudoSpawnResult {
  output: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * A chatty script (a verbose backup, a mod-update loop) over a timeout as
 * long as 600s would otherwise accumulate unbounded output in memory. The
 * error/timeout paths already only need the tail for the message; a script
 * that succeeds needs it in full (add-mod's --json output, for one), so this
 * caps rather than truncates outright — hitting it is itself worth knowing
 * about, hence the marker appended below.
 */
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const TRUNCATION_MARKER = "\n…(output truncated)\n";

/**
 * Environment variables the child may inherit. Everything else, notably
 * MC_API_KEY and the RCON_PASSWORD_* secrets, stays in the wrapper: a script
 * has no need for them, and sudo's env_reset is not guaranteed to be on.
 */
const ENV_ALLOWLIST = [
  "PATH",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
] as const;

/** How long a SIGTERMed process group gets to exit before SIGKILL. */
const KILL_GRACE_MS = 10_000;

/**
 * Optional absolute interpreter paths, so a sudoers grant can name exact
 * binaries instead of whatever PATH resolves to. Unset means PATH lookup.
 */
const INTERPRETER_ENV = {
  bash: "MC_BASH_PATH",
  node: "MC_NODE_PATH",
} as const;

export type Interpreter = keyof typeof INTERPRETER_ENV;

export function interpreter(name: Interpreter): string {
  return process.env[INTERPRETER_ENV[name]] || name;
}

/** Messages for interpreter overrides that are set but not absolute POSIX paths. */
export function interpreterEnvProblems(): string[] {
  const problems: string[] = [];
  for (const envName of Object.values(INTERPRETER_ENV)) {
    const value = process.env[envName];
    if (value && !path.posix.isAbsolute(value)) {
      problems.push(`${envName} must be an absolute path, got "${value}".`);
    }
  }
  return problems;
}

function childEnv(linuxUser: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: `/home/${linuxUser}` };
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Run `sudo -n -u <linuxUser> <command…>` and collect its output.
 *
 * `command` is the full argv *after* the sudo user flags — e.g.
 * `["bash", scriptPath, ...args]` or `["node", scriptPath, ...args]`. It is
 * passed to spawn() as an array, so no element is ever parsed by a shell.
 *
 * Rejects on: timeout (after SIGTERMing the process group), a detected
 * sudoers misconfiguration, or a failure to spawn at all. Resolves with the
 * child's trimmed output and exit code otherwise — a non-zero exit is data,
 * not an error, because the caller often wants to read what the script
 * printed before it failed.
 */
export function runAsInstanceUser(
  target: SudoSpawnTarget,
  command: string[],
  opts: SudoSpawnOptions,
): Promise<SudoSpawnResult> {
  const { timeoutMs, label } = opts;

  return new Promise((resolve, reject) => {
    const child = spawn(
      "sudo",
      ["-n", "-u", target.linuxUser, ...command],
      {
        cwd: target.scriptsDir,
        env: childEnv(target.linuxUser),
        stdio: ["ignore", "pipe", "pipe"],
        // Process-group leader, so the timeout below can SIGTERM the whole
        // tree (the real work runs as a grandchild once sudo re-execs as the
        // instance user) rather than only the sudo parent. BUG-01/A-02.
        detached: true,
      },
    );

    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let killed = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const signalGroup = (signal: NodeJS.Signals): void => {
      try {
        process.kill(-child.pid!, signal);
      } catch {
        child.kill(signal);
      }
    };

    const timer = setTimeout(() => {
      killed = true;
      signalGroup("SIGTERM");
      killTimer = setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
      reject(
        new Error(
          `${label} timed out after ${timeoutMs / 1000}s\n\n` +
            `Output:\n${stdout.slice(-500)}`,
        ),
      );
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length >= MAX_OUTPUT_BYTES) {
        stdoutTruncated = true;
        return;
      }
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length >= MAX_OUTPUT_BYTES) {
        stderrTruncated = true;
        return;
      }
      stderr += d.toString();
    });

    child.on("close", (code) => {
      if (killTimer) clearTimeout(killTimer);
      if (killed) return;
      clearTimeout(timer);

      if (/\[SUDO ERROR\]/i.test(`${stdout}\n${stderr}`)) {
        reject(
          new Error(
            `Sudo not configured for '${target.linuxUser}'. ` +
              `See docs/sudoers-setup.md.`,
          ),
        );
        return;
      }

      // Drop sudo's own prompt lines so they never reach a client as if the
      // script had printed them.
      stderr = stderr
        .split("\n")
        .filter((l) => !l.includes("[sudo]") && !l.includes("password for"))
        .join("\n")
        .trim();

      resolve({
        output: stdoutTruncated ? stdout.trim() + TRUNCATION_MARKER : stdout.trim(),
        stderr: stderrTruncated ? stderr + TRUNCATION_MARKER : stderr,
        exitCode: code,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(new Error(`Failed to start ${label.toLowerCase()}: ${err.message}`));
    });
  });
}

export interface JobSpawnOptions {
  timeoutMs: number;
  label: string;
  /** Called for every complete stdout line, as it arrives. */
  onLine: (line: string) => void;
}

export interface JobSpawnHandle {
  /** Resolves when the process ends; rejects on spawn failure or timeout. */
  done: Promise<{ exitCode: number | null; stderr: string }>;
  /** Ask the whole process group to stop (SIGTERM, then SIGKILL after a grace period). */
  cancel(): void;
}

/**
 * Like runAsInstanceUser, but for a long job whose progress matters while it
 * runs: stdout is handed to `onLine` line by line instead of being collected,
 * so nothing accumulates in memory and a poller sees each phase as it happens.
 * Same user, environment, process-group handling and sudoers detection.
 *
 * The child is a process-group leader of its own, so it is not tied to this
 * process: a wrapper restart does not kill an upgrade half way through.
 */
export function spawnJobAsInstanceUser(
  target: SudoSpawnTarget,
  command: string[],
  opts: JobSpawnOptions,
): JobSpawnHandle {
  let cancel: () => void = () => undefined;
  const done = new Promise<{ exitCode: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn("sudo", ["-n", "-u", target.linuxUser, ...command], {
      cwd: target.scriptsDir,
      env: childEnv(target.linuxUser),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    let pending = "";
    let stderr = "";
    let sudoError = false;
    let killed = false;

    const signalGroup = (signal: NodeJS.Signals): void => {
      try {
        process.kill(-child.pid!, signal);
      } catch {
        child.kill(signal);
      }
    };

    cancel = () => {
      signalGroup("SIGTERM");
      const kill = setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS);
      kill.unref();
    };

    const timer = setTimeout(() => {
      killed = true;
      signalGroup("SIGTERM");
      const kill = setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS);
      kill.unref();
      reject(new Error(`${opts.label} timed out after ${opts.timeoutMs / 1000}s`));
    }, opts.timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      pending += d.toString();
      let nl: number;
      while ((nl = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, nl).trim();
        pending = pending.slice(nl + 1);
        if (/\[SUDO ERROR\]/i.test(line)) sudoError = true;
        if (line) opts.onLine(line);
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += d.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) return;
      if (pending.trim()) opts.onLine(pending.trim());
      if (sudoError || /\[SUDO ERROR\]/i.test(stderr)) {
        reject(
          new Error(
            `Sudo not configured for '${target.linuxUser}'. See docs/sudoers-setup.md.`,
          ),
        );
        return;
      }
      resolve({ exitCode: code, stderr: stderr.trim() });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to start ${opts.label.toLowerCase()}: ${err.message}`));
    });
  });
  return { done, cancel: () => cancel() };
}
