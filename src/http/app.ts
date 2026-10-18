/**
 * Fastify app assembly — separated from the listener so tests can
 * exercise the full middleware chain (auth, rate limits, routes) via
 * app.inject() without opening a port.
 *
 * This file is wiring only. Auth lives in auth.ts, route groups under
 * routes/, and every decision behind them in instances/.
 */
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";

import { registerAuth } from "./auth.js";
import { registerHealthRoute, registerManifestRoute, registerMetricsRoute } from "./routes/meta.js";
import { registerInstanceRoutes } from "./routes/instance/index.js";
import { WriteRateLimiter } from "./writeRateLimit.js";
import { createOperations } from "../instances/operations.js";
import { initLogStream, type LogStreamAPI } from "../platform/logStream.js";
import { log, logThrottled } from "../platform/logger.js";
import {
  beginRequest,
  endRequest,
  getInFlight,
  recordRateLimitRejection,
  recordRequest,
  UNMATCHED_ROUTE,
} from "../platform/metrics.js";
import type { RouteSpec } from "../contracts/openapi.js";
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
  trustProxy?: boolean | string[];
}

export interface BuiltApp {
  app: FastifyInstance;
  /** Every registered route with its schema, for generating openapi.json. */
  routeSpecs: readonly RouteSpec[];
  logStreamAPI: LogStreamAPI;
}

// A-07: this API only receives short commands and script action names; the
// default 1 MB body limit is unnecessarily large.
const BODY_LIMIT_BYTES = 4096;

// Reads (status polling) are frequent and cheap. This used to be 300/15min
// (20 req/min) shared by every route and every client behind a proxy — a
// budget that a single leaderboard build or one open dashboard tab could
// exhaust well before the window rolled, and every request past it read to
// the bot as "wrapper unreachable" rather than "rate limited". Writes get
// their own, tighter budget below (WriteRateLimiter).
const GLOBAL_RATE_LIMIT_MAX = 100;

/**
 * A client has this long to deliver a whole request. The largest body is a
 * few hundred kilobytes, so only a stalled or deliberately slow sender runs
 * into it.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * A socket silent for this long is dropped. Log streams send a heartbeat
 * every 20 s and downloads write continuously, so a live connection never
 * gets near it.
 */
const CONNECTION_TIMEOUT_MS = 120_000;
const GLOBAL_RATE_LIMIT_WINDOW_MS = 60 * 1000;

/**
 * A request that has been queued this long is not going to feel fast to the
 * caller even if it eventually succeeds — logged so a slow window (the
 * hourly backup, a large `du`) is visible after the fact rather than only
 * inferred from a client-side timeout.
 */
const SLOW_REQUEST_WARN_MS = 1_000;

/** Above this many requests in flight, the process cannot do the work
 * justice — a fast 503 beats accepting a queue nothing will drain in time. */
