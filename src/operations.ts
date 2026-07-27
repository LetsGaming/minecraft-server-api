/**
 * Per-instance operations bundle. Created once per configured instance
 * at startup; reused across requests. Every filesystem/shell/RCON touch
 * for server data lives here — routes stay thin.
 */
import fsp from "fs/promises";
import path from "path";
import { execFile, spawn } from "child_process";

import { RconClient } from "./rcon.js";
import { cached } from "./cache.js";
import { createHealthMonitor } from "./health.js";
import { execSafe } from "./exec.js";
import { log } from "./logger.js";
import type {
  BackupDirInfo,
  BackupSummary,
  Capabilities,
  InstanceConfig,
  InstanceHealth,
  PlayerList,
  ScriptResult,
  Tps,
  WhitelistEntry,
} from "./types.js";

// ── Script configuration ──────────────────────────────────────────────────

export const SCRIPT_MAP: Record<string, string> = {
  start: "start.sh",
  stop: "shutdown.sh",
  restart: "smart_restart.sh",
  backup: "backup/backup.sh",
  status: "misc/status.sh",
};

const SCRIPT_TIMEOUTS: Record<string, number> = {
  start: 30_000,
  stop: 60_000,
  restart: 60_000,
  backup: 300_000,
  status: 15_000,
};

// TPS moves slowly and costs an RCON round-trip against the very thread that
// is struggling when anyone bothers to ask. Two callers a second apart share
// one measurement; a loaded server serves the last one rather than queueing.
const TPS_FRESH_MS = 5_000;
const TPS_STALE_MS = 30_000;

export type Operations = ReturnType<typeof createOperations>;

/**
 * A-01: strip CR, LF, and all other control characters before handing a
 * string to `screen stuff`. A command containing \r would be interpreted
 * by screen as multiple key-presses. Exported for direct testing.
 */
export function sanitizeScreenCommand(command: string): string {
  return command.replace(/[\r\n\x00-\x1f\x7f]/g, "");
}

