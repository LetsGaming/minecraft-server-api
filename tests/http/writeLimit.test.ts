import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { buildApp } from "../../src/http/app.js";
import {
  WriteRateLimiter,
  WRITE_LIMIT_MAX,
  WRITE_LIMIT_WINDOW_MS,
} from "../../src/http/writeRateLimit.js";
import type { AppConfig } from "../../src/config/types.js";
import type { FastifyInstance } from "fastify";

const KEY = "write-limit-test-key-0123456789ab";

let root: string;
let app: FastifyInstance;
let dispose: () => void;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "wl-"));
  const config: AppConfig = {
    PORT: 0,
    API_KEY: KEY,
    instances: {
      survival: {
        id: "survival",
        serverPath: path.join(root, "server"),
        linuxUser: "minecraft",
        useRcon: false,
        rconHost: "localhost",
        rconPort: 25575,
        rconPassword: "",
        backupsPath: "",
        scriptsDir: path.join(root, "scripts"),
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

const post = (key: string) =>
  app.inject({
    method: "POST",
    url: "/instances/survival/command",
    headers: { "x-api-key": key },
    payload: {},
  });

describe("write rate limit ordering", () => {
  it("does not charge unauthenticated POSTs to the shared client budget", async () => {
    for (let i = 0; i < WRITE_LIMIT_MAX + 5; i++) {
      expect((await post("wrong-key")).statusCode).toBe(401);
    }
    for (let i = 0; i < WRITE_LIMIT_MAX; i++) {
      expect((await post(KEY)).statusCode).toBe(400);
    }
    expect((await post(KEY)).statusCode).toBe(429);
  });
});

describe("WriteRateLimiter", () => {
  it("evicts idle IPs once the table is large", () => {
    vi.useFakeTimers();
    try {
      const limiter = new WriteRateLimiter();
      for (let i = 0; i < 10_050; i++) limiter.tryAcquire(`10.0.${i >> 8}.${i & 255}`);
      expect(limiter.size()).toBe(10_050);
      vi.advanceTimersByTime(WRITE_LIMIT_WINDOW_MS + 1);
      limiter.tryAcquire("192.168.0.1");
      expect(limiter.size()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
