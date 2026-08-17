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
        env: { ...process.env, HOME: `/home/${target.linuxUser}` },
        stdio: ["ignore", "pipe", "pipe"],
        // Process-group leader, so the timeout below can SIGTERM the whole
        // tree (the real work runs as a grandchild once sudo re-execs as the
        // instance user) rather than only the sudo parent. BUG-01/A-02.
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
          `${label} timed out after ${timeoutMs / 1000}s\n\n` +
            `Output:\n${stdout.slice(-500)}`,
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

      resolve({ output: stdout.trim(), stderr, exitCode: code });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to start ${label.toLowerCase()}: ${err.message}`));
    });
  });
}
