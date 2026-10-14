/**
 * W-002 — an aborted request must give its in-flight slot back.
 *
 * Fastify skips onResponse when the client closed the socket before the
 * reply went out, so the slot leaked; after MAX_IN_FLIGHT aborts every
 * route but /health and /metrics answered 503 until a restart.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import { buildApp } from "../../src/http/app.js";
import { getInFlight } from "../../src/platform/metrics.js";
import type { AppConfig } from "../../src/config/types.js";
import type { FastifyInstance } from "fastify";

const KEY = "aborted-inflight-test-key-0123456789abc";
const ABORTS = 40; // more than MAX_IN_FLIGHT (32)

let app: FastifyInstance;
let dispose: () => void;
let port: number;

beforeAll(async () => {
  const config: AppConfig = { PORT: 0, API_KEY: KEY, instances: {} };
  const built = await buildApp({ config, allowNoAuth: false });
  app = built.app;
  dispose = built.logStreamAPI.dispose;
  // A route that answers only after its client has given up.
  app.get("/test/slow", async () => {
    await new Promise((r) => setTimeout(r, 300));
    return { ok: true };
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as { port: number }).port;
}, 15_000);

afterAll(async () => {
  dispose();
  await app.close();
});

function get(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path, headers: { "x-api-key": KEY } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      })
      .on("error", reject);
  });
}

function abortAfterSend(path: string): Promise<void> {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path, headers: { "x-api-key": KEY } });
    req.on("error", () => {});
    setTimeout(() => {
      req.destroy();
      resolve();
    }, 50);
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("in-flight slots (W-002)", () => {
  it("are released for requests whose client hung up", async () => {
    const before = getInFlight();
    await Promise.all(Array.from({ length: ABORTS }, () => abortAfterSend("/test/slow")));
    // Let the slow handlers finish writing into the closed sockets.
    await wait(500);
    expect(getInFlight()).toBe(before);
    expect(await get("/test/slow")).toBe(200);
    expect(getInFlight()).toBe(before);
  });
});
