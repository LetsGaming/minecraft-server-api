/**
 * Audit-fix regressions (2026-07-06 cross-project audit):
 *
 *  SEC-02  /logs/stream refuses clients beyond the per-instance cap (503)
 *  SEC-03  auth-fail limiter keys on the real client IP when trustProxy
 *          is enabled; without it, X-Forwarded-For must stay ignored
 *  SEC-05  500 bodies are a fixed string — no err detail (paths, stderr)
 *  BUG-02  unparseable ports from env/vars fall back with a warning
 *          instead of carrying NaN into the config
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import Fastify, { type FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { registerInstanceRoutes } from "../src/routes/instances.js";
import type { Operations } from "../src/operations.js";
import type { LogStreamAPI } from "../src/logStream.js";
import type { AppConfig, InstanceConfig } from "../src/types.js";

const KEY = "audit-fix-test-key";

function scaffoldInstance(rootLabel: string): { root: string; cfg: AppConfig } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), rootLabel));
  const serverPath = path.join(root, "server");
  fs.mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  fs.writeFileSync(path.join(serverPath, "logs", "latest.log"), "boot\n");
  const instance: InstanceConfig = {
    id: "survival",
    serverPath,
    linuxUser: "minecraft",
    useRcon: false,
    rconHost: "localhost",
    rconPort: 25575,
    rconPassword: "",
    backupsPath: "",
    scriptsDir: path.join(root, "scripts"),
  };
  return {
    root,
    cfg: { PORT: 0, API_KEY: KEY, instances: { survival: instance } },
  };
}

// ── SEC-05: generic 500 bodies ──────────────────────────────────────────────

describe("SEC-05 — 500 responses never leak error detail", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    const throwing = {
      getWhitelist: () => {
        throw new Error("EACCES: /etc/secret/whitelist.json");
      },
      tailLog: async () => {
        throw new Error("sudo: /opt/hidden/tail.sh exited 1: stderr junk");
      },
      sendCommand: async () => {
        throw new Error("rcon at 10.1.2.3:25575 refused");
      },
      cfg: {} as InstanceConfig,
    } as unknown as Operations & { cfg: InstanceConfig };
    const registry = new Map([["survival", throwing]]);
    const logStreamAPI: LogStreamAPI = {
      addClient: () => true,
      removeClient: () => {},
      dispose: () => {},
    };
    registerInstanceRoutes(app, registry, logStreamAPI);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([
    ["GET", "/instances/survival/whitelist"],
    ["GET", "/instances/survival/logs/tail"],
  ])("%s %s returns the fixed body", async (method, url) => {
    const res = await app.inject({ method: method as "GET", url });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "Internal server error" });
  });

  it("POST command 500 carries neither paths nor host detail", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/instances/survival/command",
      payload: { command: "list" },
    });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("10.1.2.3");
    expect(res.body).not.toContain("/etc/");
    expect(res.body).not.toContain("/opt/");
    expect(res.json()).toEqual({ error: "Internal server error" });
  });
});

// ── SEC-03: proxy-aware auth-fail limiter ───────────────────────────────────

describe("SEC-03 — auth-fail limiter and trustProxy", () => {
  it("trustProxy=false ignores X-Forwarded-For (all callers share the socket IP)", async () => {
    const { root, cfg } = scaffoldInstance("sec03a-");
    const built = await buildApp({ config: cfg, allowNoAuth: false });
    try {
      // 20 failures with ROTATING forwarded headers — the tracker must
      // still key them all on the socket peer and lock the bucket.
      for (let i = 0; i < 20; i++) {
        const res = await built.app.inject({
          url: "/instances",
          headers: { "x-api-key": "wrong", "x-forwarded-for": `10.0.0.${i}` },
        });
        expect(res.statusCode).toBe(401);
      }
      const blocked = await built.app.inject({
        url: "/instances",
        headers: { "x-api-key": "wrong", "x-forwarded-for": "10.9.9.9" },
      });
      expect(blocked.statusCode).toBe(429);
    } finally {
      built.logStreamAPI.dispose();
      await built.app.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("trustProxy=true keys per forwarded client — one attacker cannot lock everyone out", async () => {
    const { root, cfg } = scaffoldInstance("sec03b-");
    const built = await buildApp({
      config: cfg,
      allowNoAuth: false,
      trustProxy: true,
    });
    try {
      // The attacker burns their budget from one forwarded IP…
      for (let i = 0; i < 20; i++) {
        const res = await built.app.inject({
          url: "/instances",
          headers: { "x-api-key": "wrong", "x-forwarded-for": "203.0.113.7" },
        });
        expect(res.statusCode).toBe(401);
      }
      const attacker = await built.app.inject({
        url: "/instances",
        headers: { "x-api-key": "wrong", "x-forwarded-for": "203.0.113.7" },
      });
      expect(attacker.statusCode).toBe(429);

      // …while a different forwarded client is unaffected.
      const bystanderBadKey = await built.app.inject({
        url: "/instances",
        headers: { "x-api-key": "wrong", "x-forwarded-for": "198.51.100.4" },
      });
      expect(bystanderBadKey.statusCode).toBe(401);

      const bystanderGoodKey = await built.app.inject({
        url: "/instances",
        headers: { "x-api-key": KEY, "x-forwarded-for": "198.51.100.5" },
      });
      expect(bystanderGoodKey.statusCode).toBe(200);
    } finally {
      built.logStreamAPI.dispose();
      await built.app.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── SEC-02: SSE client cap (real sockets) ───────────────────────────────────

describe("SEC-02 — SSE per-instance client cap", () => {
  let root: string;
  let app: FastifyInstance;
  let dispose: () => void;
  let base: string;

  beforeAll(async () => {
    vi.stubEnv("MC_SSE_MAX_CLIENTS", "2");
    const scaffold = scaffoldInstance("sec02-");
    root = scaffold.root;
    const built = await buildApp({ config: scaffold.cfg, allowNoAuth: false });
    app = built.app;
    dispose = built.logStreamAPI.dispose;
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (typeof addr === "object" && addr) base = `http://127.0.0.1:${addr.port}`;
  }, 15_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    dispose();
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("503s the client beyond the cap; capacity frees on disconnect", async () => {
    const open = async () => {
      const controller = new AbortController();
      const res = await fetch(`${base}/instances/survival/logs/stream`, {
        headers: { "x-api-key": KEY },
        signal: controller.signal,
      });
      return { res, controller };
    };

    const a = await open();
    const b = await open();
    expect(a.res.status).toBe(200);
    expect(b.res.status).toBe(200);

    // Third concurrent client — over the cap of 2.
    const over = await fetch(`${base}/instances/survival/logs/stream`, {
      headers: { "x-api-key": KEY },
    });
    expect(over.status).toBe(503);
    expect((await over.json()) as { error: string }).toEqual({
      error: "Too many log stream clients for this instance",
    });

    // Freeing a slot must let a new client in (removeClient on close).
    a.controller.abort();
    const deadline = Date.now() + 5_000;
    let reattached: Response | null = null;
    while (Date.now() < deadline) {
      const attempt = await fetch(`${base}/instances/survival/logs/stream`, {
        headers: { "x-api-key": KEY },
      }).catch(() => null);
      if (attempt?.status === 200) {
        reattached = attempt;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(reattached?.status).toBe(200);

    b.controller.abort();
  }, 15_000);
});

// ── BUG-02: port validation in the vars/env fallback ────────────────────────

describe("BUG-02 — unparseable ports fall back instead of becoming NaN", () => {
  const SAVED = [
    "CONFIG_FILE",
    "VARIABLES_TXT_PATH",
    "SERVER_PATH",
    "RCON_PORT",
    "API_SERVER_PORT",
    "MC_PORT",
    "MC_API_KEY",
    "INSTANCE_NAME",
  ] as const;

  it("garbage / out-of-range ports use the documented defaults", async () => {
    const saved = Object.fromEntries(SAVED.map((k) => [k, process.env[k]]));
    try {
      process.env.CONFIG_FILE = path.join(os.tmpdir(), "does-not-exist.json");
      delete process.env.VARIABLES_TXT_PATH;
      delete process.env.MC_PORT;
      delete process.env.MC_API_KEY;
      process.env.SERVER_PATH = os.tmpdir();
      process.env.INSTANCE_NAME = "bugcheck";
      process.env.RCON_PORT = "not-a-port";
      process.env.API_SERVER_PORT = "99999"; // out of range

      const { loadConfig } = await import("../src/config.js");
      const cfg = loadConfig();

      expect(cfg.PORT).toBe(3000);
      expect(cfg.instances.bugcheck!.rconPort).toBe(25575);
      expect(Number.isNaN(cfg.instances.bugcheck!.rconPort)).toBe(false);
    } finally {
      for (const k of SAVED) {
        const v = saved[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
