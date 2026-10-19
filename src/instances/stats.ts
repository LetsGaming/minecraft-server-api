/**
 * Player stat files. The directory layout is probed rather than assumed —
 * see resolveStatsDir for why a wrong guess here fails silently.
 */
import fsp from "fs/promises";
import path from "path";

import { cached } from "../platform/cache.js";
import { log } from "../platform/logger.js";
import { mapLimit } from "../platform/concurrency.js";
import { isInside, readFileNoFollow } from "../platform/safeFs.js";
import type { World } from "./world.js";
import type { InstanceConfig } from "../config/types.js";

/** Above the 4-thread libuv pool, low enough to leave it room for other work. */
const STATS_READ_CONCURRENCY = 8;
/** A stats file is a few kilobytes; megabytes means something else wrote it. */
const MAX_STATS_BYTES = 2 * 1024 * 1024;
/** Matches the bot's own loadAllStats() TTL, so the two never disagree. */
const ALL_STATS_FRESH_MS = 30_000;
const ALL_STATS_STALE_MS = 300_000;

/**
 * Layouts we know of, in order. Vanilla first — it is the documented
 * default and what an unmodded server writes.
 */
const STATS_DIR_CANDIDATES = ["stats", path.join("players", "stats")];

export function createStats(cfg: InstanceConfig, world: World) {
  let _statsDir: { levelName: string; dir: string } | null = null;

/**
 * Where this world keeps player stat files.
 *
 * Vanilla puts them at `<level>/stats/`, and that is what this always
 * assumed. Modded servers do not all agree: a Fabric instance in the
 * wild keeps them at `<level>/players/stats/`, next to
 * `players/advancements/`, and has no `<level>/stats/` at all.
 *
 * Probing matters more than it looks, because the failure is silent.
 * With the wrong directory every read is an ENOENT — which is exactly
 * what "nobody has played on this world yet" looks like — so the wrapper
 * answered `{uuids: []}` and 404s, the bot believed it, and the
 * leaderboards were simply empty. No error anywhere in the chain.
 *
 * Resolution is cached per level name, so a world switch re-probes.
 */
async function resolveStatsDir(): Promise<string | null> {
  const levelName = await world.getLevelName();
  if (_statsDir && _statsDir.levelName === levelName) {
    // The instance user can swap the directory for a link after it was probed.
    try {
      if ((await fsp.realpath(_statsDir.dir)) === _statsDir.dir) return _statsDir.dir;
    } catch {
      /* gone: probe again */
    }
    _statsDir = null;
  }

  let realServer: string | null = null;
  try {
    realServer = await fsp.realpath(cfg.serverPath);
  } catch {
    /* no server directory yet */
  }
  for (const rel of STATS_DIR_CANDIDATES) {
    if (realServer === null) break;
    let dir: string;
    try {
      dir = await fsp.realpath(path.join(cfg.serverPath, levelName, rel));
      if (!isInside(dir, realServer)) continue;
      if (!(await fsp.stat(dir)).isDirectory()) continue;
    } catch {
      continue; // next candidate
    }
    _statsDir = { levelName, dir };
    log.info("stats", `[${cfg.id}] Reading player stats from ${dir}`);
    return dir;
  }

  // None usable: normal on a fresh world, since the server creates the
  // directory when someone first plays. A candidate that exists but leaves the
  // server directory is treated the same way and never read. Not cached, so the
  // real one is picked up without a restart.
  return null;
}

async function getStats(uuid: string): Promise<unknown> {
  const statsDir = await resolveStatsDir();
  if (statsDir === null) return null;
  // A-11: path.relative() guard — more robust than startsWith()
  const resolved = path.resolve(statsDir, `${uuid}.json`);
  const rel = path.relative(statsDir, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  try {
    return JSON.parse((await readFileNoFollow(resolved, MAX_STATS_BYTES)).toString("utf-8")) as unknown;
  } catch {
    return null;
  }
}

async function listStatsUuids(): Promise<string[]> {
  const dir = await resolveStatsDir();
  if (dir === null) return [];
  try {
    return (await fsp.readdir(dir))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5));
  } catch (err) {
    // ENOENT is an answer: no stats directory means nobody has played on
    // this world yet, and [] is correct. It is only a safe conclusion
    // because resolveStatsDir() checked every layout we know of first —
    // when this looked in one hardcoded place, "wrong path" and "empty
    // world" produced the same silent [].
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];

    // Anything else — EACCES above all — is a failure, and returning []
    // for it is worse than erroring. The bot cannot tell the two apart
    // from an empty list, so it treated "I cannot read this" as "nobody
    // has stats" and wrote hourly snapshots with zero players. Those act
    // as a zero baseline, which silently turns every period leaderboard
    // into all-time totals. Let it 500 instead: a loud failure the
    // operator can act on beats a quiet wrong answer downstream.
    log.error(
      "stats",
      `Cannot read ${dir}: ${(err as Error).message}. Check serverPath, ` +
        `the world's level-name, and that this process can read the ` +
        `stats directory.`,
    );
    throw err;
  }
}

/**
 * H-05 companion: delete a player's stats file. Powers the bot's
 * explicit, admin-gated `/server prune-stats` command on remote
 * instances. Returns true only when a file was actually removed.
 */
async function deleteStats(uuid: string): Promise<boolean> {
  const statsDir = await resolveStatsDir();
  if (statsDir === null) return false;
  // A-11: same path.relative() traversal guard as getStats — the route
  // additionally enforces the UUID allowlist, this is defence in depth.
  const resolved = path.resolve(statsDir, `${uuid}.json`);
  const rel = path.relative(statsDir, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  try {
    await fsp.rm(resolved);
    return true;
  } catch {
    return false;
  }
}

  /**
   * Every player's stats in one call, bounded to STATS_READ_CONCURRENCY
   * concurrent reads instead of the caller firing one HTTP request per uuid
   * (which is what forced this route to exist: a lifetime player count of a
   * few hundred meant a few hundred simultaneous requests for one
   * leaderboard build).
   */
  async function loadAllStats(): Promise<Record<string, unknown>> {
    const uuids = await listStatsUuids();
    const entries = await mapLimit(
      uuids,
      STATS_READ_CONCURRENCY,
      async (uuid) => [uuid, await getStats(uuid)] as const,
    );
    const out: Record<string, unknown> = {};
    for (const [uuid, stats] of entries) if (stats !== null) out[uuid] = stats;
    return out;
  }

  const allStatsCache = cached(loadAllStats, {
    freshMs: ALL_STATS_FRESH_MS,
    staleMs: ALL_STATS_STALE_MS,
  });

  async function getAllStats(): Promise<Record<string, unknown>> {
    return (await allStatsCache.get()).value;
  }

  return {
    getStats,
    listStatsUuids,
    deleteStats: async (uuid: string) => {
      const deleted = await deleteStats(uuid);
      if (deleted) allStatsCache.invalidate();
      return deleted;
    },
    getAllStats,
  };
}
