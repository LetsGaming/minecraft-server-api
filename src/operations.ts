/**
 * Per-instance operations bundle. Created once per configured instance
 * at startup; reused across requests. Every filesystem/shell/RCON touch
 * for server data lives here — routes stay thin.
 */
import fs from "fs";
import path from "path";
import { execFile, spawn } from "child_process";

import { RconClient } from "./rcon.js";
import { execSafe } from "./exec.js";
import { log } from "./logger.js";
import type {
  BackupDirInfo,
  BackupSummary,
  Capabilities,
  InstanceConfig,
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

export type Operations = ReturnType<typeof createOperations>;

/**
 * A-01: strip CR, LF, and all other control characters before handing a
 * string to `screen stuff`. A command containing \r would be interpreted
 * by screen as multiple key-presses. Exported for direct testing.
 */
export function sanitizeScreenCommand(command: string): string {
  return command.replace(/[\r\n\x00-\x1f\x7f]/g, "");
}

// ── Factory ───────────────────────────────────────────────────────────────

export function createOperations(cfg: InstanceConfig) {
  // ── RCON singleton — one per instance ────────────────────────────────
  const rcon =
    cfg.useRcon && cfg.rconPassword
      ? new RconClient(cfg.rconHost, cfg.rconPort, cfg.rconPassword)
      : null;

  // ── Level-name cache — per instance (A-03) ────────────────────────────
  let _levelNameCache: string | null = null;
  let _levelNameCachedAt = 0;
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

  async function isRunning(): Promise<boolean> {
    if (rcon) {
      if (Date.now() - rcon.lastSuccessTime < 15_000) return true;
      for (let i = 0; i < 2; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, 500));
        try {
          await rcon.send("list", 3000);
          return true;
        } catch {
          /* try again */
        }
      }
      return false;
    }
    const { stdout, ok } = await execSafe(
      "sudo",
      ["-n", "-u", cfg.linuxUser, "screen", "-list"],
      10_000,
    );
    if (!ok) return false;
    // F-011: escape instance name before embedding in regex so names
    // like "server.1" don't silently misfire on the dot metacharacter.
    const escaped = cfg.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b\\d+\\.${escaped}\\b`).test(stdout);
  }

  async function getList(): Promise<PlayerList> {
    if (rcon) {
      try {
        const r = await rcon.send("list");
        const cm =
          /There are\s+(\d+)\s*(?:of a max of\s*(\d+)|\/\s*(\d+))\s*players online/i.exec(
            r,
          );
        const pm = /players online:\s*(.*)$/i.exec(r);
        return {
          playerCount: cm?.[1] ?? "0",
          maxPlayers: cm?.[2] ?? cm?.[3] ?? "?",
          players: pm?.[1]
            ? pm[1].split(",").map((s) => s.trim()).filter(Boolean)
            : [],
        };
      } catch {
        /* fall through */
      }
    }
    return { playerCount: "0", maxPlayers: "?", players: [] };
  }

  async function getTps(): Promise<Tps> {
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

  async function getLevelName(): Promise<string> {
    if (_levelNameCache && Date.now() - _levelNameCachedAt < LEVEL_NAME_TTL_MS) {
      return _levelNameCache;
    }
    const propsPath = path.join(cfg.serverPath, "server.properties");
    try {
      const text = fs.readFileSync(propsPath, "utf-8");
      const m = /^level-name\s*=\s*(.+)$/m.exec(text);
      _levelNameCache = m?.[1]?.trim() ?? "world";
    } catch {
      _levelNameCache = "world";
    }
    _levelNameCachedAt = Date.now();
    return _levelNameCache;
  }

  async function tailLog(lines: number): Promise<string> {
    const logFile = path.join(cfg.serverPath, "logs", "latest.log");
    const { stdout, ok } = await execSafe("tail", ["-n", String(lines), logFile]);
    return ok ? stdout : "";
  }

  function getWhitelist(): unknown[] {
    try {
      const data: unknown = JSON.parse(
        fs.readFileSync(path.join(cfg.serverPath, "whitelist.json"), "utf-8"),
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
  function getUserCache(): WhitelistEntry[] {
    try {
      const data: unknown = JSON.parse(
        fs.readFileSync(path.join(cfg.serverPath, "usercache.json"), "utf-8"),
      );
      if (!Array.isArray(data)) return [];
      return (data as Array<{ name?: unknown; uuid?: unknown }>)
        .filter((e) => typeof e?.name === "string" && typeof e?.uuid === "string")
        .map((e) => ({ name: e.name as string, uuid: e.uuid as string }));
    } catch {
      return [];
    }
  }

  async function getStats(uuid: string): Promise<unknown> {
    const levelName = await getLevelName();
    const statsDir = path.join(cfg.serverPath, levelName, "stats");
    // A-11: path.relative() guard — more robust than startsWith()
    const resolved = path.resolve(statsDir, `${uuid}.json`);
    const rel = path.relative(statsDir, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
    try {
      return JSON.parse(fs.readFileSync(resolved, "utf-8")) as unknown;
    } catch {
      return null;
    }
  }

  async function listStatsUuids(): Promise<string[]> {
    const levelName = await getLevelName();
    const dir = path.join(cfg.serverPath, levelName, "stats");
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -5));
    } catch {
      return [];
    }
  }

  /**
   * H-05 companion: delete a player's stats file. Powers the bot's
   * explicit, admin-gated `/server prune-stats` command on remote
   * instances. Returns true only when a file was actually removed.
   */
  async function deleteStats(uuid: string): Promise<boolean> {
    const levelName = await getLevelName();
    const statsDir = path.join(cfg.serverPath, levelName, "stats");
    // A-11: same path.relative() traversal guard as getStats — the route
    // additionally enforces the UUID allowlist, this is defence in depth.
    const resolved = path.resolve(statsDir, `${uuid}.json`);
    const rel = path.relative(statsDir, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
    try {
      fs.rmSync(resolved);
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
  function getCapabilities(): Capabilities {
    const scriptExists = (rel: string): boolean =>
      !!cfg.scriptsDir && fs.existsSync(path.join(cfg.scriptsDir, rel));
    return {
      scripts: {
        start: scriptExists(SCRIPT_MAP.start!),
        stop: scriptExists(SCRIPT_MAP.stop!),
        restart: scriptExists(SCRIPT_MAP.restart!),
        backup: scriptExists(SCRIPT_MAP.backup!),
        status: scriptExists(SCRIPT_MAP.status!),
      },
      backups: !!cfg.backupsPath && fs.existsSync(cfg.backupsPath),
      modManifest: scriptExists(path.join("common", "downloaded_versions.json")),
      variablesFile: scriptExists(path.join("common", "variables.txt")),
    };
  }

  function getModSlugs(): { slugs: string[]; mtimeMs: number } | null {
    // A-04: single try/catch — avoids TOCTOU existsSync/statSync/readFileSync
    const jsonPath = path.join(cfg.scriptsDir, "common", "downloaded_versions.json");
    try {
      const stat = fs.statSync(jsonPath);
      const raw = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as {
        mods?: Record<string, unknown>;
      };
      return { slugs: Object.keys(raw.mods ?? {}), mtimeMs: stat.mtimeMs };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  function getBackups(): BackupSummary {
    if (!cfg.backupsPath) return { dirs: [], totalBytes: 0 };

    const subdirs = [
      "hourly",
      "archives/daily",
      "archives/weekly",
      "archives/monthly",
      "archives/update",
    ];
    const dirs: BackupDirInfo[] = [];
    let totalBytes = 0;

    for (const dir of subdirs) {
      const fullDir = path.join(cfg.backupsPath, dir);
      if (!fs.existsSync(fullDir)) continue;

      const files = fs
        .readdirSync(fullDir)
        .filter((f) => f.endsWith(".tar.zst") || f.endsWith(".tar.gz"));
      if (!files.length) continue;

      files.sort().reverse();
      const latest = files[0]!;
      // A-06: stat in its own try/catch — backup rotation can delete the
      // file between readdirSync and statSync; skip this dir rather than crash.
      let stat: fs.Stats;
      try {
        stat = fs.statSync(path.join(fullDir, latest));
      } catch {
        continue;
      }
      totalBytes += stat.size;
      dirs.push({
        dir,
        count: files.length,
        latestFile: latest,
        latestMtimeMs: stat.mtimeMs,
        latestSizeBytes: stat.size,
      });
    }

    return { dirs, totalBytes };
  }

  function runScript(action: string, args?: string[]): Promise<ScriptResult> {
    const scriptRelPath = SCRIPT_MAP[action];
    if (!scriptRelPath) throw new Error(`Unknown script action: ${action}`);

    const scriptPath = path.join(cfg.scriptsDir, scriptRelPath);
    if (!fs.existsSync(scriptPath)) throw new Error(`Script not found: ${scriptPath}`);

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
