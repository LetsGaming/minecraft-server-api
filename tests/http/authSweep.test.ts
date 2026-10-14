/**
 * Every route but /health answers 401 without the key: a sweep over the
 * routes this process actually serves, so a new route cannot quietly skip
 * the auth hook.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { buildApp } from "../../src/http/app.js";
import type { AppConfig } from "../../src/config/types.js";
import type { FastifyInstance } from "fastify";

let root: string;
let app: FastifyInstance;
let dispose: () => void;
let routes: Array<{ method: string; url: string }>;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "authsweep-"));
  const config: AppConfig = {
    PORT: 0,
    API_KEY: "auth-sweep-test-key-0123456789abcdef",
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
  routes = built.routeSpecs.map((r) => ({ method: r.method, url: r.url }));
  await app.ready();
});

afterAll(async () => {
  dispose();
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const PUBLIC = new Set(["GET /health"]);

describe("authentication sweep", () => {
  it("covers a real route list", () => {
    expect(routes.length).toBeGreaterThan(20);
  });

  it("refuses every non-public route without the key", async () => {
    const open: string[] = [];
    let n = 0;
    for (const { method, url } of routes) {
      n++;
      if (PUBLIC.has(`${method} ${url}`)) continue;
      const concrete = url
        .replace(":id", "survival")
        .replace(/:[A-Za-z]+/g, "x");
      const res = await app.inject({
        method: method as "GET",
        url: concrete,
        // One address each, so the failed-auth limiter (20 per IP) never
        // answers in place of the auth check this sweep is about.
        remoteAddress: `10.9.${n >> 8}.${n & 255}`,
        ...(method === "GET" || method === "DELETE" ? {} : { payload: {} }),
      });
      if (res.statusCode !== 401) open.push(`${method} ${url} -> ${res.statusCode}`);
    }
    expect(open).toEqual([]);
  });
});
