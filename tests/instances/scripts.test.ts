import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import type * as SpawnModule from "../../src/platform/spawn.js";

import { makeFixture, touch, type Fixture } from "../helpers/instanceFixture.js";

const runMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/platform/spawn.js", async (orig) => ({
  ...(await orig<typeof SpawnModule>()),
  runAsInstanceUser: runMock,
}));

import { createScripts, SCRIPT_MAP, RESTORE_SCRIPT } from "../../src/instances/scripts.js";

let fx: Fixture;

beforeEach(() => {
  fx = makeFixture();
  runMock.mockReset();
  runMock.mockResolvedValue({ output: "", stderr: "", exitCode: 0 });
});

afterEach(() => fx.cleanup());

describe("runScript", () => {
  it("rejects an action outside the allowlist", async () => {
    await expect(createScripts(fx.cfg).runScript("restore")).rejects.toThrow(/Unknown script action/);
    await expect(createScripts(fx.cfg).runScript("../x")).rejects.toThrow(/Unknown script action/);
  });

  it("rejects when the script file is missing", async () => {
    await expect(createScripts(fx.cfg).runScript("start")).rejects.toThrow(/Script not found/);
  });

  it("runs bash on the resolved path with the client args", async () => {
    touch(path.join(fx.cfg.scriptsDir, "start.sh"));
    await createScripts(fx.cfg).runScript("start", ["--x"]);
    const [target, command, options] = runMock.mock.calls[0]!;
    expect(target).toBe(fx.cfg);
    expect(command).toEqual(["bash", path.join(fx.cfg.scriptsDir, "start.sh"), "--x"]);
    expect(options.label).toBe("Script");
  });

  it("keeps the restore script out of the generic allowlist", () => {
    expect(Object.values(SCRIPT_MAP)).not.toContain(RESTORE_SCRIPT);
  });

  it("assigns the per-action timeouts", async () => {
    for (const rel of Object.values(SCRIPT_MAP)) touch(path.join(fx.cfg.scriptsDir, rel));
    const scripts = createScripts(fx.cfg);
    const timeouts: Record<string, number> = {};
    for (const action of Object.keys(SCRIPT_MAP)) {
      await scripts.runScript(action);
      timeouts[action] = runMock.mock.calls.at(-1)![2].timeoutMs;
    }
    expect(timeouts.stop).toBe(240_000);
    expect(timeouts.restart).toBe(420_000);
    expect(timeouts.backup).toBe(600_000);
    expect(timeouts.rollback).toBe(300_000);
    expect(timeouts.status).toBe(15_000);
    expect(timeouts.start).toBe(30_000);
  });
});

describe("getCapabilities", () => {
  it("reports which artifacts exist", async () => {
    touch(path.join(fx.cfg.scriptsDir, "start.sh"));
    touch(path.join(fx.cfg.scriptsDir, "backup/backup.sh"));
    touch(path.join(fx.cfg.scriptsDir, "common/variables.txt"));
    const caps = await createScripts(fx.cfg).getCapabilities();
    expect(caps.scripts).toEqual({
      start: true,
      stop: false,
      restart: false,
      rollback: false,
      backup: true,
      status: false,
    });
    expect(caps.restore).toBe(false);
    expect(caps.variablesFile).toBe(true);
    expect(caps.modManifest).toBe(false);
    expect(caps.backups).toBe(false);
  });
});

describe("the instance slot", () => {
  it("refuses a second mutating action while one is running, but not a status read", async () => {
    const { createOperationSlot, OperationBusyError } = await import("../../src/instances/operationSlot.js");
    for (const rel of Object.values(SCRIPT_MAP)) touch(path.join(fx.cfg.scriptsDir, rel));
    const slot = createOperationSlot();
    const scripts = createScripts(fx.cfg, slot);

    let finish: (v: unknown) => void = () => {};
    runMock.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const running = scripts.runScript("backup");

    await expect(scripts.runScript("stop")).rejects.toBeInstanceOf(OperationBusyError);
    await expect(scripts.runScript("status")).resolves.toBeDefined();

    finish({ output: "", stderr: "", exitCode: 0 });
    await running;
    await expect(scripts.runScript("stop")).resolves.toBeDefined();
  });
});
