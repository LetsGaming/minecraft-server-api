/**
 * PM2 Ecosystem Configuration — mc-api-server
 *
 * One process serves all configured instances from a single api-server-config.json.
 *
 * Usage (from the api-server directory):
 *   pm2 start ecosystem.config.cjs
 *   pm2 start ecosystem.config.cjs --env production
 *
 * Common commands:
 *   pm2 list
 *   pm2 logs mc-api-server
 *   pm2 restart mc-api-server
 *   pm2 monit
 *
 * To start on boot:
 *   pm2 startup        (run the printed command as root)
 *   pm2 save
 */

"use strict";

const path = require("path");
const fs   = require("fs");

// ── Resolve process name ──────────────────────────────────────────────────
// Derive a meaningful PM2 process name from the config file when possible.
// Falls back to "mc-api-server" for bare deployments.

const DEFAULT_CONFIG_FILE = path.join(__dirname, "api-server-config.json");
const CONFIG_FILE = process.env.CONFIG_FILE ?? DEFAULT_CONFIG_FILE;

let processName = "mc-api-server";

if (fs.existsSync(CONFIG_FILE)) {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    const ids = Object.keys(cfg.instances ?? {});
    if (ids.length === 1) processName = `${ids[0]}-api`;
    // Multiple instances: keep the generic name
  } catch {
    /* use default name */
  }
} else if (process.env.INSTANCE_NAME) {
  // Single-instance fallback (variables.txt mode)
  processName = `${process.env.INSTANCE_NAME}-api`;
}

// ─────────────────────────────────────────────────────────────────────────

module.exports = {
  apps: [
    {
      name:   processName,
      script: "index.js",
      cwd:    __dirname,

      // ── Node ──
      interpreter: "node",
      instances:   1,
      exec_mode:   "fork",

      // ── Process management ──
      autorestart:   true,
      max_restarts:  10,
      min_uptime:    "10s",
      restart_delay: 5000,

      // ── Logging ──
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      out_file:        "./logs/pm2-out.log",
      error_file:      "./logs/pm2-error.log",
      merge_logs:      true,

      // ── Resource limits ──
      max_memory_restart: "256M",

      // ── Environment ──
      // CONFIG_FILE is resolved above and passed through automatically.
      // Add overrides or secrets here if not using api-server-config.json.
      env: {
        NODE_ENV: "development",
        // CONFIG_FILE: "/absolute/path/to/api-server-config.json",
      },
      env_production: {
        NODE_ENV: "production",
      },
    },
  ],
};
