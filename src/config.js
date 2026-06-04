"use strict";

const fs = require("fs");
const path = require("path");

// F-007: use shared parser
const { parseVarsFile } = require("./parseVars");

// ── Config source resolution ───────────────────────────────────────────────
//
// Priority (highest → lowest):
//   1. Environment variables  — recommended for standalone / Docker deployments
//   2. variables.txt          — used for server-setup managed deployments
//
// variables.txt path:
//   - Set VARIABLES_TXT_PATH to any absolute path to use that file
//   - Default (when VARIABLES_TXT_PATH is not set): ../common/variables.txt
//     relative to the api-server root, which matches the server-setup layout:
//
//       <instance>/api-server/   ← repo root
//       <instance>/common/variables.txt   ← resolved default
//
// If neither VARIABLES_TXT_PATH nor the default variables.txt exists, the
// server starts in env-var-only mode. SERVER_PATH and INSTANCE_NAME must then
// be supplied as environment variables (the server exits with a clear error
// if they are missing).

// Default path: one level up from this repo's root, in common/.
// __dirname is src/, so two levels up reaches the api-server parent (<instance>/).
const DEFAULT_VARS_FILE = path.resolve(
  __dirname, "..", "..", "common", "variables.txt",
);

const VARS_FILE = process.env.VARIABLES_TXT_PATH ?? DEFAULT_VARS_FILE;

let vars = {};

if (process.env.VARIABLES_TXT_PATH) {
  // Explicit path: the file must exist.
  if (!fs.existsSync(VARS_FILE)) {
    console.error(`[api-server] variables.txt not found at ${VARS_FILE}`);
    process.exit(1);
  }
  vars = parseVarsFile(VARS_FILE);
} else if (fs.existsSync(DEFAULT_VARS_FILE)) {
  // Default path found: load it silently (server-setup deployment or local file).
  vars = parseVarsFile(DEFAULT_VARS_FILE);
}
// else: env-var-only mode — required keys are validated below.

// ── Helpers ───────────────────────────────────────────────────────────────

// Return the first of: env var → variables.txt key → fallback.
// Note: use LINUX_USER (not USER) as the env var name to avoid colliding
// with the system's $USER variable.
function cfg(envKey, varsKey, fallback = "") {
  return process.env[envKey] ?? vars[varsKey] ?? fallback;
}

// ── Required fields ───────────────────────────────────────────────────────

const SERVER_PATH = cfg("SERVER_PATH", "SERVER_PATH");
const INSTANCE_NAME = cfg("INSTANCE_NAME", "INSTANCE_NAME", "server");

if (!SERVER_PATH) {
  console.error(
    "[api-server] SERVER_PATH is required but not set.\n" +
      "  Set it as an environment variable, or provide a variables.txt.\n" +
      "  See variables.example.txt for all available options.",
  );
  process.exit(1);
}

// ── Exports ───────────────────────────────────────────────────────────────

module.exports = {
  PORT: parseInt(cfg("API_SERVER_PORT", "API_SERVER_PORT", "3000"), 10),
  API_KEY: cfg("API_SERVER_KEY", "API_SERVER_KEY"),
  SERVER_PATH,
  INSTANCE_NAME,
  LINUX_USER: cfg("LINUX_USER", "USER", "minecraft"),
  USE_RCON: cfg("USE_RCON", "USE_RCON") === "true",
  RCON_HOST: cfg("RCON_HOST", "RCON_HOST", "localhost"),
  RCON_PORT: parseInt(cfg("RCON_PORT", "RCON_PORT", "25575"), 10),
  RCON_PASSWORD: cfg("RCON_PASSWORD", "RCON_PASSWORD"),
  BACKUPS_PATH: cfg("BACKUPS_PATH", "BACKUPS_PATH"),

  // INSTANCE_SCRIPTS_DIR: directory that contains start.sh, shutdown.sh, etc.
  //
  // Default: parent of the api-server root — correct when deployed inside
  // a server-setup instance at <instance>/api-server/:
  //   __dirname = <instance>/api-server/src/  →  ../.. = <instance>/
  //
  // Override with SCRIPTS_DIR for any other layout.
  INSTANCE_SCRIPTS_DIR:
    process.env.SCRIPTS_DIR ?? path.resolve(__dirname, "..", ".."),
};