/** Non-blocking existsSync. Every probe here sits on the request path. */
async function exists(target: string): Promise<boolean> {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

// ── Factory ───────────────────────────────────────────────────────────────

export function createOperations(cfg: InstanceConfig) {
  // ── RCON singleton — one per instance ────────────────────────────────
  const rcon =
    cfg.useRcon && cfg.rconPassword
      ? new RconClient(cfg.rconHost, cfg.rconPort, cfg.rconPassword)
      : null;

  // ── Health — the one place liveness and responsiveness are decided ────
  // Shared by isRunning, getHealth and getList so a status poll, a player
  // list and a liveness check between them cost one RCON round-trip.
  const health = createHealthMonitor(cfg, rcon, () => getGamePort());

  // ── Level-name cache — per instance (A-03) ────────────────────────────
  let _levelNameCache: string | null = null;
  let _levelNameCachedAt = 0;
  let _gamePortCache: number | null | undefined = undefined;
  let _gamePortAt = 0;
  const LEVEL_NAME_TTL_MS = 60_000;

  // ── Operations ────────────────────────────────────────────────────────

  async function sendCommand(command: string): Promise<string | null> {
    if (rcon) {
      try {
        const cmd = command.startsWith("/") ? command.slice(1) : command;
        return await rcon.send(cmd);
      } catch {
        // fall through to screen
      }
    }
    const formatted = command.startsWith("/") ? command : `/${command}`;
    const safe = sanitizeScreenCommand(formatted); // A-01

    await new Promise<void>((resolve) => {
      execFile(
        "sudo",
        ["-n", "-u", cfg.linuxUser, "screen", "-S", cfg.id, "-X", "stuff", `${safe}\r`],
        { timeout: 15_000 },
        (err) => {
          if (err) log.warn(cfg.id, `screen send failed: ${err.message}`);
          resolve();
        },
      );
    });
    return null;
  }

  /** Full three-state health — see health.ts for why one boolean was not enough. */
  async function getHealth(): Promise<InstanceHealth> {
    return health.get();
  }

  /**
   * Legacy boolean. It now means "the server process is up", which is what
   * every caller always wanted it to mean — it used to mean "RCON answered
   * within three seconds", so a loaded server reported itself stopped.
   * New clients should read /health and handle `unresponsive` explicitly.
   */
  async function isRunning(): Promise<boolean> {
    return (await health.get()).state !== "offline";
  }

  async function getList(): Promise<PlayerList> {
    return health.getList();
  }

  async function loadTps(): Promise<Tps> {
    if (!rcon) return null;

    // Try Paper-style /tps first
    try {
      const r = await rcon.send("tps");
      if (!r.toLowerCase().includes("unknown")) {
        const m =
          /:\s*\*?([\d.]+),\s*\*?([\d.]+),\s*\*?([\d.]+)/.exec(r) ??
          /^\s*\*?([\d.]+),\s*\*?([\d.]+),\s*\*?([\d.]+)/m.exec(r);
        if (m) {
          return {
            type: "paper",
            tps1m: parseFloat(m[1]!),
            tps5m: parseFloat(m[2]!),
            tps15m: parseFloat(m[3]!),
            raw: r,
          };
        }
      }
    } catch {
      /* try vanilla */
    }

    // Vanilla /tick query fallback
    try {
      const r = await rcon.send("tick query");
      if (r.toLowerCase().includes("unknown")) return null;
      const msptMatch = /Average time per tick:\s*([\d.]+)\s*ms/i.exec(r);
      if (!msptMatch) return null;
      const mspt = parseFloat(msptMatch[1]!);
      const result: Tps = {
        type: "vanilla",
        tps1m: Math.min(20, 1000 / mspt),
        mspt,
        raw: r,
      };
      const p50 = /P50:\s*([\d.]+)\s*ms/i.exec(r);
      const p95 = /P95:\s*([\d.]+)\s*ms/i.exec(r);
      const p99 = /P99:\s*([\d.]+)\s*ms/i.exec(r);
      if (p50?.[1]) result.p50 = parseFloat(p50[1]);
      if (p95?.[1]) result.p95 = parseFloat(p95[1]);
      if (p99?.[1]) result.p99 = parseFloat(p99[1]);
      return result;
    } catch {
      return null;
    }
  }

  const tpsCache = cached(loadTps, {
    freshMs: TPS_FRESH_MS,
    staleMs: TPS_STALE_MS,
  });

  async function getTps(): Promise<Tps> {
    return (await tpsCache.get()).value;
  }

  /**
   * Layouts we know of, in order. Vanilla first — it is the documented
   * default and what an unmodded server writes.
   */
  const STATS_DIR_CANDIDATES = ["stats", path.join("players", "stats")];

  let _statsDir: { levelName: string; dir: string } | null = null;

  async function getLevelName(): Promise<string> {
    if (_levelNameCache && Date.now() - _levelNameCachedAt < LEVEL_NAME_TTL_MS) {
      return _levelNameCache;
    }
    const propsPath = path.join(cfg.serverPath, "server.properties");
    try {
      const text = await fsp.readFile(propsPath, "utf-8");
      const m = /^level-name\s*=\s*(.+)$/m.exec(text);
      _levelNameCache = m?.[1]?.trim() ?? "world";
    } catch {
      _levelNameCache = "world";
    }
    _levelNameCachedAt = Date.now();
    return _levelNameCache;
  }

  /**
   * `server-port` from server.properties, cached like the level name.
   *
   * Reported on /health so a client knows where to ping the game server
   * directly — which matters exactly when this wrapper is unreachable and
   * cannot be asked.
   */
  async function getGamePort(): Promise<number | null> {
    if (_gamePortCache !== undefined && Date.now() - _gamePortAt < LEVEL_NAME_TTL_MS) {
      return _gamePortCache;
    }
    try {
      const text = await fsp.readFile(
        path.join(cfg.serverPath, "server.properties"),
        "utf-8",
      );
      const m = /^server-port\s*=\s*(\d{1,5})\s*$/m.exec(text);
      const port = m?.[1] ? Number(m[1]) : NaN;
      _gamePortCache = Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
    } catch {
      _gamePortCache = null;
    }
    _gamePortAt = Date.now();
    return _gamePortCache;
  }

  async function tailLog(lines: number): Promise<string> {
    const logFile = path.join(cfg.serverPath, "logs", "latest.log");
    const { stdout, ok } = await execSafe("tail", ["-n", String(lines), logFile]);
    return ok ? stdout : "";
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
    const levelName = await getLevelName();
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

  /**
   * M-13 (bot-side capability detection): report which setup-suite
   * artifacts exist for this instance. The response shape must stay in
   * sync with the bot's ServerCapabilities type — bots probe
   * GET /instances/:id/capabilities and fall back to assuming everything
   * is available when the route is missing (older wrappers).
   */
  async function getCapabilities(): Promise<Capabilities> {
    const scriptExists = async (rel: string): Promise<boolean> =>
      !!cfg.scriptsDir && (await exists(path.join(cfg.scriptsDir, rel)));
    // Independent probes, so run them together rather than serially — this
    // is up to eight stat() calls on a disk the server may be hammering.
    const [start, stop, restart, backup, status, backups, modManifest, variablesFile] =
      await Promise.all([
        scriptExists(SCRIPT_MAP.start!),
        scriptExists(SCRIPT_MAP.stop!),
        scriptExists(SCRIPT_MAP.restart!),
        scriptExists(SCRIPT_MAP.backup!),
        scriptExists(SCRIPT_MAP.status!),
        cfg.backupsPath ? exists(cfg.backupsPath) : Promise.resolve(false),
        scriptExists(path.join("common", "downloaded_versions.json")),
        scriptExists(path.join("common", "variables.txt")),
      ]);
    return {
      scripts: { start, stop, restart, backup, status },
      backups,
      modManifest,
      variablesFile,
    };
  }

  async function getModSlugs(): Promise<{
    slugs: string[];
    mtimeMs: number;
  } | null> {
    // A-04: single try/catch — avoids TOCTOU exists/stat/read
    const jsonPath = path.join(cfg.scriptsDir, "common", "downloaded_versions.json");
    try {
      const stat = await fsp.stat(jsonPath);
      const raw = JSON.parse(await fsp.readFile(jsonPath, "utf-8")) as {
        mods?: Record<string, unknown>;
      };
      return { slugs: Object.keys(raw.mods ?? {}), mtimeMs: stat.mtimeMs };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async function getBackups(): Promise<BackupSummary> {
    if (!cfg.backupsPath) return { dirs: [], totalBytes: 0 };

    const subdirs = [
      "hourly",
      "archives/daily",
      "archives/weekly",
      "archives/monthly",
      "archives/update",
    ];
    const backupsPath = cfg.backupsPath;

    // Backup tiers accumulate thousands of archives, and this used to be
    // five synchronous readdir + stat passes on the event loop — every other
    // request, /health included, waited behind it. Async, and the five tiers
    // in parallel.
    async function readTier(dir: string): Promise<BackupDirInfo | null> {
      const fullDir = path.join(backupsPath, dir);
      let files: string[];
      try {
        files = (await fsp.readdir(fullDir)).filter(
          (f) => f.endsWith(".tar.zst") || f.endsWith(".tar.gz"),
        );
      } catch {
        return null; // tier not present
      }
      if (!files.length) return null;

      files.sort().reverse();
      const latest = files[0]!;
      // A-06: backup rotation can delete the file between readdir and stat;
      // skip this tier rather than fail the whole response.
      try {
        const stat = await fsp.stat(path.join(fullDir, latest));
        return {
          dir,
          count: files.length,
          latestFile: latest,
          latestMtimeMs: stat.mtimeMs,
          latestSizeBytes: stat.size,
        };
      } catch {
        return null;
      }
    }

    const dirs = (await Promise.all(subdirs.map(readTier))).filter(
      (d): d is BackupDirInfo => d !== null,
    );
    return {
      dirs,
      totalBytes: dirs.reduce((sum, d) => sum + d.latestSizeBytes, 0),
    };
  }

  async function runScript(action: string, args?: string[]): Promise<ScriptResult> {
    const scriptRelPath = SCRIPT_MAP[action];
    if (!scriptRelPath) throw new Error(`Unknown script action: ${action}`);

    const scriptPath = path.join(cfg.scriptsDir, scriptRelPath);
    if (!(await exists(scriptPath)))
      throw new Error(`Script not found: ${scriptPath}`);

    const timeoutMs = SCRIPT_TIMEOUTS[action] ?? 120_000;

    return new Promise((resolve, reject) => {
      const child = spawn(
        "sudo",
        ["-n", "-u", cfg.linuxUser, "bash", scriptPath, ...(args ?? [])],
        {
          cwd: cfg.scriptsDir,
          env: { ...process.env, HOME: `/home/${cfg.linuxUser}` },
          stdio: ["ignore", "pipe", "pipe"],
          // BUG-01: process-group leader so the A-02 group kill below
          // (process.kill(-child.pid)) actually targets a real group.
          detached: true,
        },
      );

      let stdout = "";
      let stderr = "";
      let killed = false;

      const timer = setTimeout(() => {
        killed = true;
        // A-02: kill the process group so the actual script (already forked
        // as LINUX_USER by sudo) also receives SIGTERM.
        try {
          process.kill(-child.pid!, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
        reject(
          new Error(
            `Script timed out after ${timeoutMs / 1000}s\n\nOutput:\n${stdout.slice(-500)}`,
          ),
        );
      }, timeoutMs);

      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
      });

      child.on("close", (code) => {
        if (killed) return;
        clearTimeout(timer);

        if (/\[SUDO ERROR\]/i.test(`${stdout}\n${stderr}`)) {
          reject(
            new Error(
              `Sudo not configured for '${cfg.linuxUser}'. See docs/sudoers-setup.md.`,
            ),
          );
          return;
        }

        stderr = stderr
          .split("\n")
          .filter((l) => !l.includes("[sudo]") && !l.includes("password for"))
          .join("\n")
          .trim();

        resolve({ output: stdout.trim(), stderr, exitCode: code });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`Failed to start script: ${err.message}`));
      });
    });
  }

  return {
    sendCommand,
    getHealth,
    isRunning,
    getList,
    getTps,
    getLevelName,
    tailLog,
    getWhitelist,
    getUserCache,
    getStats,
    listStatsUuids,
    deleteStats,
    getCapabilities,
    getModSlugs,
    getBackups,
    runScript,
  };
}
