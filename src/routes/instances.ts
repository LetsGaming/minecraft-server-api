/**
 * /instances routes. Thin: validation + dispatch into the per-instance
 * operations bundle. Error bodies keep the historical `{ error }` shape
 * the bot's helpers surface verbatim.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Operations } from "../operations.js";
import type { InstanceConfig } from "../types.js";
import type { LogStreamAPI } from "../logStream.js";
import { SCRIPT_MAP } from "../operations.js";
import { getHostInfo } from "../hostInfo.js";
import { WRAPPER_VERSION } from "../version.js";
import { log } from "../logger.js";

// SEC-05: 500 bodies used to carry String(err) — absolute paths, sudo
// and stderr fragments included. Detail goes to the wrapper log; the
// client gets a fixed body (the historical `{ error }` shape is kept).
function internalError(
  reply: FastifyReply,
  context: string,
  err: unknown,
): FastifyReply {
  const msg = err instanceof Error ? err.message : String(err);
  log.error("routes", `${context}: ${msg}`);
  return reply.status(500).send({ error: "Internal server error" });
}

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
      return internalError(reply, `info ${req.params.id}`, err);
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
        return internalError(reply, `logs/tail ${req.params.id}`, err);
      }
    },
  );

  app.get<{ Params: InstanceParams }>(`${P}/logs/stream`, (req, reply) => {
    const entry = resolve(req, reply);
    if (!entry) return;

    // SEC-02: register (and cap-check) BEFORE hijacking so the over-cap
    // case is still a normal Fastify reply. Nothing is written to the
    // stored response until the next log line, and hijack + writeHead
    // happen synchronously below — no fan-out can interleave.
    if (!logStreamAPI.addClient(req.params.id, reply.raw)) {
      return reply
        .status(503)
        .send({ error: "Too many log stream clients for this instance" });
    }

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
      return internalError(reply, `whitelist ${req.params.id}`, err);
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
      return internalError(reply, `usercache ${req.params.id}`, err);
    }
  });

  app.get<{ Params: InstanceParams }>(`${P}/level-name`, async (req, reply) => {
    const entry = resolve(req, reply);
    if (!entry) return;
    try {
      return { levelName: await entry.getLevelName() };
    } catch (err) {
      return internalError(reply, `level-name ${req.params.id}`, err);
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
      return internalError(reply, `mods ${req.params.id}`, err);
    }
  });

  app.get<{ Params: InstanceParams }>(`${P}/backups`, async (req, reply) => {
    const entry = resolve(req, reply);
    if (!entry) return;
    try {
      return entry.getBackups();
    } catch (err) {
      return internalError(reply, `backups ${req.params.id}`, err);
    }
  });

  // ── Capabilities (M-13) ─────────────────────────────────────────────────
  app.get<{ Params: InstanceParams }>(`${P}/capabilities`, async (req, reply) => {
    const entry = resolve(req, reply);
    if (!entry) return;
    try {
      return entry.getCapabilities();
    } catch (err) {
      return internalError(reply, `capabilities ${req.params.id}`, err);
    }
  });

  // ── Stats routes ────────────────────────────────────────────────────────

  app.get<{ Params: InstanceParams }>(`${P}/stats`, async (req, reply) => {
    const entry = resolve(req, reply);
    if (!entry) return;
    try {
      return { uuids: await entry.listStatsUuids() };
    } catch (err) {
      return internalError(reply, `stats ${req.params.id}`, err);
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
        return internalError(reply, `stats/:uuid get ${req.params.id}`, err);
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
        return internalError(reply, `stats/:uuid delete ${req.params.id}`, err);
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
      return internalError(reply, `running ${req.params.id}`, err);
    }
  });

  app.get<{ Params: InstanceParams }>(`${P}/list`, async (req, reply) => {
    const entry = resolve(req, reply);
    if (!entry) return;
    try {
      return await entry.getList();
    } catch (err) {
      return internalError(reply, `list ${req.params.id}`, err);
    }
  });

  app.get<{ Params: InstanceParams }>(`${P}/tps`, async (req, reply) => {
    const entry = resolve(req, reply);
    if (!entry) return;
    try {
      return { tps: await entry.getTps() };
    } catch (err) {
      return internalError(reply, `tps ${req.params.id}`, err);
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
        return internalError(reply, `command ${req.params.id}`, err);
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
      // SEC-05 companion: an unknown action is CLIENT input error, not an
      // internal failure — reject it here with a helpful 400 (echoing the
      // client's own input is safe) instead of letting runScript throw
      // into the generic-500 path and losing the feedback the bot
      // surfaces to admins.
      if (!(action in SCRIPT_MAP)) {
        return reply
          .status(400)
          .send({ error: `Unknown script action: ${action.slice(0, 64)}` });
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
        return internalError(reply, `scripts/run ${req.params.id}`, err);
      }
    },
  );
}
