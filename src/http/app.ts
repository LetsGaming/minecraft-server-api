/**
 * Fastify app assembly — separated from the listener so tests can
 * exercise the full middleware chain (auth, rate limits, routes) via
 * app.inject() without opening a port.
 *
 * This file is wiring only. Auth lives in auth.ts, route groups under
 * routes/, and every decision behind them in instances/.
 */
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";

import { registerAuth } from "./auth.js";
import { registerHealthRoute, registerManifestRoute } from "./routes/meta.js";
import { registerInstanceRoutes } from "./routes/instance/index.js";
import { createOperations } from "../instances/operations.js";
import { initLogStream, type LogStreamAPI } from "../platform/logStream.js";
import type { AppConfig } from "../config/types.js";
import type { InstanceEntry } from "./routes/instance/shared.js";

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

// A-07: this API only receives short commands and script action names; the
// default 1 MB body limit is unnecessarily large.
const BODY_LIMIT_BYTES = 4096;

const GLOBAL_RATE_LIMIT_MAX = 300;
const GLOBAL_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

export async function buildApp(opts: BuildOptions): Promise<BuiltApp> {
  const { config, allowNoAuth } = opts;

  const app = Fastify({
    logger: false,
    bodyLimit: BODY_LIMIT_BYTES,
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

  // ── Route census ────────────────────────────────────────────────────
  // Collected from Fastify's own router so /manifest reports what this
  // process actually serves. Must be added before any route is
  // registered — onRoute only fires for registrations that follow it.
  const routes: string[] = [];
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      // HEAD is auto-generated alongside every GET; it is not a
      // separate capability and would only add noise for the bot.
      if (method === "HEAD") continue;
      routes.push(`${method} ${route.url}`);
    }
  });

  // ── Security headers ────────────────────────────────────────────────
  app.addHook("onSend", async (_req, reply) => {
    void reply.header("X-Content-Type-Options", "nosniff");
    void reply.header("X-Frame-Options", "DENY");
  });

  // ── Rate limiting ───────────────────────────────────────────────────
  // Global throttle; /health is exempt so uptime monitors never trip it.
  await app.register(rateLimit, {
    max: GLOBAL_RATE_LIMIT_MAX,
    timeWindow: GLOBAL_RATE_LIMIT_WINDOW_MS,
    allowList: (req) => req.url === "/health",
    errorResponseBuilder: () => ({ error: "Too many requests" }),
  });

  registerHealthRoute(app);
  registerAuth(app, config, allowNoAuth);

  // ── Instance registry ───────────────────────────────────────────────
  const opsRegistry = new Map<string, InstanceEntry>();
  for (const [id, cfg] of Object.entries(config.instances)) {
    opsRegistry.set(id, Object.assign(createOperations(cfg), { cfg }));
  }

  const logStreamAPI = initLogStream(config.instances);

  registerInstanceRoutes(app, opsRegistry, logStreamAPI);

  registerManifestRoute(app, routes);

  // Historical `{ error }` body shape on unknown routes.
  app.setNotFoundHandler((_req, reply) => {
    void reply.status(404).send({ error: "Not found" });
  });

  return { app, logStreamAPI };
}
