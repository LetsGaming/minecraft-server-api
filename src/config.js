"use strict";

const fs = require("fs");
const path = require("path");
const { parseVarsFile } = require("./parseVars");

// ── Config resolution ─────────────────────────────────────────────────────
//
// Multi-instance mode (preferred):
//   Reads api-server-config.json. Path resolved as:
//   1. CONFIG_FILE env var
//   2. ./api-server-config.json in the repo root (next to index.js)
//
// Single-instance fallback (backward-compat with server-setup layout):
//   Reads variables.txt. Path resolved as:
//   1. VARIABLES_TXT_PATH env var
//   2. ../common/variables.txt relative to the repo root
//   3. Env-var-only mode (SERVER_PATH must be set)

const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_CONFIG_FILE = path.join(REPO_ROOT, "api-server-config.json");
const CONFIG_FILE = process.env.CONFIG_FILE ?? DEFAULT_CONFIG_FILE;

// ── Helpers ───────────────────────────────────────────────────────────────

function normaliseInstance(id, raw) {
  if (!raw.serverPath) {
    console.error(`[api-server] Instance "${id}" is missing required field: serverPath`);
    process.exit(1);
  }
  return {
    id,
    serverPath:    raw.serverPath,
    linuxUser:     raw.linuxUser     ?? "minecraft",
    useRcon:       raw.useRcon       === true,
    rconHost:      raw.rconHost      ?? "localhost",
    rconPort:      raw.rconPort      ?? 25575,
    rconPassword:  raw.rconPassword  ?? "",
    backupsPath:   raw.backupsPath   ?? "",
    // scriptsDir: directory containing start.sh, shutdown.sh, etc.
    // Defaults to the parent of the repo root — correct for server-setup
    // deployments where the repo lives at <instance>/api-server/.
    scriptsDir:    raw.scriptsDir    ?? path.resolve(REPO_ROOT, ".."),
  };
}

function loadJsonConfig(filePath) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    console.error(`[api-server] Failed to load ${filePath}: ${err.message}`);
    process.exit(1);
  }

  if (!raw.instances || typeof raw.instances !== "object" || !Object.keys(raw.instances).length) {
    console.error(`[api-server] ${filePath}: "instances" must be a non-empty object.`);
    process.exit(1);
  }

  const instances = {};
  for (const [id, inst] of Object.entries(raw.instances)) {
    instances[id] = normaliseInstance(id, inst);
  }

  return {
    PORT:     raw.port    ?? 3000,
    API_KEY:  raw.apiKey  ?? "",
    instances,
  };
}

function singleInstanceFromVars(vars) {
  function get(envKey, varsKey, fallback = "") {
    return process.env[envKey] ?? vars[varsKey] ?? fallback;
  }

  const serverPath   = get("SERVER_PATH",   "SERVER_PATH");
  const instanceName = get("INSTANCE_NAME", "INSTANCE_NAME", "server");

  if (!serverPath) {
    console.error(
      "[api-server] SERVER_PATH is required.\n" +
        "  Provide api-server-config.json, or set SERVER_PATH as an env var.\n" +
        "  See variables.example.txt for all options.",
    );
    process.exit(1);
  }

  const inst = normaliseInstance(instanceName, {
    serverPath,
    linuxUser:    get("LINUX_USER",    "USER"),
    useRcon:      get("USE_RCON",      "USE_RCON") === "true",
    rconHost:     get("RCON_HOST",     "RCON_HOST"),
    rconPort:     parseInt(get("RCON_PORT", "RCON_PORT", "25575"), 10),
    rconPassword: get("RCON_PASSWORD", "RCON_PASSWORD"),
    backupsPath:  get("BACKUPS_PATH",  "BACKUPS_PATH"),
    scriptsDir:   process.env.SCRIPTS_DIR,
  });

  return {
    PORT:     parseInt(get("API_SERVER_PORT", "API_SERVER_PORT", "3000"), 10),
    API_KEY:  get("API_SERVER_KEY", "API_SERVER_KEY"),
    instances: { [instanceName]: inst },
  };
}

// ── Load ──────────────────────────────────────────────────────────────────

let config;

if (fs.existsSync(CONFIG_FILE)) {
  config = loadJsonConfig(CONFIG_FILE);
} else {
  // Single-instance fallback
  const explicitVarsPath = process.env.VARIABLES_TXT_PATH;
  const defaultVarsPath  = path.join(REPO_ROOT, "..", "common", "variables.txt");

  if (explicitVarsPath) {
    if (!fs.existsSync(explicitVarsPath)) {
      console.error(`[api-server] variables.txt not found at ${explicitVarsPath}`);
      process.exit(1);
    }
    config = singleInstanceFromVars(parseVarsFile(explicitVarsPath));
  } else if (fs.existsSync(defaultVarsPath)) {
    config = singleInstanceFromVars(parseVarsFile(defaultVarsPath));
  } else {
    config = singleInstanceFromVars({});
  }
}

module.exports = config;
