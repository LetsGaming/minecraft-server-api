/**
 * POST /mods/compat and GET /mods/compat/:jobId: input validation and the
 * mapping of the instance's errors to status codes. The instance bundle is
 * stubbed; the job logic itself is covered in tests/instances/modCompat.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";

import { registerModRoutes } from "../../src/http/routes/instance/mods.js";
import type { InstanceEntry } from "../../src/http/routes/instance/shared.js";
import {
  CompatBusyError,
  CompatManifestMissingError,
} from "../../src/instances/modCompat.js";

const JOB = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";

function build(
  overrides: Partial<Record<"startModCompat" | "getModCompat", unknown>> = {},
) {
  const entry = {
    startModCompat: vi.fn(async () => ({ jobId: JOB })),
    getModCompat: vi.fn(() => null),
    ...overrides,
  };
  const app = Fastify();
  registerModRoutes(app, (id, reply) => {
    if (id !== "survival") {
      void reply.status(404).send({ error: "Instance not found" });
      return null;
    }
    return entry as unknown as InstanceEntry;
  });
  return { app, entry };
}

const post = (
  app: ReturnType<typeof build>["app"],
  payload: unknown,
  query = "",
) =>
  app.inject({
    method: "POST",
    url: `/instances/survival/mods/compat${query}`,
    payload: payload as object,
  });

describe("POST /mods/compat", () => {
  it("starts a job and answers 202 with its id", async () => {
    const { app, entry } = build();
    const res = await post(app, { mcVersion: "1.21.5" });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ jobId: JOB });
    expect(entry.startModCompat).toHaveBeenCalledWith("1.21.5", { refresh: false });
  });

  it("passes refresh from the body or the query", async () => {
    const { app, entry } = build();
    await post(app, { mcVersion: "1.21.5", refresh: true });
    await post(app, { mcVersion: "1.21.5" }, "?refresh=1");
    expect(entry.startModCompat).toHaveBeenNthCalledWith(1, "1.21.5", { refresh: true });
    expect(entry.startModCompat).toHaveBeenNthCalledWith(2, "1.21.5", { refresh: true });
  });

  it.each([
    {},
    { mcVersion: 5 },
    { mcVersion: "1 2" },
    { mcVersion: "../x" },
    { mcVersion: "a".repeat(21) },
  ])("400s on %j without starting anything", async (body) => {
    const { app, entry } = build();
    const res = await post(app, body);
    expect(res.statusCode).toBe(400);
    expect(entry.startModCompat).not.toHaveBeenCalled();
  });

  it("404s for an unknown instance", async () => {
    const { app } = build();
    const res = await app.inject({
      method: "POST",
      url: "/instances/nope/mods/compat",
      payload: { mcVersion: "1.21.5" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("maps a missing manifest to 404 and too many jobs to 503", async () => {
    const missing = build({
      startModCompat: vi.fn(async () => {
        throw new CompatManifestMissingError();
      }),
    });
    expect((await post(missing.app, { mcVersion: "1.21.5" })).statusCode).toBe(404);
    const busy = build({
      startModCompat: vi.fn(async () => {
        throw new CompatBusyError();
      }),
    });
    expect((await post(busy.app, { mcVersion: "1.21.5" })).statusCode).toBe(503);
  });

  it("500s on an unexpected failure", async () => {
    const { app } = build({
      startModCompat: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    expect((await post(app, { mcVersion: "1.21.5" })).statusCode).toBe(500);
  });
});

describe("GET /mods/compat/:jobId", () => {
  it("serialises the job through its schema", async () => {
    const { app } = build({
      getModCompat: vi.fn(() => ({
        jobId: JOB,
        state: "running",
        mcVersion: "1.21.5",
        modLoader: null,
        progress: { done: 1, total: 2 },
        partial: [{ slug: "a", availability: "available", extra: "dropped" }],
      })),
    });
    const res = await app.inject({ url: `/instances/survival/mods/compat/${JOB}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      jobId: JOB,
      state: "running",
      mcVersion: "1.21.5",
      modLoader: null,
      progress: { done: 1, total: 2 },
      partial: [{ slug: "a", availability: "available" }],
    });
  });

  it("404s for an unknown or expired job and 400s on a malformed id", async () => {
    const { app } = build();
    const missing = await app.inject({ url: `/instances/survival/mods/compat/${JOB}` });
    expect(missing.statusCode).toBe(404);
    const bad = await app.inject({ url: "/instances/survival/mods/compat/..x" });
    expect(bad.statusCode).toBe(400);
  });
});
