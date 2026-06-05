"use strict";

const fs        = require("fs");
const path      = require("path");
const crypto    = require("crypto");
const express   = require("express");
const rateLimit = require("express-rate-limit");

const config               = require("./src/config");
const { createOperations } = require("./src/operations");
const logStream            = require("./src/logStream");
const { createRouter }     = require("./src/routes/instances");

// ── Express app ───────────────────────────────────────────────────────────

const app = express();

// A-07: explicit 4 KB limit — this API only receives short commands and
// script action names; the default 100 KB is unnecessarily large.
app.use(express.json({ limit: "4kb" }));

// ── Security headers ───────────────────────────────────────────────────────
app.use((_req, res, next) => {
  res.removeHeader("X-Powered-By");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options",        "DENY");
  next();
});

// Ensure log directory exists (used by PM2 / ecosystem.config.cjs)
const LOG_DIR = path.join(__dirname, "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// ── Rate limiting ──────────────────────────────────────────────────────────
// Applied globally so both auth failures and valid requests are throttled.
// The /health endpoint is exempted below via skip().
const globalLimiter = rateLimit({
  windowMs:        15 * 60 * 1000, // 15 minutes
  max:             300,             // generous for legitimate automation
  standardHeaders: true,
  legacyHeaders:   false,
  skip:            (req) => req.path === "/health",
  message:         { error: "Too many requests" },
});
// Strict limiter applied to auth-failure attempts specifically
const authFailLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             20,             // 20 bad keys per 15 min per IP
  standardHeaders: true,
  legacyHeaders:   false,
  skipSuccessfulRequests: true,   // only count failures
  message:         { error: "Too many failed authentication attempts" },
});
app.use(globalLimiter);

// NOTE: /health is registered BEFORE the auth middleware so it remains
// publicly accessible for uptime monitors.
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// ── Auth middleware ────────────────────────────────────────────────────────
// All routes below require a valid API key.
app.use(authFailLimiter);
app.use((req, res, next) => {
  if (!config.API_KEY) return next();
  const key = req.headers["x-api-key"] ?? "";
  // Use constant-time comparison to prevent timing-oracle key enumeration.
  // Pad/truncate to the same byte length before comparing so Buffer.from
  // doesn't throw on mismatched sizes.
  const expectedBuf = Buffer.from(config.API_KEY);
  const receivedBuf = Buffer.alloc(expectedBuf.length);
  Buffer.from(key).copy(receivedBuf);
  const valid =
    key.length === config.API_KEY.length &&
    crypto.timingSafeEqual(receivedBuf, expectedBuf);
  if (!valid) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
});

// ── Instance registry ─────────────────────────────────────────────────────

const opsRegistry = new Map();
for (const [id, cfg] of Object.entries(config.instances)) {
  opsRegistry.set(id, createOperations(cfg));
}

const logStreamAPI = logStream.init(config.instances);

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
