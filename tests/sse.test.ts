/**
 * SSE log stream over a real socket — the exact contract the bot's
 * RemoteLogWatcher consumes: `data: {"line": "...", "serverId": "..."}`
 * events for appended log lines, comment heartbeats keeping proxies
 * alive. inject() can't hold a streaming response open, so this suite
 * listens on an ephemeral port.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/types.js";
import type { FastifyInstance } from "fastify";

const KEY = "sse-test-key";

let root: string;
let logFile: string;
let app: FastifyInstance;
let dispose: () => void;
let base: string;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sse-"));
  const serverPath = path.join(root, "server");
  fs.mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  logFile = path.join(serverPath, "logs", "latest.log");
  fs.writeFileSync(logFile, "old line\n");

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
  const addr = app.server.address();
  if (typeof addr === "object" && addr) base = `http://127.0.0.1:${addr.port}`;
}, 15_000);

afterAll(async () => {
  dispose();
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("GET /instances/:id/logs/stream", () => {
  it("streams appended lines as bot-shaped SSE events", async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/instances/survival/logs/stream`, {
      headers: { "x-api-key": KEY },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // The connect preamble arrives immediately.
    const first = await reader.read();
    buffer += decoder.decode(first.value, { stream: true });
    expect(buffer).toContain(":connected");

    // Append after the stream is attached — the watcher/poller picks it up.
    fs.appendFileSync(logFile, "Server thread/INFO: Steve joined the game\n");

    const deadline = Date.now() + 5_000;
    let event: { line: string; serverId: string } | null = null;
    while (Date.now() < deadline && !event) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const m = /data: (\{.*\})/.exec(buffer);
      if (m) event = JSON.parse(m[1]!) as { line: string; serverId: string };
    }

    controller.abort();
    expect(event).not.toBeNull();
    expect(event!.serverId).toBe("survival");
    expect(event!.line).toContain("Steve joined the game");
  }, 10_000);

  it("requires the API key", async () => {
    const res = await fetch(`${base}/instances/survival/logs/stream`);
    expect(res.status).toBe(401);
  });
});
