import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import path from "path";

import { makeFixture, touch, type Fixture } from "../helpers/instanceFixture.js";
import {
  createPrune,
  PruneBusyError,
  PruneScriptError,
  PruneUnavailableError,
  PRUNE_MAP_MAX_BYTES,
} from "../../src/instances/prune.js";
import { PRUNE_SCRIPT } from "../../src/instances/scripts.js";

let fx: Fixture;
afterEach(() => fx?.cleanup());

const SUMMARY = {
  ok: true,
  id: "0123456789abcdef",
  createdAt: "2026-10-12T00:00:00.000Z",
  params: { thresholdMinutes: 5, spawnRadiusChunks: 16, playerRadiusChunks: 8, bufferChunks: 2, zones: [], dimensions: null },
  warnings: [],
  totals: { chunks: 10, delete: 4, regions: 1, regionsEmptied: 0, bytes: 8192 },
  dimensions: [],
};

function fakeSpawn() {
  let cancelled = 0;
  const calls: string[][] = [];
  const inputs: Array<string | undefined> = [];
  let emit: (line: string) => void = () => {};
  let finish: (code: number | null) => void = () => {};
  let fail: (e: Error) => void = () => {};
  const spawnJob = (_cfg: unknown, command: string[], opts: { onLine: (l: string) => void; input?: string }) => {
    calls.push(command);
    inputs.push(opts.input);
    emit = opts.onLine;
    return {
      done: new Promise<{ exitCode: number | null; stderr: string }>((resolve, reject) => {
        finish = (c) => resolve({ exitCode: c, stderr: "" });
        fail = reject;
      }),
      cancel: () => {
        cancelled++;
        finish(null);
      },
    };
  };
  return { spawnJob, calls, inputs, cancelCount: () => cancelled, line: (o: object) => emit(JSON.stringify(o)), end: (c: number | null) => finish(c), crash: (e: Error) => fail(e) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(withScript = true) {
  fx = makeFixture();
  if (withScript) touch(path.join(fx.cfg.scriptsDir, PRUNE_SCRIPT));
  const spawn = fakeSpawn();
  const runCalls: string[][] = [];
  const runInputs: Array<string | undefined> = [];
  let runOutput = JSON.stringify({ ok: true, params: SUMMARY.params });
  const run = async (_cfg: unknown, command: string[], opts: { input?: string }) => {
    runCalls.push(command);
    runInputs.push(opts?.input);
    return { output: runOutput, stderr: "", exitCode: 0 };
  };
  const prune = createPrune(fx.cfg, { spawnJob: spawn.spawnJob as never, run: run as never });
  return { prune, spawn, runCalls, runInputs, setRunOutput: (o: string) => (runOutput = o) };
}

describe("scan progress, cancel, dimensions and status", () => {
  it("reports the latest progress line while a scan runs", async () => {
    const { prune, spawn } = setup();
    const { jobId } = await prune.startPruneScan();
    spawn.line({ phase: "scan", done: 3, total: 10, chunks: 3000, chunksPerSecond: 900, etaSeconds: 8 });
    spawn.line({ phase: "scan", done: 5, total: 10, chunks: 5000, chunksPerSecond: 950, etaSeconds: 5 });
    spawn.line({ phase: "scan", done: "x", total: 10 });
    expect(prune.getPruneScan(jobId)).toMatchObject({
      state: "running",
      progress: { done: 5, total: 10, chunks: 5000, chunksPerSecond: 950, etaSeconds: 5 },
    });
  });

  it("cancels a running scan, which then reports cancelled", async () => {
    const { prune, spawn } = setup();
    const { jobId } = await prune.startPruneScan();
    expect(prune.cancelPruneScan(jobId)).toBe(true);
    await flush();
    expect(spawn.cancelCount()).toBe(1);
    expect(prune.getPruneScan(jobId)).toMatchObject({ state: "failed", error: "cancelled" });
    expect(prune.cancelPruneScan(jobId)).toBe(false);
    expect(prune.cancelPruneScan("nope")).toBe(false);
  });

  it("lists the dimensions and drops malformed entries", async () => {
    const { prune, setRunOutput, runCalls } = setup();
    setRunOutput(JSON.stringify({ ok: true, dimensions: [{ id: "overworld", regions: 3 }, { id: 5 }, "x"] }));
    expect(await prune.getPruneDimensions()).toEqual({ dimensions: [{ id: "overworld", regions: 3 }] });
    expect(runCalls[0]).toContain("--dimensions");
  });

  it("inspects one chunk of a plan through the script", async () => {
    const { prune, setRunOutput, runCalls } = setup();
    setRunOutput(JSON.stringify({ ok: true, chunk: { dimension: "overworld", cx: -3, cz: 4, rx: -1, rz: 0, slot: 133 }, thresholdMinutes: 5, present: true, readable: true, plannedForDeletion: true }));
    const info = await prune.inspectPruneChunk("0123456789abcdef", "overworld", -3, 4);
    expect(info).toMatchObject({ present: true, plannedForDeletion: true });
    expect(runCalls[0]).toEqual(expect.arrayContaining(["--inspect", "--plan=0123456789abcdef", "--dimension=overworld", "--cx=-3", "--cz=4"]));
    setRunOutput(JSON.stringify({ ok: false, code: "plan_missing" }));
    expect(await prune.inspectPruneChunk("0123456789abcdef", "overworld", 0, 0)).toBeNull();
  });

  it("reads a tile the script drew, and names it by its file", async () => {
    const { prune, setRunOutput, runCalls } = setup();
    const rel = "overworld/r.-1.2.0123456789abcdef.png";
    const dir = path.join(fx.cfg.scriptsDir, "common", "prune", "tiles", "overworld");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "r.-1.2.0123456789abcdef.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    setRunOutput(JSON.stringify({ ok: true, tile: rel, cached: false, chunks: 3, bytes: 4 }));
    const tile = await prune.readPruneTile("overworld", -1, 2);
    expect([...tile!.png]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(tile!.etag).toBe('"r.-1.2.0123456789abcdef"');
    expect(runCalls[0]).toEqual(expect.arrayContaining(["--tile", "--dimension=overworld", "--rx=-1", "--rz=2"]));
  });

  it("answers null for a region that does not exist, and refuses a tile path that leaves the tiles folder", async () => {
    const { prune, setRunOutput } = setup();
    setRunOutput(JSON.stringify({ ok: false, code: "no_region" }));
    expect(await prune.readPruneTile("overworld", 9, 9)).toBeNull();
    setRunOutput(JSON.stringify({ ok: true, tile: "../../variables.txt" }));
    await expect(prune.readPruneTile("overworld", 0, 0)).rejects.toBeInstanceOf(PruneScriptError);
  });

  it("draws at most two tiles at once and lets the rest wait", async () => {
    fx = makeFixture();
    touch(path.join(fx.cfg.scriptsDir, PRUNE_SCRIPT));
    let running = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const run = async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => release.push(resolve));
      running--;
      return { output: JSON.stringify({ ok: false, code: "no_region" }), stderr: "", exitCode: 0 };
    };
    const prune = createPrune(fx.cfg, { run: run as never });
    const all = Promise.all([0, 1, 2, 3, 4].map((i) => prune.readPruneTile("overworld", i, 0)));
    await flush();
    expect(peak).toBe(2);
    while (release.length > 0 || running > 0) {
      release.shift()?.();
      await flush();
    }
    await all;
    expect(peak).toBe(2);
  });

  it("reports an unfinished delete from the status", async () => {
    const { prune, setRunOutput } = setup();
    setRunOutput(JSON.stringify({ ok: true, engine: "builtin", version: 1, unfinishedApply: { state: "applying", plan: "0123456789abcdef", startedAt: "2026-10-13T10:00:00Z", pid: 4 } }));
    expect(await prune.getPruneStatus()).toEqual({
      engine: "builtin",
      version: 1,
      unfinishedApply: { state: "applying", plan: "0123456789abcdef", startedAt: "2026-10-13T10:00:00Z" },
    });
    setRunOutput(JSON.stringify({ ok: true, engine: "builtin", version: 1 }));
    expect(await prune.getPruneStatus()).toEqual({ engine: "builtin", version: 1 });
  });
});

describe("a prune scan", () => {
  it("runs the script with the parameters and ends with the summary", async () => {
    const { prune, spawn } = setup();
    const { jobId } = await prune.startPruneScan({ ...SUMMARY.params, thresholdMinutes: 12 });
    const [, script, scan, flag] = spawn.calls[0]!;
    expect(script).toBe(path.join(fx.cfg.scriptsDir, PRUNE_SCRIPT));
    expect(scan).toBe("--scan");
    // Parameters travel on stdin: a manual selection can outgrow one argument.
    expect(flag).toBe("--params-stdin");
    expect(JSON.parse(spawn.inputs[0]!).thresholdMinutes).toBe(12);

    expect(prune.getPruneScan(jobId)).toMatchObject({ state: "running" });
    spawn.line(SUMMARY);
    spawn.end(0);
    await flush();
    expect(prune.getPruneScan(jobId)).toMatchObject({ state: "done", result: { id: SUMMARY.id } });
  });

  it("uses the saved settings when no parameters are given", async () => {
    const { prune, spawn } = setup();
    await prune.startPruneScan();
    expect(spawn.calls[0]).not.toContainEqual(expect.stringContaining("--params"));
    expect(spawn.inputs[0]).toBeUndefined();
  });

  it("allows one scan at a time", async () => {
    const { prune } = setup();
    await prune.startPruneScan();
    await expect(prune.startPruneScan()).rejects.toBeInstanceOf(PruneBusyError);
  });

  it("allows another after the first ends", async () => {
    const { prune, spawn } = setup();
    await prune.startPruneScan();
    spawn.end(1);
    await flush();
    await expect(prune.startPruneScan()).resolves.toBeDefined();
  });

  it("reports only fixed reason codes when it fails", async () => {
    const { prune, spawn } = setup();
    const { jobId } = await prune.startPruneScan();
    spawn.line({ ok: false, code: "scan_failed", error: "/home/mc/secret exploded" });
    spawn.end(1);
    await flush();
    const job = prune.getPruneScan(jobId)!;
    expect(job).toMatchObject({ state: "failed", error: "scan_failed" });
    expect(JSON.stringify(job)).not.toContain("secret");
  });

  it("maps an unknown code and a crash to a generic one", async () => {
    const a = setup();
    const first = await a.prune.startPruneScan();
    a.spawn.line({ ok: false, code: "../../etc", error: "x" });
    a.spawn.end(1);
    await flush();
    expect(a.prune.getPruneScan(first.jobId)?.error).toBe("failed");

    const b = setup();
    const second = await b.prune.startPruneScan();
    b.spawn.crash(new Error("Sudo not configured"));
    await flush();
    expect(b.prune.getPruneScan(second.jobId)).toMatchObject({ state: "failed", error: "failed" });
  });

  it("is unavailable without the script", async () => {
    const { prune } = setup(false);
    await expect(prune.startPruneScan()).rejects.toBeInstanceOf(PruneUnavailableError);
    expect(await prune.hasPruneScript()).toBe(false);
  });

  it("forgets all but the newest finished scans", async () => {
    const { prune, spawn } = setup();
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      ids.push((await prune.startPruneScan()).jobId);
      spawn.end(1);
      await flush();
    }
    expect(prune.getPruneScan(ids[0]!)).toBeNull();
    expect(prune.getPruneScan(ids[7]!)).not.toBeNull();
  });
});

