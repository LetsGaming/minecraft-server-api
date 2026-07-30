/**
 * server.properties reads: the world's level name and the game port.
 *
 * Both are stable for the lifetime of a server run but are read off disk on
 * a request path, so both are memoised behind the same short TTL. A world
 * switch is picked up within a minute without a restart.
 */
import fsp from "fs/promises";
import path from "path";

import type { InstanceConfig } from "../config/types.js";

const PROPERTIES_TTL_MS = 60_000;

export interface World {
  getLevelName(): Promise<string>;
  getGamePort(): Promise<number | null>;
}

export function createWorld(cfg: InstanceConfig): World {
  let levelNameCache: string | null = null;
  let levelNameCachedAt = 0;
  let gamePortCache: number | null | undefined = undefined;
  let gamePortAt = 0;

async function getLevelName(): Promise<string> {
  if (levelNameCache && Date.now() - levelNameCachedAt < PROPERTIES_TTL_MS) {
    return levelNameCache;
  }
  const propsPath = path.join(cfg.serverPath, "server.properties");
  try {
    const text = await fsp.readFile(propsPath, "utf-8");
    const m = /^level-name\s*=\s*(.+)$/m.exec(text);
    levelNameCache = m?.[1]?.trim() ?? "world";
  } catch {
    levelNameCache = "world";
  }
  levelNameCachedAt = Date.now();
  return levelNameCache;
}

/**
 * `server-port` from server.properties, cached like the level name.
 *
 * Reported on /health so a client knows where to ping the game server
 * directly — which matters exactly when this wrapper is unreachable and
 * cannot be asked.
 */
async function getGamePort(): Promise<number | null> {
  if (gamePortCache !== undefined && Date.now() - gamePortAt < PROPERTIES_TTL_MS) {
    return gamePortCache;
  }
  try {
    const text = await fsp.readFile(
      path.join(cfg.serverPath, "server.properties"),
      "utf-8",
    );
    const m = /^server-port\s*=\s*(\d{1,5})\s*$/m.exec(text);
    const port = m?.[1] ? Number(m[1]) : NaN;
    gamePortCache = Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    gamePortCache = null;
  }
  gamePortAt = Date.now();
  return gamePortCache;
}

  return { getLevelName, getGamePort };
}
