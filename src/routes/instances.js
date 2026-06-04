"use strict";

const express = require("express");

// F-001: strict UUID allowlist
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateUuid(req, res, next) {
  if (!UUID_RE.test(req.params.uuid)) {
    res.status(400).json({ error: "Invalid UUID" });
    return;
  }
  next();
}

// F-001: safe args pattern
const SAFE_ARG = /^[\w.@/-]{1,128}$/;

function validateArgs(args) {
  if (args === undefined || args === null) return true;
  return (
    Array.isArray(args) &&
    args.length <= 5 &&
    args.every((a) => typeof a === "string" && SAFE_ARG.test(a))
  );
}

/**
 * Create the /instances router.
 *
 * @param {Map<string, object>} opsRegistry  – instance id → operations bundle
 * @param {{ addClient(id, res): void, removeClient(id, res): void }} logStreamAPI
 */
function createRouter(opsRegistry, logStreamAPI) {
  const router = express.Router();

  // Resolve the instance and attach its ops to the request.
  // Returns 404 for any unknown instance id.
  function instanceGuard(req, res, next) {
    const ops = opsRegistry.get(req.params.id);
    if (!ops) {
      res.status(404).json({ error: "Instance not found" });
      return;
    }
    req.ops        = ops;
    req.instanceId = req.params.id;
    next();
  }

  // ── Log routes ──────────────────────────────────────────────────────────

  router.get("/:id/logs/tail", instanceGuard, async (req, res) => {
    // F-009: parseInt blocks "1e6" bypass; clamp to [1, 500]
    const rawLines = parseInt(req.query.lines ?? "10", 10);
    const lines    = Number.isNaN(rawLines) ? 10 : Math.min(Math.max(rawLines, 1), 500);
    try {
      res.json({ output: await req.ops.tailLog(lines) });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.get("/:id/logs/stream", instanceGuard, (req, res) => {
    res.setHeader("Content-Type",  "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection",    "keep-alive");
    res.flushHeaders();

    const hb = setInterval(() => {
      try {
        res.write(":heartbeat\n\n");
      } catch {
        clearInterval(hb);
      }
    }, 20_000);

    logStreamAPI.addClient(req.instanceId, res);
    req.on("close", () => {
      clearInterval(hb);
      logStreamAPI.removeClient(req.instanceId, res);
    });
  });

  // ── Server info routes ──────────────────────────────────────────────────

  router.get("/:id/whitelist", instanceGuard, (_req, res) => {
    try {
      res.json({ whitelist: _req.ops.getWhitelist() });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.get("/:id/level-name", instanceGuard, async (req, res) => {
    try {
      res.json({ levelName: await req.ops.getLevelName() });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.get("/:id/mods", instanceGuard, (req, res) => {
    // F-008: null means file not found → 404
    try {
      const result = req.ops.getModSlugs();
      if (result === null) return res.status(404).json({ error: "Mod list not found" });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.get("/:id/backups", instanceGuard, (req, res) => {
    try {
      res.json(req.ops.getBackups());
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Stats routes ────────────────────────────────────────────────────────

  router.get("/:id/stats", instanceGuard, async (req, res) => {
    try {
      res.json({ uuids: await req.ops.listStatsUuids() });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.get("/:id/stats/:uuid", instanceGuard, validateUuid, async (req, res) => {
    try {
      const stats = await req.ops.getStats(req.params.uuid);
      if (stats === null) return res.status(404).json({ error: "Stats not found" });
      res.json({ stats });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Runtime routes ──────────────────────────────────────────────────────

  router.get("/:id/running", instanceGuard, async (req, res) => {
    try {
      res.json({ running: await req.ops.isRunning() });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.get("/:id/list", instanceGuard, async (req, res) => {
    try {
      res.json(await req.ops.getList());
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.get("/:id/tps", instanceGuard, async (req, res) => {
    try {
      res.json({ tps: await req.ops.getTps() });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Command & script routes ─────────────────────────────────────────────

  router.post("/:id/command", instanceGuard, async (req, res) => {
    const { command } = req.body;
    // A-08: validate type and length
    if (!command || typeof command !== "string") {
      res.status(400).json({ error: "Missing command" });
      return;
    }
    if (command.length > 256) {
      res.status(400).json({ error: "command must be ≤ 256 characters" });
      return;
    }
    try {
      res.json({ result: await req.ops.sendCommand(command) });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post("/:id/scripts/run", instanceGuard, async (req, res) => {
    const { action, args } = req.body;
    if (!action) {
      res.status(400).json({ error: "Missing action" });
      return;
    }
    // F-001: validate args before passing to spawn()
    if (!validateArgs(args)) {
      res.status(400).json({
        error:
          "Invalid args: must be an array of up to 5 strings containing only " +
          "alphanumeric, '.', '@', '/', or '-' characters (max 128 chars each)",
      });
      return;
    }
    try {
      res.json(await req.ops.runScript(action, args));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  return router;
}

module.exports = { createRouter };
