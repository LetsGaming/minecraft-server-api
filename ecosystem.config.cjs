/**
 * PM2 Ecosystem Configuration — minecraft-bot API server
 *
 * Usage (from the api-server directory):
 *   pm2 start ecosystem.config.cjs
 *   pm2 start ecosystem.config.cjs --env production
 *
 * Instance name resolution (highest → lowest priority):
 *   1. INSTANCE_NAME environment variable
 *   2. INSTANCE_NAME key in the variables.txt file
 *      - Path: VARIABLES_TXT_PATH env var, or ../common/variables.txt (default)
 *   3. Fallback: "mc-api"
 *
 * For standalone deployments without variables.txt, set INSTANCE_NAME (and
 * all other config) as environment variables before calling pm2 start, or add
 * them to the env / env_production blocks below.
 *
 * Common commands:
 *   pm2 list
 *   pm2 logs <instance-name>-api
 *   pm2 restart <instance-name>-api
 *   pm2 stop <instance-name>-api
 *   pm2 monit
 *
 * To start on boot:
 *   pm2 startup        (run the printed command as root)
 *   pm2 save
 */

"use strict";

const path = require("path");
const fs = require("fs");

// F-007: shared parser — no Express, no runtime state, safe in PM2 config
const { parseVarsFile } = require("./src/parseVars");

// ── Resolve instance name ─────────────────────────────────────────────────

const DEFAULT_VARS_FILE = path.resolve(
  __dirname, "..", "common", "variables.txt",
);
const VARS_FILE = process.env.VARIABLES_TXT_PATH ?? DEFAULT_VARS_FILE;

let instanceName = process.env.INSTANCE_NAME;

if (!instanceName && fs.existsSync(VARS_FILE)) {
  const vars = parseVarsFile(VARS_FILE);
  instanceName = vars["INSTANCE_NAME"] || undefined;
}

instanceName = instanceName || "mc-api";

// ─────────────────────────────────────────────────────────────────────────

module.exports = {
  apps: [
    {
      name: `${instanceName}-api`,
      script: "index.js",
      cwd: __dirname,

      // ── Node ──
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",

      // ── Process management ──
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      restart_delay: 5000,

      // ── Logging ──
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      out_file: "./logs/pm2-out.log",
      error_file: "./logs/pm2-error.log",
      merge_logs: true,

      // ── Resource limits ──
      max_memory_restart: "256M",

      // ── Environment ──
      // PM2 inherits the process environment, so env vars set before
      // `pm2 start` (SERVER_PATH, INSTANCE_NAME, etc.) are passed through.
      // You can also set them explicitly here:
      env: {
        NODE_ENV: "development",
        // VARIABLES_TXT_PATH: "/absolute/path/to/variables.txt",
        // SERVER_PATH: "/opt/minecraft/survival",
        // INSTANCE_NAME: "survival",
      },
      env_production: {
        NODE_ENV: "production",
      },
    },
  ],
};
