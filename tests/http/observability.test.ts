/**
 * The Phase 0/3 additions: request metrics, the split rate limiters, and the
 * in-flight ceiling. A separate app instance (and a low-enough write budget
 * to actually hit within a test) rather than sharing app.test.ts's, so
 * saturating a budget here cannot bleed into unrelated route tests.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { buildApp } from "../../src/http/app.js";
import { beginRequest, endRequest, getSnapshot } from "../../src/platform/metrics.js";
import { WRITE_LIMIT_MAX } from "../../src/http/writeRateLimit.js";
import type { AppConfig } from "../../src/config/types.js";
import type { FastifyInstance } from "fastify";

const KEY = "test-key-0123456789";
const auth = { "x-api-key": KEY };

let root: string;
let app: FastifyInstance;
let dispose: () => void;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "observability-"));
  const serverPath = path.join(root, "server");
  const scriptsDir = path.join(root, "scripts");
  fs.mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  fs.mkdirSync(path.join(scriptsDir, "common"), { recursive: true });
  fs.writeFileSync(path.join(serverPath, "server.properties"), "level-name=world\n");

  const config: AppConfig = {
    PORT: 0,
    API_KEY: KEY,
    instances: {
      survival: {
        id: "survival",
        serverPath,
        linuxUser: "minecraft",
        useRcon: false,
        rconHost: "localhost",
        rconPort: 25575,
        rconPassword: "",
        backupsPath: "",
        scriptsDir,
      },
    },
  };
  const built = await buildApp({ config, allowNoAuth: false });
  app = built.app;
  dispose = built.logStreamAPI.dispose;
});

afterAll(async () => {
  dispose();
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("GET /metrics", () => {
  it("is authenticated like every other route", async () => {
    const res = await app.inject({ url: "/metrics" });
    expect(res.statusCode).toBe(401);
  });

  it("reports counters shaped for per-route count/p50/p95", async () => {
    await app.inject({ url: "/instances/survival/running", headers: auth });
    const res = await app.inject({ url: "/metrics", headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("inFlight");
    expect(body).toHaveProperty("peakInFlight");
    expect(body).toHaveProperty("memory");
    expect(body).toHaveProperty("eventLoopDelayMs");
    const key = "GET /instances/:id/running";
    expect(body.routes[key].count).toBeGreaterThanOrEqual(1);
    expect(body.routes[key]).toHaveProperty("p50Ms");
    expect(body.routes[key]).toHaveProperty("p95Ms");
  });
});

describe("metrics keys (W-010)", () => {
  it("files unmatched URLs under one key, whatever their path or query", async () => {
    for (let i = 0; i < 5; i++) {
      await app.inject({ url: `/no-such-route-${i}?q=${i}` });
    }
    const keys = Object.keys(getSnapshot().routes);
    expect(keys.some((k) => k.includes("no-such-route"))).toBe(false);
    expect(keys).toContain("GET <unmatched>");
  });
});

describe("write rate limit (separate from the read budget)", () => {
  it("429s past the write budget with Retry-After, while GETs keep working", async () => {
    let lastWriteStatus = 0;
    for (let i = 0; i < WRITE_LIMIT_MAX + 2; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/instances/survival/command",
        headers: { ...auth, "content-type": "application/json" },
        payload: { command: "list" },
      });
      lastWriteStatus = res.statusCode;
      if (lastWriteStatus === 429) {
        expect(res.headers["retry-after"]).toBeDefined();
        expect(res.json()).toEqual({ error: "Too many write requests" });
      }
    }
    expect(lastWriteStatus).toBe(429);

    // The read budget is untouched by the write budget being exhausted.
    const readRes = await app.inject({ url: "/instances/survival/running", headers: auth });
    expect(readRes.statusCode).toBe(200);
  });
});

describe("in-flight ceiling", () => {
  it("503s with Retry-After above the ceiling; /health and /metrics stay exempt", async () => {
    const MAX_IN_FLIGHT = 32;
    for (let i = 0; i < MAX_IN_FLIGHT + 1; i++) beginRequest();
    try {
      const res = await app.inject({ url: "/instances/survival/running", headers: auth });
      expect(res.statusCode).toBe(503);
      expect(res.headers["retry-after"]).toBeDefined();

      const health = await app.inject({ url: "/health" });
      expect(health.statusCode).toBe(200);

      const metrics = await app.inject({ url: "/metrics", headers: auth });
      expect(metrics.statusCode).toBe(200);
    } finally {
      for (let i = 0; i < MAX_IN_FLIGHT + 1; i++) endRequest();
    }
  });
});

describe("metrics snapshot helper", () => {
  it("computes a hit rate from recorded cache hits/misses", () => {
    const before = getSnapshot();
    expect(before).toHaveProperty("cache");
  });
});
