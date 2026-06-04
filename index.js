"use strict";

const fs = require("fs");
const path = require("path");
const express = require("express");

const config = require("./src/config");
const { createOperations } = require("./src/operations");
const logStream = require("./src/logStream");
const { createRouter } = require("./src/routes/instances");

// ── Express app ───────────────────────────────────────────────────────────

const app = express();
// A-07: explicit 4 KB limit — this API only receives short commands and
// script action names; the default 100 KB is unnecessarily large.
app.use(express.json({ limit: "4kb" }));

// Ensure log directory exists (used by PM2 / ecosystem.config.cjs)
const LOG_DIR = path.join(__dirname, "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// NOTE: /health is registered BEFORE the auth middleware so it remains
// publicly accessible for uptime monitors.
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Auth middleware — all routes below require a valid API key
app.use((req, res, next) => {
  if (!config.API_KEY) return next();
  const key = req.headers["x-api-key"] || "";
  if (key !== config.API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
});

// ── Instance registry ─────────────────────────────────────────────────────

// Build one operations bundle per configured instance
const opsRegistry = new Map();
for (const [id, cfg] of Object.entries(config.instances)) {
  opsRegistry.set(id, createOperations(cfg));
}

// Initialise log-stream watchers for all instances
const logStreamAPI = logStream.init(config.instances);

// Mount instance routes
app.use("/instances", createRouter(opsRegistry, logStreamAPI));

// ── Start ─────────────────────────────────────────────────────────────────

const instanceList = Object.keys(config.instances).join(", ");
app.listen(config.PORT, () => {
  console.log(`[api-server] instances: [${instanceList}] — listening on :${config.PORT}`);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────

// A-10: dispose() releases all fs.watch handles and polling intervals so a
// long processLogChanges() iteration doesn't prevent a clean SIGTERM exit.
function shutdown(signal) {
  console.log(`[api-server] ${signal} received — shutting down`);
  logStreamAPI.dispose();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
