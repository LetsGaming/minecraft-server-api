/**
 * The prune routes: input validation, the status mapping of the instance's
 * errors, the map passed through as text, and the prune-only job it starts.
 * The instance bundle is stubbed; the logic is in tests/instances/prune.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";

import { registerPruneRoutes, parsePruneParams } from "../../src/http/routes/instance/prune.js";
import type { InstanceEntry } from "../../src/http/routes/instance/shared.js";
import { PruneBusyError, PruneScriptError, PruneUnavailableError } from "../../src/instances/prune.js";
import { OperationBusyError } from "../../src/instances/operationSlot.js";
import { PrunePlanMissingError } from "../../src/instances/upgrades.js";

const JOB = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const PLAN = "0123456789abcdef";
const PARAMS = { thresholdMinutes: 5, spawnRadiusChunks: 16, playerRadiusChunks: 8, bufferChunks: 2, zones: [], dimensions: null };

function build(overrides: Record<string, unknown> = {}) {
  const entry = {
    getPruneSettings: vi.fn(async () => PARAMS),
    setPruneSettings: vi.fn(async (p: unknown) => ({ ...PARAMS, ...(p as object) })),
    startPruneScan: vi.fn(async () => ({ jobId: JOB })),
    getPruneScan: vi.fn(() => ({ jobId: JOB, state: "running" })),
    getPruneDimensions: vi.fn(async () => ({ dimensions: [{ id: "overworld", regions: 4 }] })),
    getPruneStatus: vi.fn(async () => ({ engine: "builtin", version: 1 })),
    cancelPruneScan: vi.fn(() => true),
    readPruneMap: vi.fn(async () => '{"dimension":"overworld","regions":{"r.0.0":{"cell":"AA==","heat":"AA=="}}}'),
    startUpgrade: vi.fn(async () => ({ jobId: JOB })),
    ...overrides,
  };
  const app = Fastify();
  registerPruneRoutes(app, ((id: string, reply: { status: (n: number) => { send: (b: unknown) => unknown } }) => {
    if (id !== "survival") {
      void reply.status(404).send({ error: "Instance not found" });
      return null;
    }
    return entry as unknown as InstanceEntry;
  }) as never);
  return { app, entry };
}

const url = (p: string) => `/instances/survival${p}`;

describe("parsePruneParams", () => {
  it("accepts a partial, well-formed body", () => {
    expect(parsePruneParams({ thresholdMinutes: 10 })).toEqual({ thresholdMinutes: 10 });
    expect(parsePruneParams({})).toEqual({});
    expect(parsePruneParams({ dimensions: null })).toEqual({ dimensions: null });
  });

  it.each([
    "text",
    [],
    { thresholdMinutes: "5" },
    { thresholdMinutes: -1 },
    { bufferChunks: Infinity },
    { zones: "x" },
    { zones: [{ dimension: "Over World", x1: 0, z1: 0, x2: 1, z2: 1 }] },
    { zones: [{ dimension: "overworld", x1: 0.5, z1: 0, x2: 1, z2: 1 }] },
    { zones: [{ dimension: "overworld", x1: 0, z1: 0, x2: 9e9, z2: 1 }] },
    { zones: new Array(101).fill({ dimension: "overworld", x1: 0, z1: 0, x2: 1, z2: 1 }) },
    { dimensions: ["../x"] },
    { dimensions: "overworld" },
  ])("refuses %j", (body) => {
    expect(parsePruneParams(body)).toBeNull();
  });

  it("trims a zone name and keeps only known fields", () => {
    const out = parsePruneParams({ zones: [{ name: "b".repeat(100), dimension: "overworld", x1: 1, z1: 2, x2: 3, z2: 4, evil: true }] });
    expect(out?.zones?.[0]).toEqual({ name: "b".repeat(64), dimension: "overworld", x1: 1, z1: 2, x2: 3, z2: 4 });
  });
});

describe("settings", () => {
  it("reads and saves", async () => {
    const { app, entry } = build();
    expect((await app.inject({ url: url("/prune/settings") })).json()).toEqual(PARAMS);
    const put = await app.inject({ method: "PUT", url: url("/prune/settings"), payload: { thresholdMinutes: 9 } });
    expect(put.statusCode).toBe(200);
    expect(entry.setPruneSettings).toHaveBeenCalledWith({ thresholdMinutes: 9 });
  });

  it("400s a bad body and 501s without the script", async () => {
    const { app, entry } = build();
    expect((await app.inject({ method: "PUT", url: url("/prune/settings"), payload: { thresholdMinutes: "x" } })).statusCode).toBe(400);
    expect(entry.setPruneSettings).not.toHaveBeenCalled();
    const none = build({ getPruneSettings: vi.fn(async () => { throw new PruneUnavailableError(); }) });
    expect((await none.app.inject({ url: url("/prune/settings") })).statusCode).toBe(501);
  });
});

describe("scans", () => {
  it("starts one with or without parameters", async () => {
    const { app, entry } = build();
    expect((await app.inject({ method: "POST", url: url("/prune/scans"), payload: { bufferChunks: 1 } })).statusCode).toBe(202);
    expect(entry.startPruneScan).toHaveBeenLastCalledWith({ bufferChunks: 1 });
    await app.inject({ method: "POST", url: url("/prune/scans") });
    expect(entry.startPruneScan).toHaveBeenLastCalledWith(undefined);
  });

  it("400s bad parameters, 429s a second scan, 501s without the script", async () => {
    const { app, entry } = build();
    expect((await app.inject({ method: "POST", url: url("/prune/scans"), payload: { zones: 5 } })).statusCode).toBe(400);
    expect(entry.startPruneScan).not.toHaveBeenCalled();
    const busy = build({ startPruneScan: vi.fn(async () => { throw new PruneBusyError(); }) });
    expect((await busy.app.inject({ method: "POST", url: url("/prune/scans") })).statusCode).toBe(429);
    const none = build({ startPruneScan: vi.fn(async () => { throw new PruneUnavailableError(); }) });
    expect((await none.app.inject({ method: "POST", url: url("/prune/scans") })).statusCode).toBe(501);
  });

  it("polls, and 404s or 400s an unknown or malformed id", async () => {
    const { app } = build();
    expect((await app.inject({ url: url(`/prune/scans/${JOB}`) })).json()).toMatchObject({ state: "running" });
    expect((await app.inject({ url: url("/prune/scans/nope") })).statusCode).toBe(400);
    const gone = build({ getPruneScan: vi.fn(() => null) });
    expect((await gone.app.inject({ url: url(`/prune/scans/${JOB}`) })).statusCode).toBe(404);
  });
});

describe("maps", () => {
  it("passes the stored JSON through untouched", async () => {
    const { app, entry } = build();
    const res = await app.inject({ url: url(`/prune/plans/${PLAN}/map/0`) });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.json().dimension).toBe("overworld");
    expect(entry.readPruneMap).toHaveBeenCalledWith(PLAN, 0);
  });

  it("validates ids and answers 404 and 500 for the rest", async () => {
    const { app } = build();
    expect((await app.inject({ url: url("/prune/plans/zz/map/0") })).statusCode).toBe(400);
    expect((await app.inject({ url: url(`/prune/plans/${PLAN}/map/x`) })).statusCode).toBe(400);
    const none = build({ readPruneMap: vi.fn(async () => null) });
    expect((await none.app.inject({ url: url(`/prune/plans/${PLAN}/map/0`) })).statusCode).toBe(404);
    const big = build({ readPruneMap: vi.fn(async () => { throw new PruneScriptError("map_too_large"); }) });
    expect((await big.app.inject({ url: url(`/prune/plans/${PLAN}/map/0`) })).statusCode).toBe(500);
  });
});

describe("dimensions, status and cancel", () => {
  it("lists the dimensions", async () => {
    const { app } = build();
    const res = await app.inject({ url: url("/prune/dimensions") });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ dimensions: [{ id: "overworld", regions: 4 }] });
  });

  it("reports the engine status", async () => {
    const { app } = build();
    expect((await app.inject({ url: url("/prune/status") })).json()).toEqual({ engine: "builtin", version: 1 });
  });

  it("cancels a scan, 404s one that is not running, 400s a bad id", async () => {
    const { app, entry } = build();
    const ok = await app.inject({ method: "POST", url: url(`/prune/scans/${JOB}/cancel`) });
    expect(ok.json()).toEqual({ cancelled: true });
    expect(entry.cancelPruneScan).toHaveBeenCalledWith(JOB);
    const gone = build({ cancelPruneScan: vi.fn(() => false) });
    expect((await gone.app.inject({ method: "POST", url: url(`/prune/scans/${JOB}/cancel`) })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: url("/prune/scans/x/cancel") })).statusCode).toBe(400);
  });

  it("501s when the suite has no prune script", async () => {
    const { app } = build({ getPruneDimensions: vi.fn(async () => { throw new PruneUnavailableError(); }) });
    expect((await app.inject({ url: url("/prune/dimensions") })).statusCode).toBe(501);
  });
});

describe("POST /operations/prune", () => {
  const post = (app: ReturnType<typeof build>["app"], payload: unknown) =>
    app.inject({ method: "POST", url: url("/operations/prune"), payload: payload as object });

  it("starts a prune-only job for the plan", async () => {
    const { app, entry } = build();
    const res = await post(app, { planId: PLAN, countdownSeconds: 20 });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ jobId: JOB });
    expect(entry.startUpgrade).toHaveBeenCalledWith({ pruneOnly: true, prunePlan: PLAN, countdownSeconds: 20 });
  });

  it.each([{}, { planId: "short" }, { planId: "../../etc/passwd" }, { planId: PLAN, countdownSeconds: 601 }, { planId: PLAN, countdownSeconds: 1.5 }])(
    "400s %j without starting anything",
    async (body) => {
      const { app, entry } = build();
      expect((await post(app, body)).statusCode).toBe(400);
      expect(entry.startUpgrade).not.toHaveBeenCalled();
    },
  );

  it("404s a plan that no longer exists", async () => {
    const { app } = build({ startUpgrade: vi.fn(async () => { throw new PrunePlanMissingError(); }) });
    expect((await post(app, { planId: PLAN })).statusCode).toBe(404);
  });

  it("423s while something else holds the instance", async () => {
    const { app } = build({ startUpgrade: vi.fn(async () => { throw new OperationBusyError({ kind: "backup" }); }) });
    const res = await post(app, { planId: PLAN });
    expect(res.statusCode).toBe(423);
    expect(res.json()).toMatchObject({ busy: { kind: "backup" } });
  });
});
