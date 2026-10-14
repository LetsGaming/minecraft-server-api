/**
 * W-009: a job's output goes through files, not pipes, so the job does not
 * die of SIGPIPE when the wrapper exits under it. Runs a real `sudo` as the
 * current user where that works without a password, and skips otherwise.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { spawnJobAsInstanceUser, processGroupAlive } from "../../src/platform/spawn.js";

const user = os.userInfo().username;
function sudoWorks(): boolean {
  try {
    execFileSync("sudo", ["-n", "-u", user, "true"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-"));
beforeAll(() => {
  process.env.MC_STATE_DIR = stateDir;
});
afterAll(() => {
  delete process.env.MC_STATE_DIR;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe.skipIf(!sudoWorks())("spawnJobAsInstanceUser (W-009)", () => {
  it("streams lines from its output file, then removes the files", async () => {
    const lines: string[] = [];
    const handle = spawnJobAsInstanceUser(
      { linuxUser: user, scriptsDir: os.tmpdir() },
      ["bash", "-c", 'echo one; sleep 0.4; echo two; echo err >&2; printf three'],
      { timeoutMs: 10_000, label: "Test job", onLine: (l) => lines.push(l) },
    );
    expect(handle.pid).toBeGreaterThan(0);
    const { exitCode, stderr } = await handle.done;
    expect(exitCode).toBe(0);
    expect(stderr).toBe("err");
    expect(lines).toEqual(["one", "two", "three"]);
    for (const f of handle.outputFiles!) expect(fs.existsSync(f)).toBe(false);
  });

  it("does not hand the job a pipe it could die on", async () => {
    const seen: string[] = [];
    const handle = spawnJobAsInstanceUser(
      { linuxUser: user, scriptsDir: os.tmpdir() },
      ["bash", "-c", "readlink /proc/$$/fd/1"],
      { timeoutMs: 10_000, label: "Test job", onLine: (l) => seen.push(l) },
    );
    await handle.done;
    expect(seen[0]).toMatch(/\.out$/);
  });

  it("reports whether a process group is still alive", async () => {
    const handle = spawnJobAsInstanceUser(
      { linuxUser: user, scriptsDir: os.tmpdir() },
      ["bash", "-c", "sleep 0.3"],
      { timeoutMs: 10_000, label: "Test job", onLine: () => {} },
    );
    expect(processGroupAlive(handle.pid!)).toBe(true);
    await handle.done;
    expect(processGroupAlive(handle.pid!)).toBe(false);
  });
});
