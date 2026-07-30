/**
 * Who is on the server and who is allowed on it: the live list (via the
 * health monitor's shared RCON round-trip), whitelist.json and usercache.json.
 */
import fsp from "fs/promises";
import path from "path";

import type { HealthMonitor } from "./health.js";
import type { InstanceConfig } from "../config/types.js";
import type { PlayerList, WhitelistEntry } from "../contracts/wire.js";

export function createPlayers(cfg: InstanceConfig, health: HealthMonitor) {
async function getList(): Promise<PlayerList> {
  return health.getList();
}

async function getWhitelist(): Promise<unknown[]> {
  try {
    const data: unknown = JSON.parse(
      await fsp.readFile(path.join(cfg.serverPath, "whitelist.json"), "utf-8"),
    );
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/**
 * usercache.json — every player the server has ever seen, whitelist or
 * not. The bot layers this over the whitelist as a best-effort name
 * source (readUserCache in serverAccess.ts). Entries are filtered to
 * the {name, uuid} shape the bot expects; Mojang's extra fields
 * (expiresOn) are dropped.
 */
async function getUserCache(): Promise<WhitelistEntry[]> {
  try {
    const data: unknown = JSON.parse(
      await fsp.readFile(path.join(cfg.serverPath, "usercache.json"), "utf-8"),
    );
    if (!Array.isArray(data)) return [];
    return (data as Array<{ name?: unknown; uuid?: unknown }>)
      .filter((e) => typeof e?.name === "string" && typeof e?.uuid === "string")
      .map((e) => ({ name: e.name as string, uuid: e.uuid as string }));
  } catch {
    return [];
  }
}

  return { getList, getWhitelist, getUserCache };
}
