"use strict";

const express = require("express");

const { INSTANCE_NAME } = require("../config");
const ops = require("../operations");
const logStream = require("../logStream");

const router = express.Router();

// Guard: reject any request targeting the wrong instance
function instanceGuard(req, res, next) {
  if (req.params.id !== INSTANCE_NAME) {
    res.status(404).json({ error: "Instance not found" });
    return;
  }
  next();
}

// F-001: strict UUID allowlist — only accept canonical lowercase UUIDs.
// Applied on every route that uses :uuid to prevent path-traversal attacks.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateUuid(req, res, next) {
  if (!UUID_RE.test(req.params.uuid)) {
    res.status(400).json({ error: "Invalid UUID" });
    return;
  }
  next();
}

// F-001: safe args pattern — only alphanumeric plus a small set of
// path-safe punctuation, max 5 items, max 128 chars each.
const SAFE_ARG = /^[\w.@/-]{1,128}$/;

function validateArgs(args) {
  if (args === undefined || args === null) return true;
  return (
    Array.isArray(args) &&
    args.length <= 5 &&
    args.every((a) => typeof a === "string" && SAFE_ARG.test(a))
  );
}

// ── Log routes ────────────────────────────────────────────────────────────

router.get("/:id/logs/tail", instanceGuard, async (req, res) => {
  // F-009: parse as integer (blocks "1e6" bypass) and clamp to [1, 500]
  const rawLines = parseInt(req.query.lines ?? "10", 10);
  const lines = Number.isNaN(rawLines) ? 10 : Math.min(Math.max(rawLines, 1), 500);
  try {
    res.json({ output: await ops.tailLog(lines) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get("/:id/logs/stream", instanceGuard, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const hb = setInterval(() => {
    try {
      res.write(":heartbeat\n\n");
    } catch {
      clearInterval(hb);
    }
  }, 20_000);

  logStream.addClient(res);
  req.on("close", () => {
    clearInterval(hb);
    logStream.removeClient(res);
  });
});

// ── Server info routes ────────────────────────────────────────────────────

router.get("/:id/whitelist", instanceGuard, (_req, res) => {
  try {
    res.json({ whitelist: ops.getWhitelist() });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get("/:id/level-name", instanceGuard, async (_req, res) => {
  try {
    res.json({ levelName: await ops.getLevelName() });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get("/:id/mods", instanceGuard, (_req, res) => {
  // F-008: getModSlugs() now returns null on missing file — respond 404
  try {
    const result = ops.getModSlugs();
    if (result === null) {
      return res.status(404).json({ error: "Mod list not found" });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get("/:id/backups", instanceGuard, (_req, res) => {
  try {
    res.json(ops.getBackups());
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Stats routes ──────────────────────────────────────────────────────────

router.get("/:id/stats", instanceGuard, async (_req, res) => {
  try {
    res.json({ uuids: await ops.listStatsUuids() });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// F-001: UUID is validated before being passed to ops.getStats()
router.get("/:id/stats/:uuid", instanceGuard, validateUuid, async (req, res) => {
  try {
    const stats = await ops.getStats(req.params.uuid);
    if (stats === null) {
      return res.status(404).json({ error: "Stats not found" });
    }
    res.json({ stats });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Runtime routes ────────────────────────────────────────────────────────

router.get("/:id/running", instanceGuard, async (_req, res) => {
  try {
    res.json({ running: await ops.isRunning() });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get("/:id/list", instanceGuard, async (_req, res) => {
  try {
    res.json(await ops.getList());
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.get("/:id/tps", instanceGuard, async (_req, res) => {
  try {
    res.json({ tps: await ops.getTps() });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Command & script routes ───────────────────────────────────────────────

router.post("/:id/command", instanceGuard, async (req, res) => {
  const { command } = req.body;
  // A-08: validate type and length — Minecraft commands are at most 256 chars;
  // an unbounded string could stress the RCON/screen paths unnecessarily.
  if (!command || typeof command !== "string") {
    res.status(400).json({ error: "Missing command" });
    return;
  }
  if (command.length > 256) {
    res.status(400).json({ error: "command must be ≤ 256 characters" });
    return;
  }
  try {
    res.json({ result: await ops.sendCommand(command) });
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
        "Invalid args: must be an array of up to 5 strings containing only alphanumeric, '.', '@', '/', or '-' characters (max 128 chars each)",
    });
    return;
  }
  try {
    res.json(await ops.runScript(action, args));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

module.exports = router;
