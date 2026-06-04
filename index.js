"use strict";

const fs = require("fs");
const path = require("path");
const express = require("express");

const { PORT, API_KEY, INSTANCE_NAME } = require("./src/config");
const logStream = require("./src/logStream");
const instancesRouter = require("./src/routes/instances");

// ── Express app ───────────────────────────────────────────────────────────

const app = express();
// A-07: explicit 4 KB limit — this API only receives short commands and
// script action names; the default 100 KB is unnecessarily large and would
// let any key-holder trigger expensive JSON parses with large payloads.
app.use(express.json({ limit: "4kb" }));

// Ensure log directory exists (used by PM2 / ecosystem.config.cjs)
const LOG_DIR = path.join(__dirname, "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// NOTE: /health is intentionally registered BEFORE the auth middleware.
// It must stay above app.use(authMiddleware) to remain publicly accessible
// for uptime monitors. The instance name is NOT exposed here to avoid
// leaking internal config to unauthenticated callers.
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Auth middleware — all routes below this point require a valid API key
app.use((req, res, next) => {
  if (!API_KEY) return next();
  const key = req.headers["x-api-key"] || "";
  if (key !== API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
});

// Instance routes
app.use("/instances", instancesRouter);

// ── Start ─────────────────────────────────────────────────────────────────

// A-10: init() now returns the fs.watch handle and polling interval so we
// can clean them up on shutdown — otherwise a long processLogChanges()
// iteration can prevent a clean SIGTERM exit.
const { watcher: logWatcher, poller: logPoller } = logStream.init();

app.listen(PORT, () => {
  console.log(`[api-server] ${INSTANCE_NAME} — listening on :${PORT}`);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────

function shutdown(signal) {
  console.log(`[api-server] ${signal} received — shutting down`);
  clearInterval(logPoller);
  if (logWatcher) logWatcher.close();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
