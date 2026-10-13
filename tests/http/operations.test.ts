/**
 * POST /operations/upgrade, the poll routes, /events and the 423 busy answer.
 * The instance bundle is stubbed; the job logic is covered in
 * tests/instances/upgrades.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";

import { registerOperationRoutes } from "../../src/http/routes/instance/operations.js";
import { registerControlRoutes } from "../../src/http/routes/instance/control.js";
import type { InstanceEntry } from "../../src/http/routes/instance/shared.js";
import { OperationBusyError } from "../../src/instances/operationSlot.js";
import { UpgradeUnavailableError } from "../../src/instances/upgrades.js";

const JOB = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const VIEW = { jobId: JOB, state: "running", mcVersion: "1.21.5", events: [], next: 0 };

function build(overrides: Record<string, unknown> = {}) {
  const entry = {
    startUpgrade: vi.fn(async () => ({ jobId: JOB })),
    getUpgrade: vi.fn(() => VIEW),
    getCurrentUpgrade: vi.fn(async () => VIEW),
    readLifecycleEvents: vi.fn(async () => ({ events: [{ ts: 1, type: "jvm_start" }], next: 40, reset: false })),
    runScript: vi.fn(async () => ({ output: "", stderr: "", exitCode: 0 })),
    ...overrides,
  };
  const app = Fastify();
  const resolve = (id: string, reply: { status: (n: number) => { send: (b: unknown) => unknown } }) => {
    if (id !== "survival") {
      void reply.status(404).send({ error: "Instance not found" });
      return null;
    }
    return entry as unknown as InstanceEntry;
  };
  registerOperationRoutes(app, resolve as never);
  registerControlRoutes(app, resolve as never);
  return { app, entry };
}

const post = (app: ReturnType<typeof build>["app"], payload: unknown) =>
  app.inject({ method: "POST", url: "/instances/survival/operations/upgrade", payload: payload as object });

describe("POST /operations/upgrade", () => {
  it("starts a job and answers 202 with its id", async () => {
    const { app, entry } = build();
    const res = await post(app, { mcVersion: "1.21.5", expectUnavailable: ["sodium"], countdownSeconds: 10 });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ jobId: JOB });
    expect(entry.startUpgrade).toHaveBeenCalledWith({
      mcVersion: "1.21.5",
      expectUnavailable: ["sodium"],
      countdownSeconds: 10,
    });
  });

  it("accepts a mod name the compatibility check could not look up", async () => {
    const { app, entry } = build();
    const res = await post(app, { mcVersion: "1.21.5", expectUnavailable: ["sit!"] });
    expect(res.statusCode).toBe(202);
    expect(entry.startUpgrade).toHaveBeenCalledWith({ mcVersion: "1.21.5", expectUnavailable: ["sit!"] });
  });

  it.each([
    {},
    { mcVersion: 5 },
    { mcVersion: "../x" },
    { mcVersion: "1.21.5", expectUnavailable: "sodium" },
    { mcVersion: "1.21.5", expectUnavailable: ["bad slug!"] },
    { mcVersion: "1.21.5", expectUnavailable: [1] },
    { mcVersion: "1.21.5", expectUnavailable: ["a,b"] },
    { mcVersion: "1.21.5", countdownSeconds: -1 },
    { mcVersion: "1.21.5", countdownSeconds: 601 },
    { mcVersion: "1.21.5", countdownSeconds: 1.5 },
    { mcVersion: "1.21.5", countdownSeconds: "10" },
  ])("400s on %j without starting anything", async (body) => {
    const { app, entry } = build();
    const res = await post(app, body);
    expect(res.statusCode).toBe(400);
    expect(entry.startUpgrade).not.toHaveBeenCalled();
  });

  it("423s while something else holds the instance, and says what", async () => {
    const { app } = build({
      startUpgrade: vi.fn(async () => {
        throw new OperationBusyError({ kind: "backup" });
      }),
    });
    const res = await post(app, { mcVersion: "1.21.5" });
    expect(res.statusCode).toBe(423);
    expect(res.json()).toMatchObject({ busy: { kind: "backup" } });
    expect(res.json().error).toContain("Another operation");
  });

  it("501s when the suite has no upgrade script", async () => {
    const { app } = build({
      startUpgrade: vi.fn(async () => {
        throw new UpgradeUnavailableError();
      }),
    });
    expect((await post(app, { mcVersion: "1.21.5" })).statusCode).toBe(501);
  });

  it("404s for an unknown instance", async () => {
    const { app } = build();
    const res = await app.inject({
      method: "POST",
      url: "/instances/nope/operations/upgrade",
      payload: { mcVersion: "1.21.5" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /operations/upgrade/:jobId and /current", () => {
  it("returns the job and passes the cursor", async () => {
    const { app, entry } = build();
    const res = await app.inject({ url: `/instances/survival/operations/upgrade/${JOB}?since=4` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ jobId: JOB, state: "running" });
    expect(entry.getUpgrade).toHaveBeenCalledWith(JOB, 4);
  });

  it("404s an unknown job and 400s a malformed id or cursor", async () => {
    const { app } = build({ getUpgrade: vi.fn(() => null) });
    expect((await app.inject({ url: `/instances/survival/operations/upgrade/${JOB}` })).statusCode).toBe(404);
    expect((await app.inject({ url: "/instances/survival/operations/upgrade/not-an-id" })).statusCode).toBe(400);
    expect((await app.inject({ url: `/instances/survival/operations/upgrade/${JOB}?since=-1` })).statusCode).toBe(400);
  });

  it("current answers the latest job, or 404 when there has been none", async () => {
    const found = build();
    expect((await found.app.inject({ url: "/instances/survival/operations/upgrade/current" })).statusCode).toBe(200);
    const none = build({ getCurrentUpgrade: vi.fn(async () => null) });
    expect((await none.app.inject({ url: "/instances/survival/operations/upgrade/current" })).statusCode).toBe(404);
  });
});

describe("GET /events", () => {
  it("returns events and the next cursor", async () => {
    const { app, entry } = build();
    const res = await app.inject({ url: "/instances/survival/events?since=12" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ events: [{ ts: 1, type: "jvm_start" }], next: 40, reset: false });
    expect(entry.readLifecycleEvents).toHaveBeenCalledWith(12);
  });

  it("defaults the cursor to 0 and rejects a bad one", async () => {
    const { app, entry } = build();
    await app.inject({ url: "/instances/survival/events" });
    expect(entry.readLifecycleEvents).toHaveBeenCalledWith(0);
    expect((await app.inject({ url: "/instances/survival/events?since=abc" })).statusCode).toBe(400);
  });
});

describe("a busy instance on the existing routes", () => {
  it("POST /scripts/run answers 423 instead of racing the running operation", async () => {
    const { app } = build({
      runScript: vi.fn(async () => {
        throw new OperationBusyError({ kind: "upgrade", jobId: JOB });
      }),
    });
    const res = await app.inject({
      method: "POST",
      url: "/instances/survival/scripts/run",
      payload: { action: "stop" },
    });
    expect(res.statusCode).toBe(423);
    expect(res.json()).toMatchObject({ busy: { kind: "upgrade", jobId: JOB } });
  });
});
