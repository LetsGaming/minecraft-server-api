/**
 * /instances routes. Thin: validation + dispatch into the per-instance
 * operations bundle. Error bodies keep the historical `{ error }` shape
 * the bot's helpers surface verbatim.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Operations } from "../operations.js";
import type { InstanceConfig } from "../types.js";
import type { LogStreamAPI } from "../logStream.js";
import { getHostInfo } from "../hostInfo.js";
import { WRAPPER_VERSION } from "../version.js";

// F-001: strict UUID allowlist
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// F-001: safe args pattern — no forward-slash to prevent relative-path
// traversal (e.g. "../../evil.sh") in script arguments. Scripts that
// legitimately need a path argument should receive it via instance config.
const SAFE_ARG = /^[\w.@-]{1,128}$/;

export function validateArgs(args: unknown): args is string[] | undefined {
  if (args === undefined || args === null) return true;
  return (
    Array.isArray(args) &&
    args.length <= 5 &&
    args.every((a) => typeof a === "string" && SAFE_ARG.test(a))
  );
}

// F-009: parseInt blocks "1e6" bypass; clamp to [1, 500]
export function sanitizeLines(raw: unknown): number {
  const parsed = parseInt(String(raw ?? "10"), 10);
  return Number.isNaN(parsed) ? 10 : Math.min(Math.max(parsed, 1), 500);
}

interface InstanceParams {
  id: string;
}

export function registerInstanceRoutes(
  app: FastifyInstance,
  opsRegistry: Map<string, Operations & { cfg: InstanceConfig }>,
  logStreamAPI: LogStreamAPI,
): void {
  // ── GET /instances ──────────────────────────────────────────────────────
  // Configured instance IDs so clients can discover what is deployed
  // without out-of-band configuration.
  app.get("/instances", async () => ({
    instances: [...opsRegistry.keys()].map((id) => ({ id })),
  }));

  // Resolve the instance for every /instances/:id/* route; 404 unknown ids.
  function resolve(
    req: FastifyRequest<{ Params: InstanceParams }>,
    reply: FastifyReply,
  ) {
    const entry = opsRegistry.get(req.params.id);
    if (!entry) {
      void reply.status(404).send({ error: "Instance not found" });
      return null;
    }
    return entry;
  }

  const P = "/instances/:id";

  // ── Info: version handshake + host metrics ──────────────────────────────
  // The wrapper half of the bot's "remote host metrics + version
  // handshake" feature (bot: serverAccess.getRemoteInfo, MIN_WRAPPER_VERSION).
  // `version` lets the bot verify compatibility at startup; `host` feeds
  // the status view and the disk-space alerts for remote instances.
  app.get<{ Params: InstanceParams }>(`${P}/info`, async (req, reply) => {
    const entry = resolve(req, reply);
    if (!entry) return;
    try {
      return { version: WRAPPER_VERSION, host: await getHostInfo(entry.cfg) };
    } catch (err) {
      return reply.status(500).send({ error: String(err) });
    }
  });

  // ── Log routes ──────────────────────────────────────────────────────────

  app.get<{ Params: InstanceParams; Querystring: { lines?: string } }>(
    `${P}/logs/tail`,
    async (req, reply) => {
      const entry = resolve(req, reply);
      if (!entry) return;
      const lines = sanitizeLines(req.query.lines);
      try {
        return { output: await entry.tailLog(lines) };
      } catch (err) {
        return reply.status(500).send({ error: String(err) });
      }
    },
  );

  app.get<{ Params: InstanceParams }>(`${P}/logs/stream`, (req, reply) => {
    const entry = resolve(req, reply);
    if (!entry) return;

    // SSE: take over the raw socket; Fastify must not touch the reply after this.
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(":connected\n\n");

    const hb = setInterval(() => {
      try {
        res.write(":heartbeat\n\n");
      } catch {
        clearInterval(hb);
      }
    }, 20_000);

    logStreamAPI.addClient(req.params.id, res);
    req.raw.on("close", () => {
      clearInterval(hb);
      logStreamAPI.removeClient(req.params.id, res);
    });
  });

  // ── Server info routes ──────────────────────────────────────────────────

  app.get<{ Params: InstanceParams }>(`${P}/whitelist`, async (req, reply) => {
    const entry = resolve(req, reply);
    if (!entry) return;
    try {
      return { whitelist: entry.getWhitelist() };
    } catch (err) {
      return reply.status(500).send({ error: String(err) });
    }
  });

  // usercache.json — every player the server has ever seen. The bot uses
  // this as a best-effort name source on top of the whitelist
  // (serverAccess.readUserCache; older wrappers without the route → []).
  app.get<{ Params: InstanceParams }>(`${P}/usercache`, async (req, reply) => {
    const entry = resolve(req, reply);
    if (!entry) return;
    try {
      return { usercache: entry.getUserCache() };
    } catch (err) {
      return reply.status(500).send({ error: String(err) });
    }
  });

  app.get<{ Params: InstanceParams }>(`${P}/level-name`, async (req, reply) => {
    const entry = resolve(req, reply);
    if (!entry) return;
    try {
      return { levelName: await entry.getLevelName() };
    } catch (err) {
      return reply.status(500).send({ error: String(err) });
    }
  });

  app.get<{ Params: InstanceParams }>(`${P}/mods`, async (req, reply) => {
    const entry = resolve(req, reply);
    if (!entry) return;
    // F-008: null means file not found → 404
    try {
      const result = entry.getModSlugs();
      if (result === null) {
        return reply.status(404).send({ error: "Mod list not found" });
      }
      return result;
    } catch (err) {
      return reply.status(500).send({ error: String(err) });
    }
  });

  app.get<{ Params: InstanceParams }>(`${P}/backups`, async (req, reply) => {
    const entry = resolve(req, reply);
    if (!entry) return;
    try {
      return entry.getBackups();
    } catch (err) {
      return reply.status(500).send({ error: String(err) });
    }
  });

  // ── Capabilities (M-13) ─────────────────────────────────────────────────
  app.get<{ Params: InstanceParams }>(`${P}/capabilities`, async (req, reply) => {
    const entry = resolve(req, reply);
    if (!entry) return;
    try {
      return entry.getCapabilities();
    } catch (err) {
      return reply.status(500).send({ error: String(err) });
    }
  });

  // ── Stats routes ────────────────────────────────────────────────────────

  app.get<{ Params: InstanceParams }>(`${P}/stats`, async (req, reply) => {
    const entry = resolve(req, reply);
    if (!entry) return;
    try {
      return { uuids: await entry.listStatsUuids() };
    } catch (err) {
      return reply.status(500).send({ error: String(err) });
    }
  });

  app.get<{ Params: InstanceParams & { uuid: string } }>(
    `${P}/stats/:uuid`,
    async (req, reply) => {
      const entry = resolve(req, reply);
      if (!entry) return;
      if (!UUID_RE.test(req.params.uuid)) {
        return reply.status(400).send({ error: "Invalid UUID" });
      }
      try {
        const stats = await entry.getStats(req.params.uuid);
        if (stats === null) {
          return reply.status(404).send({ error: "Stats not found" });
        }
        return { stats };
      } catch (err) {
        return reply.status(500).send({ error: String(err) });
      }
    },
  );

  // H-05 companion: explicit stats deletion for the bot's admin-gated
  // `/server prune-stats`. UUID allowlist (F-001) + path guard in ops.
  app.delete<{ Params: InstanceParams & { uuid: string } }>(
    `${P}/stats/:uuid`,
    async (req, reply) => {
      const entry = resolve(req, reply);
      if (!entry) return;
      if (!UUID_RE.test(req.params.uuid)) {
        return reply.status(400).send({ error: "Invalid UUID" });
      }
      try {
        return { deleted: await entry.deleteStats(req.params.uuid) };
      } catch (err) {
        return reply.status(500).send({ error: String(err) });
      }
    },
  );

  // ── Runtime routes ──────────────────────────────────────────────────────

  app.get<{ Params: InstanceParams }>(`${P}/running`, async (req, reply) => {
    const entry = resolve(req, reply);
    if (!entry) return;
    try {
      return { running: await entry.isRunning() };
    } catch (err) {
      return reply.status(500).send({ error: String(err) });
    }
  });

  app.get<{ Params: InstanceParams }>(`${P}/list`, async (req, reply) => {
    const entry = resolve(req, reply);
    if (!entry) return;
    try {
      return await entry.getList();
    } catch (err) {
      return reply.status(500).send({ error: String(err) });
    }
  });

  app.get<{ Params: InstanceParams }>(`${P}/tps`, async (req, reply) => {
    const entry = resolve(req, reply);
    if (!entry) return;
    try {
      return { tps: await entry.getTps() };
    } catch (err) {
      return reply.status(500).send({ error: String(err) });
    }
  });

  // ── Command & script routes ─────────────────────────────────────────────

  app.post<{ Params: InstanceParams; Body: { command?: unknown } }>(
    `${P}/command`,
    async (req, reply) => {
      const entry = resolve(req, reply);
      if (!entry) return;
      const command = req.body?.command;
      // A-08: validate type and length
      if (!command || typeof command !== "string") {
        return reply.status(400).send({ error: "Missing command" });
      }
      if (command.length > 256) {
        return reply.status(400).send({ error: "command must be ≤ 256 characters" });
      }
      try {
        return { result: await entry.sendCommand(command) };
      } catch (err) {
        return reply.status(500).send({ error: String(err) });
      }
    },
  );

  app.post<{ Params: InstanceParams; Body: { action?: unknown; args?: unknown } }>(
    `${P}/scripts/run`,
    async (req, reply) => {
      const entry = resolve(req, reply);
      if (!entry) return;
      const action = req.body?.action;
      const args = req.body?.args;
      if (!action || typeof action !== "string") {
        return reply.status(400).send({ error: "Missing action" });
      }
      // F-001: validate args before passing to spawn()
      if (!validateArgs(args)) {
        return reply.status(400).send({
          error:
            "Invalid args: must be an array of up to 5 strings containing only " +
            "alphanumeric, '.', '@', or '-' characters (max 128 chars each)",
        });
      }
      try {
        return await entry.runScript(action, args);
      } catch (err) {
        return reply.status(500).send({ error: String(err) });
      }
    },
  );
}
