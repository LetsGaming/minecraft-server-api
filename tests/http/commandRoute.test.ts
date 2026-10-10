import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerInstanceRoutes } from "../../src/http/routes/instance/index.js";
import { CommandDeliveryError } from "../../src/instances/commands.js";
import type { Operations } from "../../src/instances/operations.js";
import type { LogStreamAPI } from "../../src/platform/logStream.js";
import type { InstanceConfig } from "../../src/config/types.js";

let app: FastifyInstance;
let next: () => Promise<unknown>;

beforeAll(async () => {
  app = Fastify({ logger: false });
  const entry = {
    sendCommand: () => next(),
    cfg: {} as InstanceConfig,
  } as unknown as Operations & { cfg: InstanceConfig };
  const logStreamAPI: LogStreamAPI = {
    addClient: () => true,
    removeClient: () => {},
    dispose: () => {},
  };
  registerInstanceRoutes(app, new Map([["survival", entry]]), logStreamAPI);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

function post() {
  return app.inject({
    method: "POST",
    url: "/instances/survival/command",
    payload: { command: "list" },
  });
}

describe("POST /instances/:id/command", () => {
  it("answers an RCON reply with via rcon", async () => {
    next = async () => ({ result: "There are 0 players", via: "rcon", sent: true });
    const res = await post();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ result: "There are 0 players", via: "rcon", sent: true });
  });

  it("answers a screen send with a null result and the RCON error", async () => {
    next = async () => ({ result: null, via: "screen", sent: true, rconError: "refused" });
    const res = await post();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      result: null,
      via: "screen",
      sent: true,
      rconError: "refused",
    });
  });

  it("answers 502 when neither channel delivered, without detail", async () => {
    next = async () => {
      throw new CommandDeliveryError("screen send failed", "rcon at 10.1.2.3 refused");
    };
    const res = await post();
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "Command could not be delivered to the server" });
  });
});
