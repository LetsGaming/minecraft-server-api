/**
 * Config resolution.
 *
 * Multi-instance mode (preferred):
 *   Reads api-server-config.json. Path resolved as:
 *   1. CONFIG_FILE env var
 *   2. ./api-server-config.json in the repo root
 *
 * Single-instance fallback (backward-compat with server-setup layout):
 *   Reads variables.txt. Path resolved as:
 *   1. VARIABLES_TXT_PATH env var
 *   2. ../common/variables.txt relative to the repo root
 *   3. Env-var-only mode (SERVER_PATH must be set)
 *
 * Env vars override file values afterwards (Docker/K8s secret injection
 * without touching disk): MC_API_KEY, MC_PORT, RCON_PASSWORD_<ID>.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parseVarsFile } from "./parseVars.js";
import { log } from "./logger.js";
import type { AppConfig, InstanceConfig } from "./types.js";

// dist/config.js → repo root is one level up from dist/
export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const DEFAULT_CONFIG_FILE = path.join(REPO_ROOT, "api-server-config.json");

function fail(msg: string): never {
  log.error("config", msg);
  process.exit(1);
}

type RawInstance = {
  [K in keyof InstanceConfig]?: InstanceConfig[K] | undefined;
};

function normaliseInstance(id: string, raw: RawInstance): InstanceConfig {
  if (!raw.serverPath) {
    fail(`Instance "${id}" is missing required field: serverPath`);
  }
  return {
    id,
    serverPath: raw.serverPath,
    linuxUser: raw.linuxUser ?? "minecraft",
    useRcon: raw.useRcon === true,
    rconHost: raw.rconHost ?? "localhost",
    rconPort: raw.rconPort ?? 25575,
    rconPassword: raw.rconPassword ?? "",
    backupsPath: raw.backupsPath ?? "",
    // scriptsDir: directory containing start.sh, shutdown.sh, etc.
    // Defaults to the parent of the repo root — correct for server-setup
    // deployments where the repo lives at <instance>/api-server/.
    scriptsDir: raw.scriptsDir ?? path.resolve(REPO_ROOT, ".."),
  };
}

function loadJsonConfig(filePath: string): AppConfig {
  let raw: {
    port?: number;
    apiKey?: string;
    instances?: Record<string, Partial<InstanceConfig>>;
  };
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as typeof raw;
  } catch (err) {
    fail(`Failed to load ${filePath}: ${(err as Error).message}`);
  }

  if (
    !raw.instances ||
    typeof raw.instances !== "object" ||
    !Object.keys(raw.instances).length
  ) {
    fail(`${filePath}: "instances" must be a non-empty object.`);
  }

  const instances: Record<string, InstanceConfig> = {};
  for (const [id, inst] of Object.entries(raw.instances)) {
    instances[id] = normaliseInstance(id, inst as RawInstance);
  }

  return {
    PORT: raw.port ?? 3000,
    API_KEY: raw.apiKey ?? "",
    instances,
  };
}

function singleInstanceFromVars(vars: Record<string, string>): AppConfig {
  const get = (envKey: string, varsKey: string, fallback = ""): string =>
    process.env[envKey] ?? vars[varsKey] ?? fallback;

  const serverPath = get("SERVER_PATH", "SERVER_PATH");
  const instanceName = get("INSTANCE_NAME", "INSTANCE_NAME", "server");

  if (!serverPath) {
    fail(
      "SERVER_PATH is required.\n" +
        "  Provide api-server-config.json, or set SERVER_PATH as an env var.\n" +
        "  See variables.example.txt for all options.",
    );
  }

  const inst = normaliseInstance(instanceName, {
    serverPath,
    linuxUser: get("LINUX_USER", "USER") || undefined,
    useRcon: get("USE_RCON", "USE_RCON") === "true",
    rconHost: get("RCON_HOST", "RCON_HOST") || undefined,
    rconPort: parseInt(get("RCON_PORT", "RCON_PORT", "25575"), 10),
    rconPassword: get("RCON_PASSWORD", "RCON_PASSWORD"),
    backupsPath: get("BACKUPS_PATH", "BACKUPS_PATH"),
    ...(process.env.SCRIPTS_DIR ? { scriptsDir: process.env.SCRIPTS_DIR } : {}),
  });

  return {
    PORT: parseInt(get("API_SERVER_PORT", "API_SERVER_PORT", "3000"), 10),
    API_KEY: get("API_SERVER_KEY", "API_SERVER_KEY"),
    instances: { [instanceName]: inst },
  };
}

export function loadConfig(): AppConfig {
  const configFile = process.env.CONFIG_FILE ?? DEFAULT_CONFIG_FILE;

  let config: AppConfig;

  if (fs.existsSync(configFile)) {
    config = loadJsonConfig(configFile);
  } else {
    const explicitVarsPath = process.env.VARIABLES_TXT_PATH;
    const defaultVarsPath = path.join(REPO_ROOT, "..", "common", "variables.txt");

    if (explicitVarsPath) {
      if (!fs.existsSync(explicitVarsPath)) {
        fail(`variables.txt not found at ${explicitVarsPath}`);
      }
      config = singleInstanceFromVars(parseVarsFile(explicitVarsPath));
    } else if (fs.existsSync(defaultVarsPath)) {
      config = singleInstanceFromVars(parseVarsFile(defaultVarsPath));
    } else {
      config = singleInstanceFromVars({});
    }
  }

  // ── Environment variable overrides ─────────────────────────────────────
  if (process.env.MC_API_KEY) config.API_KEY = process.env.MC_API_KEY;
  if (process.env.MC_PORT) {
    const p = parseInt(process.env.MC_PORT, 10);
    if (!Number.isNaN(p)) config.PORT = p;
  }
  // Per-instance RCON password override: RCON_PASSWORD_<INSTANCE_ID_UPPER>
  for (const [id, inst] of Object.entries(config.instances)) {
    const envKey = `RCON_PASSWORD_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
    const override = process.env[envKey];
    if (override) inst.rconPassword = override;
  }

  return config;
}