const MAX_IN_FLIGHT = 32;

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
    requestTimeout: REQUEST_TIMEOUT_MS,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
  });

  // ── Route census ────────────────────────────────────────────────────
  // Collected from Fastify's own router so /manifest reports what this
  // process actually serves. Must be added before any route is
  // registered — onRoute only fires for registrations that follow it.
  const routes: string[] = [];
  const routeSpecs: RouteSpec[] = [];
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      // HEAD is auto-generated alongside every GET; it is not a
      // separate capability and would only add noise for the bot.
      if (method === "HEAD") continue;
      routes.push(`${method} ${route.url}`);
      routeSpecs.push({ method, url: route.url, schema: route.schema });
    }
  });

  // ── Security headers ────────────────────────────────────────────────
  app.addHook("onSend", async (_req, reply) => {
    void reply.header("X-Content-Type-Options", "nosniff");
    void reply.header("X-Frame-Options", "DENY");
  });

  // ── Observability ────────────────────────────────────────────────────
  // Every request is timed and counted; nothing here is gated behind
  // MC_DEBUG because it is O(1) per request and is exactly what is needed
  // to answer "what was happening right before this went unreachable".
  app.addHook("onRequest", async (req, reply) => {
    beginRequest(req.raw);
    // W-002: Fastify skips onResponse when the client hung up before the
    // reply was sent, which leaked one slot per aborted request until every
    // route answered 503. The socket closing releases it too; endRequest
    // counts each request once whichever path gets there first.
    reply.raw.once("close", () => endRequest(req.raw));
  });
  app.addHook("onResponse", async (req, reply) => {
    endRequest(req.raw);
    const durationMs = reply.elapsedTime;
    // W-010: never the raw URL. An unauthenticated client could otherwise
    // add one metrics key per distinct path or query string, forever.
    const routePath = req.routeOptions.url ?? UNMATCHED_ROUTE;
    recordRequest(req.method, routePath, reply.statusCode, durationMs);
    if (durationMs > SLOW_REQUEST_WARN_MS) {
      log.warn(
        "http",
        `slow: ${req.method} ${routePath} → ${reply.statusCode} in ${Math.round(durationMs)}ms (${getInFlight()} in flight)`,
      );
    }
  });

  // ── In-flight ceiling ────────────────────────────────────────────────
  // A cap the process can actually serve, rather than accepting work it
  // cannot finish in time and having every caller time out anyway.
  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/health" || req.url === "/metrics") return;
    if (getInFlight() > MAX_IN_FLIGHT) {
      void reply.header("Retry-After", "1");
      return reply.status(503).send({ error: "Too many concurrent requests" });
    }
  });

  // ── Rate limiting ───────────────────────────────────────────────────
  // Global read throttle; /health and /metrics are exempt so uptime
  // monitors and scrapers never trip it.
  await app.register(rateLimit, {
    max: GLOBAL_RATE_LIMIT_MAX,
    timeWindow: GLOBAL_RATE_LIMIT_WINDOW_MS,
    allowList: (req) => req.url === "/health" || req.url === "/metrics",
    errorResponseBuilder: (_req, ctx) => {
      recordRateLimitRejection();
      // W-020: a flood would otherwise log one line per rejected request.
      logThrottled("429-read", 10_000, (held) =>
        log.warn(
          "http",
          `429: read budget exceeded (${ctx.max}/${ctx.after})${held ? ` (+${held} more not logged)` : ""}`,
        ),
      );
      return { error: "Too many requests" };
    },
  });

  registerHealthRoute(app);
  registerAuth(app, config, allowNoAuth);

  // A separate, tighter budget for anything that mutates state — see
  // writeRateLimit.ts for why this is hand-rolled rather than a second
  // plugin registration. Registered after auth on purpose: a rejected
  // request never reaches this hook, so unauthenticated POSTs cannot drain
  // the budget of a legitimate client sharing the same source address.
  const writeLimiter = new WriteRateLimiter();
  app.addHook("onRequest", async (req, reply) => {
    if (req.method === "GET" || req.method === "HEAD") return;
    if (!writeLimiter.tryAcquire(req.ip)) {
      recordRateLimitRejection();
      const retryAfter = writeLimiter.retryAfterSeconds(req.ip);
      logThrottled("429-write", 10_000, (held) =>
        log.warn(
          "http",
          `429: write budget exceeded for ${req.ip} (retry in ${retryAfter}s)${held ? ` (+${held} more not logged)` : ""}`,
        ),
      );
      void reply.header("Retry-After", String(retryAfter));
      return reply.status(429).send({ error: "Too many write requests" });
    }
  });

  // Authenticated (registered after registerAuth), exempt from both rate
  // limiters above like /health — a scrape interval must never be able to
  // starve itself, or a legitimate client, out of its own diagnostic feed.
  registerMetricsRoute(app);

  // ── Instance registry ───────────────────────────────────────────────
  const opsRegistry = new Map<string, InstanceEntry>();
  for (const [id, cfg] of Object.entries(config.instances)) {
    opsRegistry.set(id, Object.assign(createOperations(cfg), { cfg }));
  }

  const logStreamAPI = initLogStream(config.instances);

  registerInstanceRoutes(app, opsRegistry, logStreamAPI);

  registerManifestRoute(app, routes);

  // Framework errors (413, malformed JSON, 415, schema validation) use the
  // same `{ error }` shape as every route. Anything else is a fault: logged
  // here, never described to the client.
  app.setErrorHandler((err: FastifyError & { error?: unknown }, req, reply) => {
    const status = err.statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      const message = typeof err.error === "string" ? err.error : err.message;
      void reply.status(status).send({ error: message });
      return;
    }
    log.error("http", `${req.method} ${req.routeOptions.url ?? UNMATCHED_ROUTE}: ${err.message}`);
    void reply.status(500).send({ error: "Internal server error" });
  });

  // Historical `{ error }` body shape on unknown routes.
  app.setNotFoundHandler((_req, reply) => {
    void reply.status(404).send({ error: "Not found" });
  });

  return { app, logStreamAPI, routeSpecs };
}
