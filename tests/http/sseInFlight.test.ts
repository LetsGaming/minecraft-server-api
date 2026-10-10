import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { buildApp } from "../../src/http/app.js";
import { getInFlight } from "../../src/platform/metrics.js";
import type { AppConfig } from "../../src/config/types.js";
import type { FastifyInstance } from "fastify";

const KEY = "sse-inflight-test-key-0123456789abcdef";

let root: string;
let app: FastifyInstance;
let dispose: () => void;
let port: number;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sse-inflight-"));
  const serverPath = path.join(root, "server");
  fs.mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  fs.writeFileSync(path.join(serverPath, "logs", "latest.log"), "x\n");
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
        scriptsDir: path.join(root, "scripts"),
      },
    },
  };
  const built = await buildApp({ config, allowNoAuth: false });
  app = built.app;
  dispose = built.logStreamAPI.dispose;
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as { port: number }).port;
}, 15_000);

afterAll(async () => {
  dispose();
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function openStream(): Promise<http.ClientRequest> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        host: "127.0.0.1",
        port,
        path: "/instances/survival/logs/stream",
        headers: { "x-api-key": KEY },
        agent: false,
      },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`stream open returned ${res.statusCode}`));
          return;
        }
        res.on("data", () => {});
        resolve(req);
      },
    );
    req.on("error", () => {});
  });
}

async function until(cond: () => boolean, ms = 3_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("SSE streams and the in-flight ceiling", () => {
  it("releases the in-flight slot of every closed stream", async () => {
    const streams: http.ClientRequest[] = [];
    for (let i = 0; i < 40; i++) {
      streams.push(await openStream());
    }
    for (const s of streams) s.destroy();
    await until(() => getInFlight() === 0);

    const status = await new Promise<number>((resolve, reject) => {
      http
        .get(
          {
            host: "127.0.0.1",
            port,
            path: "/instances/survival/info",
            headers: { "x-api-key": KEY },
            agent: false,
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        )
        .on("error", reject);
    });
    expect(status).not.toBe(503);
  });
});
