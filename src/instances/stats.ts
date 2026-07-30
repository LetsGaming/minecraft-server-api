/**
 * Player stat files. The directory layout is probed rather than assumed —
 * see resolveStatsDir for why a wrong guess here fails silently.
 */
import fsp from "fs/promises";
import path from "path";

import { log } from "../platform/logger.js";
import type { World } from "./world.js";
import type { InstanceConfig } from "../config/types.js";

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
async function resolveStatsDir(): Promise<string> {
  const levelName = await world.getLevelName();
  if (_statsDir && _statsDir.levelName === levelName) return _statsDir.dir;

  for (const rel of STATS_DIR_CANDIDATES) {
    const dir = path.join(cfg.serverPath, levelName, rel);
    try {
      if (!(await fsp.stat(dir)).isDirectory()) continue;
    } catch {
      continue; // next candidate
    }
    _statsDir = { levelName, dir };
    log.info("stats", `[${cfg.id}] Reading player stats from ${dir}`);
    return dir;
  }

  // None exist yet — which is normal on a fresh world, since the server
  // creates the directory when someone first plays. Return the vanilla
  // path so messages name the expected location, and do not cache: the
  // real one appears later and must be picked up without a restart.
  return path.join(cfg.serverPath, levelName, STATS_DIR_CANDIDATES[0]!);
}

async function getStats(uuid: string): Promise<unknown> {
  const statsDir = await resolveStatsDir();
  // A-11: path.relative() guard — more robust than startsWith()
  const resolved = path.resolve(statsDir, `${uuid}.json`);
  const rel = path.relative(statsDir, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  try {
    return JSON.parse(await fsp.readFile(resolved, "utf-8")) as unknown;
  } catch {
    return null;
  }
}

async function listStatsUuids(): Promise<string[]> {
  const dir = await resolveStatsDir();
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

  return { getStats, listStatsUuids, deleteStats };
}
