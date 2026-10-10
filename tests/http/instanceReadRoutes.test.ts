import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerInstanceRoutes } from "../../src/http/routes/instance/index.js";
import type { Operations } from "../../src/instances/operations.js";
import type { LogStreamAPI } from "../../src/platform/logStream.js";
import type { InstanceConfig } from "../../src/config/types.js";

let app: FastifyInstance;
const entry = {
  cfg: {} as InstanceConfig,
  getList: vi.fn(),
  getWhitelist: vi.fn(),
  getUserCache: vi.fn(),
  getLevelName: vi.fn(),
  getBackups: vi.fn(),
  getHealth: vi.fn(),
  isRunning: vi.fn(),
  getTps: vi.fn(),
};

beforeAll(async () => {
  app = Fastify({ logger: false });
  const logStreamAPI: LogStreamAPI = {
    addClient: () => true,
    removeClient: () => {},
    dispose: () => {},
  };
  registerInstanceRoutes(
    app,
    new Map([["survival", entry as unknown as Operations & { cfg: InstanceConfig }]]),
    logStreamAPI,
  );
  await app.ready();
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  for (const fn of Object.values(entry)) if (typeof fn === "function") (fn as ReturnType<typeof vi.fn>).mockReset();
});

const get = (url: string) => app.inject({ method: "GET", url });

const routes: Array<[string, keyof typeof entry, unknown, unknown]> = [
  ["list", "getList", { playerCount: "1", maxPlayers: "20", players: ["Steve"] }, { playerCount: "1", maxPlayers: "20", players: ["Steve"] }],
  ["whitelist", "getWhitelist", [{ uuid: "u", name: "Steve" }], { whitelist: [{ uuid: "u", name: "Steve" }] }],
  ["usercache", "getUserCache", [{ uuid: "u", name: "Steve" }], { usercache: [{ uuid: "u", name: "Steve" }] }],
  ["level-name", "getLevelName", "world", { levelName: "world" }],
  ["running", "isRunning", true, { running: true }],
  ["tps", "getTps", { type: "vanilla", tps1m: 19.5, tps5m: 19.5, tps15m: 19.5, mspt: 40, raw: "r" }, { tps: { type: "vanilla", tps1m: 19.5, tps5m: 19.5, tps15m: 19.5, mspt: 40, raw: "r" } }],
];

describe.each(routes)("GET /instances/:id/%s", (route, method, value, body) => {
  it("wraps the instance result in the documented envelope", async () => {
    (entry[method] as ReturnType<typeof vi.fn>).mockResolvedValue(value);
    const res = await get(`/instances/survival/${route}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(body);
  });

  it("404s an unknown instance without calling anything", async () => {
    const res = await get(`/instances/nope/${route}`);
    expect(res.statusCode).toBe(404);
    expect(entry[method]).not.toHaveBeenCalled();
  });

  it("answers a failure with a generic 500 that hides the cause", async () => {
    (entry[method] as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("EACCES /srv/secret"));
    const res = await get(`/instances/survival/${route}`);
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("/srv/secret");
  });
});

describe("GET /instances/:id/tps", () => {
  it("reports a null tps when the server gave none", async () => {
    entry.getTps.mockResolvedValue(null);
    expect((await get("/instances/survival/tps")).json()).toEqual({ tps: null });
  });
});

describe("GET /instances/:id/health", () => {
  it("returns the three-state health", async () => {
    const health = {
      state: "unresponsive",
      processUp: true,
      probe: "rcon",
      rcon: { configured: true, responsive: false, lastSuccessMsAgo: null },
      gamePort: 25565,
      restartCount: 0,
      unitFailed: false,
      checkedAt: 1,
      ageMs: 2,
    };
    entry.getHealth.mockResolvedValue(health);
    const res = await get("/instances/survival/health");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(health);
  });

  it("404s an unknown instance and 500s a failure", async () => {
    expect((await get("/instances/nope/health")).statusCode).toBe(404);
    entry.getHealth.mockRejectedValue(new Error("x"));
    expect((await get("/instances/survival/health")).statusCode).toBe(500);
  });
});

describe("GET /instances/:id/backups", () => {
  it("404s an unknown instance and 500s a failure", async () => {
    expect((await get("/instances/nope/backups")).statusCode).toBe(404);
    entry.getBackups.mockRejectedValue(new Error("x"));
    expect((await get("/instances/survival/backups")).statusCode).toBe(500);
  });
});
