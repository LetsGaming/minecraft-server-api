/**
 * Route-level integration through app.inject(): auth (SEC-01 semantics),
 * the auth-failure limiter, and every endpoint against a real scaffolded
 * instance directory — including the new /info handshake and /usercache.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { buildApp, AuthFailTracker, keyMatches } from "../src/app.js";
import { WRAPPER_VERSION } from "../src/version.js";
import type { AppConfig } from "../src/types.js";
import type { FastifyInstance } from "fastify";

const KEY = "test-key-0123456789";
const UUID = "069a79f4-44e9-4726-a5be-fca90e38aaf5";

let root: string;
let app: FastifyInstance;
let dispose: () => void;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "app-"));
  const serverPath = path.join(root, "server");
  const scriptsDir = path.join(root, "scripts");
  const backupsPath = path.join(root, "backups");
  fs.mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  fs.mkdirSync(path.join(serverPath, "world", "stats"), { recursive: true });
  fs.mkdirSync(path.join(backupsPath, "hourly"), { recursive: true });
  fs.mkdirSync(path.join(scriptsDir, "common"), { recursive: true });

  fs.writeFileSync(path.join(serverPath, "server.properties"), "level-name=world\n");
  fs.writeFileSync(
    path.join(serverPath, "whitelist.json"),
    JSON.stringify([{ name: "Steve", uuid: UUID }]),
  );
  fs.writeFileSync(
    path.join(serverPath, "usercache.json"),
    JSON.stringify([
      { name: "Steve", uuid: UUID, expiresOn: "x" },
      { bogus: true },
    ]),
  );
  fs.writeFileSync(
    path.join(serverPath, "world", "stats", `${UUID}.json`),
    JSON.stringify({ stats: { "minecraft:custom": {} } }),
  );
  fs.writeFileSync(path.join(serverPath, "logs", "latest.log"), "line one\nline two\n");
  fs.writeFileSync(path.join(backupsPath, "hourly", "2026-07-06.tar.zst"), "x");
  fs.writeFileSync(
    path.join(scriptsDir, "common", "downloaded_versions.json"),
    JSON.stringify({ mods: { sodium: {}, lithium: {} } }),
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
});

afterAll(async () => {
  dispose();
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const auth = { "x-api-key": KEY };

describe("auth (SEC-01)", () => {
  it("GET /health is public and reports the version", async () => {
    const res = await app.inject({ url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, version: WRAPPER_VERSION });
  });

  it("rejects a missing key with 401", async () => {
    const res = await app.inject({ url: "/instances" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Unauthorized" });
  });

  it("rejects a wrong key with 401", async () => {
    const res = await app.inject({
      url: "/instances",
      headers: { "x-api-key": "wrong" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts the configured key", async () => {
    const res = await app.inject({ url: "/instances", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ instances: [{ id: "survival" }] });
  });

  it("sets the security headers", async () => {
    const res = await app.inject({ url: "/health" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
  });
});

describe("instance resolution", () => {
  it("404s an unknown instance with the historical body shape", async () => {
    const res = await app.inject({ url: "/instances/nope/running", headers: auth });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Instance not found" });
  });

  it("404s unknown routes with { error }", async () => {
    const res = await app.inject({ url: "/definitely-not-a-route", headers: auth });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Not found" });
  });
});

describe("GET /instances/:id/info (bot handshake)", () => {
  it("reports the wrapper version and host metrics", async () => {
    const res = await app.inject({ url: "/instances/survival/info", headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      version: string;
      host: { process: unknown; disks: Array<{ path: string; usedPercent: number }> };
    };
    expect(body.version).toBe(WRAPPER_VERSION);
    // Real df in this environment — both monitored paths resolve.
    expect(body.host.disks.length).toBeGreaterThan(0);
    for (const d of body.host.disks) {
      expect(Number.isFinite(d.usedPercent)).toBe(true);
    }
    // No java process for user "minecraft" here → null, and that is a
    // valid contract value the bot handles.
    expect("process" in body.host).toBe(true);
  });

  it("satisfies the bot's MIN_WRAPPER_VERSION (1.2.0) handshake", async () => {
    const res = await app.inject({ url: "/instances/survival/info", headers: auth });
    const { version } = res.json() as { version: string };
    const [major] = version.split(".").map(Number);
    expect(major!).toBeGreaterThanOrEqual(2);
  });
});

describe("file-backed routes", () => {
  it("GET /usercache filters to {name, uuid}", async () => {
    const res = await app.inject({ url: "/instances/survival/usercache", headers: auth });
    expect(res.json()).toEqual({ usercache: [{ name: "Steve", uuid: UUID }] });
  });

  it("GET /whitelist returns the file contents", async () => {
    const res = await app.inject({ url: "/instances/survival/whitelist", headers: auth });
    expect(res.json()).toEqual({ whitelist: [{ name: "Steve", uuid: UUID }] });
  });

  it("GET /level-name reads server.properties", async () => {
    const res = await app.inject({ url: "/instances/survival/level-name", headers: auth });
    expect(res.json()).toEqual({ levelName: "world" });
  });

  it("GET /stats lists uuids", async () => {
    const res = await app.inject({ url: "/instances/survival/stats", headers: auth });
    expect(res.json()).toEqual({ uuids: [UUID] });
  });

  it("GET /stats/:uuid returns the stats file", async () => {
    const res = await app.inject({
      url: `/instances/survival/stats/${UUID}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { stats: object }).stats).toBeTruthy();
  });

  it("rejects an invalid uuid with 400 (F-001)", async () => {
    const res = await app.inject({
      url: "/instances/survival/stats/..%2F..%2Fetc%2Fpasswd",
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /mods returns slugs + mtime", async () => {
    const res = await app.inject({ url: "/instances/survival/mods", headers: auth });
    const body = res.json() as { slugs: string[]; mtimeMs: number };
    expect(body.slugs.sort()).toEqual(["lithium", "sodium"]);
    expect(body.mtimeMs).toBeGreaterThan(0);
  });

  it("GET /backups reports the hourly tier", async () => {
    const res = await app.inject({ url: "/instances/survival/backups", headers: auth });
    const body = res.json() as { dirs: Array<{ dir: string }>; totalBytes: number };
    expect(body.dirs.map((d) => d.dir)).toEqual(["hourly"]);
    expect(body.totalBytes).toBeGreaterThan(0);
  });

  it("GET /capabilities matches the bot's shape", async () => {
    const res = await app.inject({ url: "/instances/survival/capabilities", headers: auth });
    const caps = res.json() as { scripts: Record<string, boolean>; modManifest: boolean };
    expect(Object.keys(caps.scripts).sort()).toEqual([
      "backup",
      "restart",
      "start",
      "status",
      "stop",
    ]);
    expect(caps.modManifest).toBe(true);
  });

  it("GET /logs/tail returns the log tail", async () => {
    const res = await app.inject({
      url: "/instances/survival/logs/tail?lines=1",
      headers: auth,
    });
    expect((res.json() as { output: string }).output.trim()).toBe("line two");
  });

  it("DELETE /stats/:uuid removes the file (H-05)", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/instances/survival/stats/${UUID}`,
      headers: auth,
    });
    expect(res.json()).toEqual({ deleted: true });
    const again = await app.inject({
      method: "DELETE",
      url: `/instances/survival/stats/${UUID}`,
      headers: auth,
    });
    expect(again.json()).toEqual({ deleted: false });
  });
});

describe("POST validation", () => {
  it("rejects a missing command (A-08)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/instances/survival/command",
      headers: auth,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Missing command" });
  });

  it("rejects an over-long command (A-08)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/instances/survival/command",
      headers: auth,
      payload: { command: "x".repeat(257) },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects unsafe script args with the documented message (F-001)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/instances/survival/scripts/run",
      headers: auth,
      payload: { action: "start", args: ["../../evil.sh"] },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("Invalid args");
  });

  it("400s an unknown script action with a safe, helpful body (SEC-05)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/instances/survival/scripts/run",
      headers: auth,
      payload: { action: "format-disk" },
    });
    // Client input error, not an internal failure: SEC-05 made genuine
    // 500 bodies generic, so this validation happens up front instead of
    // via runScript's throw.
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("Unknown script action");
  });

  it("rejects bodies over the 4 KB limit (A-07)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/instances/survival/command",
      headers: { ...auth, "content-type": "application/json" },
      payload: JSON.stringify({ command: "x".repeat(5000) }),
    });
    expect(res.statusCode).toBe(413);
  });
});

describe("auth-failure limiter", () => {
  it("blocks after 20 failed attempts from one IP", async () => {
    const tracker = new AuthFailTracker();
    for (let i = 0; i < 20; i++) {
      expect(tracker.isBlocked("10.0.0.1")).toBe(false);
      tracker.recordFailure("10.0.0.1");
    }
    expect(tracker.isBlocked("10.0.0.1")).toBe(true);
    expect(tracker.isBlocked("10.0.0.2")).toBe(false);
  });
});

describe("keyMatches", () => {
  it("accepts the exact key", () => expect(keyMatches(KEY, KEY)).toBe(true));
  it("rejects a different key of equal length", () =>
    expect(keyMatches("x".repeat(KEY.length), KEY)).toBe(false));
  it("rejects length mismatches without throwing", () => {
    expect(keyMatches("", KEY)).toBe(false);
    expect(keyMatches(KEY + "z", KEY)).toBe(false);
  });
});
