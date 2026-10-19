/**
 * Who is on the server and who is allowed on it: the live list (via the
 * health monitor's shared RCON round-trip), whitelist.json and usercache.json.
 */
import path from "path";

import { cached } from "../platform/cache.js";
import { readFileNoFollow } from "../platform/safeFs.js";
import type { HealthMonitor } from "./health.js";
import type { InstanceConfig } from "../config/types.js";
import type { PlayerList, WhitelistEntry } from "../contracts/wire.js";

/** whitelist.json only changes on an explicit whitelist add/remove. */
const WHITELIST_FRESH_MS = 30_000;
const WHITELIST_STALE_MS = 300_000;
const WHITELIST_MAX_BYTES = 4 * 1024 * 1024;
const USERCACHE_MAX_BYTES = 16 * 1024 * 1024;
/** usercache.json is effectively append-only and can be megabytes. */
const USERCACHE_FRESH_MS = 60_000;
const USERCACHE_STALE_MS = 600_000;

export function createPlayers(cfg: InstanceConfig, health: HealthMonitor) {
async function getList(): Promise<PlayerList> {
  return health.getList();
}

async function readWhitelist(): Promise<unknown[]> {
  try {
    const data: unknown = JSON.parse(
      (
        await readFileNoFollow(path.join(cfg.serverPath, "whitelist.json"), WHITELIST_MAX_BYTES)
      ).toString("utf-8"),
    );
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

const whitelistCache = cached(readWhitelist, {
  freshMs: WHITELIST_FRESH_MS,
  staleMs: WHITELIST_STALE_MS,
});

async function getWhitelist(): Promise<unknown[]> {
  return (await whitelistCache.get()).value;
}

/**
 * usercache.json — every player the server has ever seen, whitelist or
 * not. The bot layers this over the whitelist as a best-effort name
 * source (readUserCache in serverAccess.ts). Entries are filtered to
 * the {name, uuid} shape the bot expects; Mojang's extra fields
 * (expiresOn) are dropped.
 */
async function readUserCache(): Promise<WhitelistEntry[]> {
  try {
    const data: unknown = JSON.parse(
      (
        await readFileNoFollow(path.join(cfg.serverPath, "usercache.json"), USERCACHE_MAX_BYTES)
      ).toString("utf-8"),
    );
    if (!Array.isArray(data)) return [];
    return (data as Array<{ name?: unknown; uuid?: unknown }>)
      .filter((e) => typeof e?.name === "string" && typeof e?.uuid === "string")
      .map((e) => ({ name: e.name as string, uuid: e.uuid as string }));
  } catch {
    return [];
  }
}

const userCacheCache = cached(readUserCache, {
  freshMs: USERCACHE_FRESH_MS,
  staleMs: USERCACHE_STALE_MS,
});

async function getUserCache(): Promise<WhitelistEntry[]> {
  return (await userCacheCache.get()).value;
}

  return { getList, getWhitelist, getUserCache };
}