describe("settings", () => {
  it("reads and writes through the script", async () => {
    const { prune, runCalls } = setup();
    expect((await prune.getPruneSettings()).thresholdMinutes).toBe(5);
    await prune.setPruneSettings({ ...SUMMARY.params, thresholdMinutes: 9 });
    expect(runCalls[0]).toContain("--settings=get");
    expect(runCalls[1]![2]).toBe("--settings=set");
    expect(JSON.parse(runCalls[1]![3]!.replace("--params=", "")).thresholdMinutes).toBe(9);
  });

  it("sends a large selection on stdin instead of an argument (W-016)", async () => {
    const { prune, runCalls, runInputs } = setup();
    const big = { ...SUMMARY.params, manual: Array.from({ length: 2500 }, (_, i) => ({ op: "add", x1: i, z1: i, x2: i + 99, z2: i + 99, dimension: "minecraft:overworld" })) };
    await prune.setPruneSettings(big as never);
    expect(runCalls[0]!.slice(2)).toEqual(["--settings=set", "--params-stdin"]);
    expect(JSON.parse(runInputs[0]!).manual).toHaveLength(2500);
  });

  it("turns a script failure into a fixed code", async () => {
    const { prune, setRunOutput } = setup();
    setRunOutput(JSON.stringify({ ok: false, code: "params", error: "bad" }));
    await expect(prune.getPruneSettings()).rejects.toMatchObject({ code: "params" });
    setRunOutput("garbage");
    await expect(prune.getPruneSettings()).rejects.toBeInstanceOf(PruneScriptError);
  });
});

describe("plan maps", () => {
  const dir = () => path.join(fx.cfg.scriptsDir, "common", "prune");

  it("returns the stored text of one dimension", async () => {
    const { prune } = setup();
    touch(path.join(dir(), `${SUMMARY.id}.map.0.json`), '{"dimension":"overworld","regions":{}}');
    expect(await prune.readPruneMap(SUMMARY.id, 0)).toBe('{"dimension":"overworld","regions":{}}');
  });

  it("is null for a plan or dimension that is not there", async () => {
    const { prune } = setup();
    expect(await prune.readPruneMap(SUMMARY.id, 3)).toBeNull();
  });

  it("refuses to relay a map past the size cap", async () => {
    const { prune } = setup();
    const file = path.join(dir(), `${SUMMARY.id}.map.0.json`);
    fs.mkdirSync(dir(), { recursive: true });
    const fd = fs.openSync(file, "w");
    fs.ftruncateSync(fd, PRUNE_MAP_MAX_BYTES + 1);
    fs.closeSync(fd);
    await expect(prune.readPruneMap(SUMMARY.id, 0)).rejects.toBeInstanceOf(PruneScriptError);
  });
});
