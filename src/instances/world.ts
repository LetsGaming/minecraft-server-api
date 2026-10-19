/**
 * server.properties reads: the world's level name and the game port.
 *
 * Both are stable for the lifetime of a server run but are read off disk on
 * a request path, so both are memoised behind the same short TTL. A world
 * switch is picked up within a minute without a restart.
 */
import path from "path";

import type { InstanceConfig } from "../config/types.js";
import { log } from "../platform/logger.js";
import { readFileNoFollow } from "../platform/safeFs.js";
import { parseJavaProperties } from "./configSecrets.js";

const PROPERTIES_TTL_MS = 60_000;
const PROPERTIES_MAX_BYTES = 1024 * 1024;
const DEFAULT_LEVEL_NAME = "world";

/**
 * A level name is one directory name below the server directory. Anything
 * with a separator, a dot segment or a NUL could point the stats and world
 * readers somewhere else.
 */
export function isSafeLevelName(name: string): boolean {
  return (
    name !== "" &&
    name !== "." &&
    name !== ".." &&
    !/[/\\\0]/.test(name) &&
    !/^[A-Za-z]:/.test(name)
  );
}

export interface World {
  getLevelName(): Promise<string>;
  getGamePort(): Promise<number | null>;
}

export function createWorld(cfg: InstanceConfig): World {
  let levelNameCache: string | null = null;
  let levelNameCachedAt = 0;
  let gamePortCache: number | null | undefined = undefined;
  let gamePortAt = 0;

async function readProperties(): Promise<Map<string, string>> {
  const raw = await readFileNoFollow(
    path.join(cfg.serverPath, "server.properties"),
    PROPERTIES_MAX_BYTES,
  );
  return parseJavaProperties(raw.toString("utf-8"));
}

async function getLevelName(): Promise<string> {
  if (levelNameCache && Date.now() - levelNameCachedAt < PROPERTIES_TTL_MS) {
    return levelNameCache;
  }
  try {
    const name = ((await readProperties()).get("level-name") ?? DEFAULT_LEVEL_NAME).trim();
    if (isSafeLevelName(name)) {
      levelNameCache = name;
    } else {
      log.warn("world", `[${cfg.id}] Ignoring unsafe level-name in server.properties`);
      levelNameCache = DEFAULT_LEVEL_NAME;
    }
  } catch {
    levelNameCache = DEFAULT_LEVEL_NAME;
  }
  levelNameCachedAt = Date.now();
  return levelNameCache;
}

/**
 * `server-port` from server.properties, cached like the level name.
 *
 * Reported on /health so a client knows where to ping the game server
 * directly, which matters exactly when this wrapper is unreachable and
 * cannot be asked.
 */
async function getGamePort(): Promise<number | null> {
  if (gamePortCache !== undefined && Date.now() - gamePortAt < PROPERTIES_TTL_MS) {
    return gamePortCache;
  }
  try {
    const raw = (await readProperties()).get("server-port")?.trim() ?? "";
    const port = /^\d{1,5}$/.test(raw) ? Number(raw) : NaN;
    gamePortCache = Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    gamePortCache = null;
  }
  gamePortAt = Date.now();
  return gamePortCache;
}

  return { getLevelName, getGamePort };
}
