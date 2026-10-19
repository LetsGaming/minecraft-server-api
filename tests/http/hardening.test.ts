/**
 * HTTP-layer limits: per-route body limits, the uniform error body for
 * framework errors, and the concurrency caps for spawning routes and downloads.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import Fastify from "fastify";
import { buildApp } from "../../src/http/app.js";
import { registerPruneRoutes } from "../../src/http/routes/instance/prune.js";
import { ConcurrencyCap } from "../../src/http/routeCaps.js";
import { getInFlight } from "../../src/platform/metrics.js";
import type { InstanceEntry } from "../../src/http/routes/instance/shared.js";
import type { AppConfig } from "../../src/config/types.js";
import type { FastifyInstance } from "fastify";

const KEY = "hardening-test-key-0123456789abcdef";
const auth = { "x-api-key": KEY };

let root: string;
let app: FastifyInstance;
let dispose: () => void;
let port: number;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hardening-"));
  const serverPath = path.join(root, "server");
  const scriptsDir = path.join(root, "scripts");
  const backupsPath = path.join(root, "backups");
  fs.mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  fs.mkdirSync(path.join(backupsPath, "hourly"), { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(
    path.join(backupsPath, "hourly", "2026-07-06_10-00-00.tar.zst"),
    Buffer.alloc(64 * 1024 * 1024),
  );
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
        backupsPath,
        scriptsDir,
      },
    },
  };
  const built = await buildApp({ config, allowNoAuth: false });
  app = built.app;
  dispose = built.logStreamAPI.dispose;
  app.get("/test/boom", async () => {
    throw new Error("EACCES /secret/path");
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as { port: number }).port;
}, 15_000);

afterAll(async () => {
  dispose();
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function maximalPruneBody() {
  const dimension = "d".repeat(64);
  const far = 2_000_000;
  const op = { dimension, mode: "remove", x1: -far, z1: -far, x2: -far, z2: -far };
  const zone = { name: "n".repeat(64), dimension, x1: -far, z1: -far, x2: -far, z2: -far };
  return {
    thresholdMinutes: 1_000_000,
    spawnRadiusChunks: 1_000_000,
    playerRadiusChunks: 1_000_000,
    bufferChunks: 1_000_000,
    zones: new Array(100).fill(zone),
    dimensions: new Array(32).fill(dimension),
    buildProtection: "likely",
    selection: { allowProtected: true, ops: new Array(2500).fill(op) },
  };
}

describe("body limits", () => {
  it("accepts a maximal prune body (past the global limit) on settings and scans", async () => {
    const payload = maximalPruneBody();
    const size = Buffer.byteLength(JSON.stringify(payload));
    expect(size).toBeGreaterThan(4096);
    expect(size).toBeLessThan(512 * 1024);
    for (const [method, url] of [
      ["PUT", "/instances/survival/prune/settings"],
      ["POST", "/instances/survival/prune/scans"],
    ] as const) {
      const res = await app.inject({ method, url, headers: auth, payload });
      expect(res.statusCode, `${method} ${url}`).not.toBe(413);
      expect(res.statusCode, `${method} ${url}`).not.toBe(400);
    }
  });

  it("413s a prune body over its limit", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/instances/survival/prune/settings",
      headers: auth,
      payload: { zones: [], pad: "x".repeat(600 * 1024) },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: expect.any(String) });
  });

  it("accepts a maximal upgrade body and 413s one over its limit", async () => {
    const names = new Array(500).fill("m".repeat(96));
    const ok = await app.inject({
      method: "POST",
      url: "/instances/survival/operations/upgrade",
      headers: auth,
      payload: { mcVersion: "1.21.1", expectUnavailable: names, countdownSeconds: 0 },
    });
    expect(ok.statusCode).not.toBe(413);
    expect(ok.statusCode).not.toBe(400);

    const big = await app.inject({
      method: "POST",
      url: "/instances/survival/operations/upgrade",
      headers: auth,
      payload: { mcVersion: "1.21.1", expectUnavailable: names, pad: "x".repeat(70 * 1024) },
    });
    expect(big.statusCode).toBe(413);
  });

  it("keeps the small default limit elsewhere", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/instances/survival/command",
      headers: auth,
      payload: { command: "x".repeat(5000) },
    });
    expect(res.statusCode).toBe(413);
  });
});

describe("error body shape", () => {
  it("answers malformed JSON with { error }", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/instances/survival/command",
      headers: { ...auth, "content-type": "application/json" },
      payload: "{",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: expect.any(String) });
  });

  it("answers an unsupported media type with { error }", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/instances/survival/command",
      headers: { ...auth, "content-type": "application/xml" },
      payload: "list",
    });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toEqual({ error: expect.any(String) });
  });

  it("answers an unexpected failure with a fixed 500 body", async () => {
    const res = await app.inject({ url: "/test/boom", headers: auth });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "Internal server error" });
  });
});

describe("concurrency caps", () => {
  it("ConcurrencyCap hands out each slot once", () => {
    const cap = new ConcurrencyCap(2);
    const a = cap.tryEnter()!;
    expect(cap.tryEnter()).not.toBeNull();
    expect(cap.tryEnter()).toBeNull();
    a();
    a();
    expect(cap.tryEnter()).not.toBeNull();
    expect(cap.tryEnter()).toBeNull();
  });

  it("429s spawning prune reads beyond the per-instance cap and recovers", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const entry = {
      readPruneTile: vi.fn(async () => {
        await gate;
        return { png: Buffer.from([1]), etag: '"t"' };
      }),
    };
    const small = Fastify();
    registerPruneRoutes(small, (() => entry as unknown as InstanceEntry) as never);
    const pending = Array.from({ length: 6 }, (_, i) =>
      small.inject({ url: `/instances/capcheck/prune/tiles/overworld/${i}/0` }),
    );
    await vi.waitFor(() => expect(entry.readPruneTile).toHaveBeenCalledTimes(6));
    const seventh = await small.inject({ url: "/instances/capcheck/prune/tiles/overworld/9/0" });
    expect(seventh.statusCode).toBe(429);
    expect(seventh.headers["retry-after"]).toBe("1");
    release();
    expect((await Promise.all(pending)).every((r) => r.statusCode === 200)).toBe(true);
    const after = await small.inject({ url: "/instances/capcheck/prune/tiles/overworld/9/0" });
    expect(after.statusCode).toBe(200);
  });

  it("caps downloads per instance and gives the in-flight slot back while streaming", async () => {
    const list = await app.inject({ url: "/instances/survival/backups/files", headers: auth });
    const fileId = (list.json() as { files: { id: string }[] }).files[0]!.id;
    const open = () =>
      new Promise<http.IncomingMessage>((resolve, reject) => {
        http
          .get(
            {
              host: "127.0.0.1",
              port,
              path: `/instances/survival/backups/files/${fileId}/download`,
              headers: auth,
            },
            (res) => {
              res.pause();
              resolve(res);
            },
          )
          .on("error", reject);
      });

    const before = getInFlight();
    const first = await open();
    const second = await open();
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect(getInFlight()).toBeLessThanOrEqual(before);

    const third = await open();
    expect(third.statusCode).toBe(429);
    third.resume();

    first.destroy();
    await vi.waitFor(
      async () => {
        const again = await open();
        const code = again.statusCode;
        again.destroy();
        expect(code).toBe(200);
      },
      { timeout: 5000 },
    );
    second.destroy();
  });
});
