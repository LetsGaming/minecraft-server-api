/**
 * Fastify app assembly — separated from the listener so tests can
 * exercise the full middleware chain (auth, rate limits, routes) via
 * app.inject() without opening a port.
 */
import crypto from "crypto";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";

import { createOperations, type Operations } from "./operations.js";
import { initLogStream, type LogStreamAPI } from "./logStream.js";
import { registerInstanceRoutes } from "./routes/instances.js";
import { WRAPPER_VERSION } from "./version.js";
import type { AppConfig, InstanceConfig } from "./types.js";

export interface BuildOptions {
  config: AppConfig;
  /** SEC-01 dev escape hatch — loopback-only, explicit opt-in. */
  allowNoAuth: boolean;
  /**
   * SEC-03: honor X-Forwarded-For so req.ip is the real client behind a
   * reverse proxy. Off by default (direct bind); only enable behind a
   * proxy that SETS the header — a spoofable forwarded header would let
   * an attacker rotate limiter buckets at will. Wired from
   * MC_TRUST_PROXY in index.ts.
   */
  trustProxy?: boolean;
}

export interface BuiltApp {
  app: FastifyInstance;
  logStreamAPI: LogStreamAPI;
}

// ── Auth-failure limiter ────────────────────────────────────────────────
// The global limiter throttles overall traffic; this one specifically
// slows key guessing: 20 failed authentications per IP per 15 minutes.
// Hand-rolled sliding window — @fastify/rate-limit cannot count only
// failures, and 25 lines beat a second dependency.
const AUTH_FAIL_WINDOW_MS = 15 * 60 * 1000;
const AUTH_FAIL_MAX = 20;

export class AuthFailTracker {
  private readonly failures = new Map<string, number[]>();

  /** True when this IP has exhausted its failure budget. */
  isBlocked(ip: string): boolean {
    const now = Date.now();
    const list = (this.failures.get(ip) ?? []).filter(
      (t) => now - t < AUTH_FAIL_WINDOW_MS,
    );
    this.failures.set(ip, list);
    return list.length >= AUTH_FAIL_MAX;
  }

  recordFailure(ip: string): void {
    const list = this.failures.get(ip) ?? [];
    list.push(Date.now());
    this.failures.set(ip, list);
  }
}

/** Constant-time API-key comparison (timing-oracle resistant). */
export function keyMatches(received: string, expected: string): boolean {
  const expectedBuf = Buffer.from(expected);
  const receivedBuf = Buffer.alloc(expectedBuf.length);
  Buffer.from(received).copy(receivedBuf);
  return (
    received.length === expected.length &&
    crypto.timingSafeEqual(receivedBuf, expectedBuf)
  );
}

export async function buildApp(opts: BuildOptions): Promise<BuiltApp> {
  const { config, allowNoAuth } = opts;

  const app = Fastify({
    logger: false,
    // A-07: this API only receives short commands and script action
    // names; the default 1 MB body limit is unnecessarily large.
    bodyLimit: 4096,
    // SEC-03: with trustProxy=false behind a reverse proxy, every
    // request shares the proxy's IP — 20 failed keys from ANYONE locks
    // out EVERYONE, and per-attacker limiting is meaningless. Both the
    // auth-fail tracker and the global limiter key on req.ip, so this
    // must reflect the deployment.
    trustProxy: opts.trustProxy ?? false,
    // SSE clients hold their sockets open indefinitely; without this,
    // app.close() would wait on them forever and SIGTERM would hang
    // until systemd/PM2 escalates to SIGKILL.
    forceCloseConnections: true,
  });

  // ── Security headers ────────────────────────────────────────────────
  app.addHook("onSend", async (_req, reply) => {
    void reply.header("X-Content-Type-Options", "nosniff");
    void reply.header("X-Frame-Options", "DENY");
  });

  // ── Rate limiting ───────────────────────────────────────────────────
  // Global throttle; /health is exempt so uptime monitors never trip it.
  await app.register(rateLimit, {
    max: 300,
    timeWindow: 15 * 60 * 1000,
    allowList: (req) => req.url === "/health",
    errorResponseBuilder: () => ({ error: "Too many requests" }),
  });

  // ── Health (public — registered before the auth hook fires for it) ──
  app.get("/health", async () => ({ ok: true, version: WRAPPER_VERSION }));

  // ── Auth ────────────────────────────────────────────────────────────
  const authFails = new AuthFailTracker();

  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/health") return;

    // SEC-01: only bypass auth in the explicit, loopback-bound no-auth
    // dev mode. In every other case a key exists (enforced at startup).
    if (!config.API_KEY) {
      if (allowNoAuth) return;
      return reply.status(503).send({ error: "Server misconfigured: no API key" });
    }

    const ip = req.ip;
    if (authFails.isBlocked(ip)) {
      return reply
        .status(429)
        .send({ error: "Too many failed authentication attempts" });
    }

    const key = String(req.headers["x-api-key"] ?? "");
    if (!keyMatches(key, config.API_KEY)) {
      authFails.recordFailure(ip);
      return reply.status(401).send({ error: "Unauthorized" });
    }
  });

  // ── Instance registry ───────────────────────────────────────────────
  const opsRegistry = new Map<
    string,
    Operations & { cfg: InstanceConfig }
  >();
  for (const [id, cfg] of Object.entries(config.instances)) {
    opsRegistry.set(id, Object.assign(createOperations(cfg), { cfg }));
  }

  const logStreamAPI = initLogStream(config.instances);

  registerInstanceRoutes(app, opsRegistry, logStreamAPI);

  // Historical `{ error }` body shape on unknown routes.
  app.setNotFoundHandler((_req, reply) => {
    void reply.status(404).send({ error: "Not found" });
  });

  return { app, logStreamAPI };
}
