/**
 * API-key authentication and the failure limiter that sits in front of it.
 *
 * Split from app.ts because it is the whole of this service's threat model:
 * one key stands between an HTTP client and start/stop plus arbitrary
 * console commands, so everything guarding that key belongs in one file.
 */
import crypto from "crypto";
import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../config/types.js";

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

/**
 * Gate every route except /health. Must be registered after the public
 * routes and before the instance routes.
 */
export function registerAuth(
  app: FastifyInstance,
  config: AppConfig,
  allowNoAuth: boolean,
): void {
  const authFails = new AuthFailTracker();

  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/health") return;

    // SEC-01: only bypass auth in the explicit, loopback-bound no-auth
    // dev mode. In every other case a key exists (enforced at startup).
    if (!config.API_KEY) {
      if (allowNoAuth) return;
      return reply
        .status(503)
        .send({ error: "Server misconfigured: no API key" });
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
}
