import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FakeChild } from "../helpers/fakeChild.js";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({ spawn: spawnMock }));

import { runAsInstanceUser } from "../../src/platform/spawn.js";

const target = { linuxUser: "minecraft", scriptsDir: "/srv/scripts" };
const opts = { timeoutMs: 1_000, label: "Script" };

let child: FakeChild;

beforeEach(() => {
  child = new FakeChild();
  spawnMock.mockReset();
  spawnMock.mockReturnValue(child);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("runAsInstanceUser spawn arguments", () => {
  it("runs sudo -n -u <user> with the command tokens, in the scripts dir, detached, without a shell", () => {
    void runAsInstanceUser(target, ["bash", "/srv/scripts/start.sh", "a b"], opts);
    const [bin, args, options] = spawnMock.mock.calls[0]!;
    expect(bin).toBe("sudo");
    expect(args).toEqual(["-n", "-u", "minecraft", "bash", "/srv/scripts/start.sh", "a b"]);
    expect(options.cwd).toBe("/srv/scripts");
    expect(options.detached).toBe(true);
    expect(options.shell).toBeUndefined();
    expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(options.env.HOME).toBe("/home/minecraft");
  });
});

describe("runAsInstanceUser results", () => {
  it("resolves with trimmed stdout, stderr and the exit code", async () => {
    const p = runAsInstanceUser(target, ["bash", "x"], opts);
    child.emitOut("  hello\n");
    child.emitErr("warn\n");
    child.close(3);
    await expect(p).resolves.toEqual({ output: "hello", stderr: "warn", exitCode: 3 });
  });

  it("drops sudo prompt lines from stderr", async () => {
    const p = runAsInstanceUser(target, ["bash", "x"], opts);
    child.emitErr("[sudo] password for minecraft:\nreal error\npassword for x\n");
    child.close(1);
    expect((await p).stderr).toBe("real error");
  });

  it("rejects with a sudoers hint on the [SUDO ERROR] marker", async () => {
    const p = runAsInstanceUser(target, ["bash", "x"], opts);
    child.emitErr("[SUDO ERROR] nope\n");
    child.close(1);
    await expect(p).rejects.toThrow(/Sudo not configured for 'minecraft'.*sudoers-setup/s);
  });

  it("rejects with 'Failed to start' when the spawn errors", async () => {
    const p = runAsInstanceUser(target, ["bash", "x"], { ...opts, label: "Restore" });
    child.emit("error", new Error("ENOENT"));
    await expect(p).rejects.toThrow("Failed to start restore: ENOENT");
  });

  it("caps accumulated output and appends a truncation marker", async () => {
    const p = runAsInstanceUser(target, ["bash", "x"], opts);
    const chunk = "x".repeat(1024 * 1024);
    child.emitOut(chunk);
    child.emitOut(chunk);
    child.emitOut(chunk);
    child.emitOut("dropped");
    child.close(0);
    const res = await p;
    expect(res.output).toContain("(output truncated)");
    expect(res.output).not.toContain("dropped");
  });
});

describe("runAsInstanceUser timeout", () => {
  it("rejects with the output tail and SIGTERMs the process group", async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const p = runAsInstanceUser(target, ["bash", "x"], opts);
    const assertion = expect(p).rejects.toThrow(/Script timed out after 1s[\s\S]*partial/);
    child.emitOut("partial");
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(kill).toHaveBeenCalledWith(-4242, "SIGTERM");
  });

  it("falls back to killing the child when the group kill throws", async () => {
    vi.useFakeTimers();
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    const killChild = vi.spyOn(child, "kill");
    const p = runAsInstanceUser(target, ["bash", "x"], opts);
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(killChild).toHaveBeenCalledWith("SIGTERM");
  });
});
