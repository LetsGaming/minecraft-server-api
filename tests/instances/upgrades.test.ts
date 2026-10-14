import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import path from "path";

import { makeFixture, touch, type Fixture } from "../helpers/instanceFixture.js";
import {
  createUpgrades,
  parseUpgradeLine,
  PrunePlanMissingError,
  UpgradeUnavailableError,
} from "../../src/instances/upgrades.js";
import { createOperationSlot, OperationBusyError } from "../../src/instances/operationSlot.js";

let fx: Fixture;
afterEach(() => fx?.cleanup());

/** A job whose output and ending the test controls. */
function fakeSpawn() {
  const calls: string[][] = [];
  let emit: (line: string) => void = () => {};
  let finish: (code: number | null) => void = () => {};
  let fail: (err: Error) => void = () => {};
  const spawnJob = (_cfg: unknown, command: string[], opts: { onLine: (l: string) => void }) => {
    calls.push(command);
    emit = opts.onLine;
    return {
      done: new Promise<{ exitCode: number | null; stderr: string }>((resolve, reject) => {
        finish = (code) => resolve({ exitCode: code, stderr: "" });
        fail = reject;
      }),
    };
  };
  return { spawnJob, calls, line: (o: object) => emit(JSON.stringify(o)), end: (c: number | null) => finish(c), crash: (e: Error) => fail(e) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup() {
  fx = makeFixture();
  touch(path.join(fx.cfg.scriptsDir, "update", "upgrade.sh"));
  const slot = createOperationSlot();
  const spawn = fakeSpawn();
  const upgrades = createUpgrades(fx.cfg, slot, { spawnJob: spawn.spawnJob as never });
  return { slot, spawn, upgrades };
}

describe("parseUpgradeLine", () => {
  it("reads progress events and the result, and ignores everything else", () => {
    expect(parseUpgradeLine('{"seq":2,"ts":9,"phase":"backup","status":"done","msg":"x"}')).toEqual({
      event: { seq: 2, ts: 9, phase: "backup", status: "done", msg: "x" },
    });
    expect(parseUpgradeLine('{"seq":5,"ts":1,"type":"result","ok":true,"branch":"clean"}')).toEqual({
      result: { ok: true, branch: "clean" },
    });
    expect(parseUpgradeLine("not json")).toBeNull();
    expect(parseUpgradeLine('{"hello":1}')).toBeNull();
    expect(parseUpgradeLine("[1]")).toBeNull();
  });
});

describe("starting an upgrade", () => {
  it("runs upgrade.sh with the version and the user's expectations", async () => {
    const { spawn, upgrades } = setup();
    const { jobId } = await upgrades.startUpgrade({
      mcVersion: "1.21.5",
      expectUnavailable: ["sodium", "lithium"],
      countdownSeconds: 45,
    });
    expect(jobId).toMatch(/^[a-f0-9-]{36}$/);
    const [, script, ...args] = spawn.calls[0]!;
    expect(script).toBe(path.join(fx.cfg.scriptsDir, "update", "upgrade.sh"));
    expect(args).toEqual(["1.21.5", "--expect-unavailable=sodium,lithium", "--countdown=45"]);
  });

  it("clamps an oversized countdown", async () => {
    const { spawn, upgrades } = setup();
    await upgrades.startUpgrade({ mcVersion: "1.21.5", countdownSeconds: 99_999 });
    expect(spawn.calls[0]!.at(-1)).toBe("--countdown=600");
  });

  it("is unavailable when the suite has no upgrade script", async () => {
    fx = makeFixture();
    const upgrades = createUpgrades(fx.cfg, createOperationSlot());
    await expect(upgrades.startUpgrade({ mcVersion: "1.21.5" })).rejects.toBeInstanceOf(UpgradeUnavailableError);
    expect(await upgrades.hasUpgradeScript()).toBe(false);
  });

  it("refuses while another operation holds the instance, and says what", async () => {
    const { slot, upgrades } = setup();
    slot.begin("backup");
    await expect(upgrades.startUpgrade({ mcVersion: "1.21.5" })).rejects.toMatchObject({
      busy: { kind: "backup" },
    });
    await expect(upgrades.startUpgrade({ mcVersion: "1.21.5" })).rejects.toBeInstanceOf(OperationBusyError);
  });

  it("refuses a prune plan whose file is gone, before taking the slot", async () => {
    const { slot, spawn, upgrades } = setup();
    const planId = "0123456789abcdef";
    await expect(upgrades.startUpgrade({ pruneOnly: true, prunePlan: planId })).rejects.toBeInstanceOf(PrunePlanMissingError);
    expect(slot.current()).toBeNull();
    expect(spawn.calls).toHaveLength(0);
    touch(path.join(fx.cfg.scriptsDir, "common", "prune", `${planId}.plan.json`));
    await expect(upgrades.startUpgrade({ pruneOnly: true, prunePlan: planId })).resolves.toHaveProperty("jobId");
  });

  it("holds the slot while it runs and frees it when it ends", async () => {
    const { slot, spawn, upgrades } = setup();
    const { jobId } = await upgrades.startUpgrade({ mcVersion: "1.21.5" });
    expect(slot.current()).toEqual({ kind: "upgrade", jobId });
    spawn.end(0);
    await flush();
    expect(slot.current()).toBeNull();
  });
});

describe("following an upgrade", () => {
  it("returns progress after a cursor and the result at the end", async () => {
    const { spawn, upgrades } = setup();
    const { jobId } = await upgrades.startUpgrade({ mcVersion: "1.21.5" });
    spawn.line({ seq: 1, ts: 1, phase: "plan", status: "done", msg: "a" });
    spawn.line({ seq: 2, ts: 2, phase: "stop", status: "running", msg: "b" });

    const first = upgrades.getUpgrade(jobId, 0)!;
    expect(first.state).toBe("running");
    expect(first.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(first.next).toBe(2);

    spawn.line({ seq: 3, ts: 3, type: "result", ok: true, branch: "clean", target: "1.21.5" });
    spawn.end(0);
    await flush();

    const next = upgrades.getUpgrade(jobId, first.next)!;
    expect(next.state).toBe("done");
    expect(next.events).toEqual([]);
    expect(next.result).toMatchObject({ ok: true, branch: "clean" });
  });

  it("marks a non-zero exit as failed and keeps the script's own result", async () => {
    const { spawn, upgrades } = setup();
    const { jobId } = await upgrades.startUpgrade({ mcVersion: "1.21.5" });
    spawn.line({ seq: 1, ts: 1, type: "result", ok: false, rolledBack: true, reason: "crash_loop" });
    spawn.end(1);
    await flush();
    const job = upgrades.getUpgrade(jobId)!;
    expect(job.state).toBe("failed");
    expect(job.result).toMatchObject({ rolledBack: true, reason: "crash_loop" });
    expect(job.error).toBeUndefined();
  });

  it("reports a lock refusal (exit 75) as busy", async () => {
    const { spawn, upgrades } = setup();
    const { jobId } = await upgrades.startUpgrade({ mcVersion: "1.21.5" });
    spawn.end(75);
    await flush();
    expect(upgrades.getUpgrade(jobId)).toMatchObject({ state: "failed", error: "busy" });
  });

  it("fails the job and frees the slot when the process cannot run", async () => {
    const { slot, spawn, upgrades } = setup();
    const { jobId } = await upgrades.startUpgrade({ mcVersion: "1.21.5" });
    spawn.crash(new Error("Sudo not configured for 'minecraft'"));
    await flush();
    expect(upgrades.getUpgrade(jobId)?.state).toBe("failed");
    expect(slot.current()).toBeNull();
  });

  it("does not leak script error text to the client", async () => {
    const { spawn, upgrades } = setup();
    const { jobId } = await upgrades.startUpgrade({ mcVersion: "1.21.5" });
    spawn.crash(new Error("/home/mc/secret/path failed"));
    await flush();
    expect(JSON.stringify(upgrades.getUpgrade(jobId))).not.toContain("secret");
  });

  it("knows nothing about an id it never saw", () => {
    const { upgrades } = setup();
    expect(upgrades.getUpgrade("00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});

describe("after a wrapper restart", () => {
  const status = (lines: object[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

  it("reads a finished job from the script's status file", async () => {
    const { upgrades } = setup();
    touch(
      path.join(fx.cfg.scriptsDir, "common", "upgrade-status.ndjson"),
      status([
        { seq: 1, ts: 1, phase: "plan", status: "done", msg: "x" },
        { seq: 2, ts: 2, type: "result", ok: true, branch: "clean" },
      ]),
    );
    const job = await upgrades.getCurrentUpgrade(0);
    expect(job).toMatchObject({ jobId: "recovered", state: "done" });
    expect(job?.events).toHaveLength(1);
  });

  it("calls a status file with no result and no running slot interrupted", async () => {
    const { upgrades } = setup();
    touch(
      path.join(fx.cfg.scriptsDir, "common", "upgrade-status.ndjson"),
      status([{ seq: 1, ts: 1, phase: "stop", status: "running", msg: "x" }]),
    );
    expect(await upgrades.getCurrentUpgrade(0)).toMatchObject({ state: "failed", error: "interrupted" });
  });

  it("answers null when there has been no upgrade", async () => {
    const { upgrades } = setup();
    expect(await upgrades.getCurrentUpgrade(0)).toBeNull();
  });
});

describe("a job that outlives the wrapper (W-009)", () => {
  function recordFixture(alive: () => boolean) {
    fx = makeFixture();
    touch(path.join(fx.cfg.scriptsDir, "update", "upgrade.sh"));
    const recordDir = path.join(fx.root, "jobs");
    fs.mkdirSync(recordDir, { recursive: true });
    const outFile = path.join(recordDir, "upgrade-1.out");
    fs.writeFileSync(outFile, "");
    fs.writeFileSync(
      path.join(recordDir, `${fx.cfg.id}.upgrade.json`),
      JSON.stringify({ pgid: 999_999, jobId: "11111111-2222-4333-8444-555555555555", kind: "upgrade", mcVersion: "1.21.4", startedAt: 1, files: [outFile] }),
    );
    fs.mkdirSync(path.join(fx.cfg.scriptsDir, "common"), { recursive: true });
    fs.writeFileSync(
      path.join(fx.cfg.scriptsDir, "common", "upgrade-status.ndjson"),
      '{"seq":1,"ts":1,"phase":"backup","status":"running","msg":""}\n',
    );
    const slot = createOperationSlot();
    const upgrades = createUpgrades(fx.cfg, slot, {
      spawnJob: fakeSpawn().spawnJob as never,
      recordDir,
      isAlive: alive,
      recoveryPollMs: 10,
    });
    return { slot, upgrades, recordDir, outFile };
  }

  it("keeps the slot for a recorded job that still runs, and reports it running", async () => {
    let alive = true;
    const { slot, upgrades, recordDir, outFile } = recordFixture(() => alive);
    expect(slot.current()).toEqual({ kind: "upgrade", jobId: "11111111-2222-4333-8444-555555555555" });
    expect(await upgrades.getCurrentUpgrade()).toMatchObject({
      jobId: "11111111-2222-4333-8444-555555555555",
      state: "running",
      mcVersion: "1.21.4",
    });

    alive = false;
    await new Promise((r) => setTimeout(r, 50));
    expect(slot.current()).toBeNull();
    expect(fs.existsSync(path.join(recordDir, `${fx.cfg.id}.upgrade.json`))).toBe(false);
    expect(fs.existsSync(outFile)).toBe(false);
    expect(await upgrades.getCurrentUpgrade()).toMatchObject({ state: "failed", error: "interrupted" });
  });

  it("drops the record of a job that is gone", () => {
    const { slot, recordDir } = recordFixture(() => false);
    expect(slot.current()).toBeNull();
    expect(fs.existsSync(path.join(recordDir, `${fx.cfg.id}.upgrade.json`))).toBe(false);
  });
});
