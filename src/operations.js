"use strict";

const fs = require("fs");
const path = require("path");
const { execFile, spawn } = require("child_process");

const { RconClient } = require("./rcon");
const {
  SERVER_PATH,
  INSTANCE_NAME,
  LINUX_USER,
  USE_RCON,
  RCON_HOST,
  RCON_PORT,
  RCON_PASSWORD,
  BACKUPS_PATH,
  INSTANCE_SCRIPTS_DIR,
} = require("./config");

// ── RCON singleton ────────────────────────────────────────────────────────

const rcon =
  USE_RCON && RCON_PASSWORD
    ? new RconClient(RCON_HOST, RCON_PORT, RCON_PASSWORD)
    : null;

// ── Script configuration ──────────────────────────────────────────────────

const SCRIPT_MAP = {
  start: "start.sh",
  stop: "shutdown.sh",
  restart: "smart_restart.sh",
  backup: "backup/backup.sh",
  status: "misc/status.sh",
};

const SCRIPT_TIMEOUTS = {
  start: 30_000,
  stop: 60_000,
  restart: 60_000,
  backup: 300_000,
  status: 15_000,
};

// ── Exported operations ───────────────────────────────────────────────────

async function sendCommand(command) {
  if (rcon) {
    try {
      const cmd = command.startsWith("/") ? command.slice(1) : command;
      return await rcon.send(cmd);
    } catch {
      // fall through to screen
    }
  }
  const formatted = command.startsWith("/") ? command : `/${command}`;

  // A-01: strip CR, LF and all other control characters before handing the
  // string to `screen stuff`. A command containing \r would be interpreted
  // by screen as multiple key-presses and could inject additional commands.
  const safe = formatted.replace(/[\r\n\x00-\x1f\x7f]/g, "");

  await new Promise((resolve) => {
    execFile(
      "sudo",
      [
        "-n",
        "-u",
        LINUX_USER,
        "screen",
        "-S",
        INSTANCE_NAME,
        "-X",
        "stuff",
        `${safe}\r`,
      ],
      { timeout: 15_000 },
      (err) => {
        if (err)
          console.warn(`[api-server] screen send failed: ${err.message}`);
        resolve();
      },
    );
  });
  return null;
}

async function isRunning() {
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
  return new Promise((resolve) => {
    execFile(
      "sudo",
      ["-n", "-u", LINUX_USER, "screen", "-list"],
      { timeout: 10_000 },
      (err, stdout) => {
        // F-011: escape INSTANCE_NAME before embedding in regex so names like
        // "server.1" don't silently misfire on the dot metacharacter.
        const escaped = INSTANCE_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        resolve(
          !err && new RegExp(`\\b\\d+\\.${escaped}\\b`).test(stdout),
        );
      },
    );
  });
}

async function getList() {
  if (rcon) {
    try {
      const r = await rcon.send("list");
      const cm = r.match(
        /There are\s+(\d+)\s*(?:of a max of\s*(\d+)|\/\s*(\d+))\s*players online/i,
      );
      const pm = r.match(/players online:\s*(.*)$/i);
      return {
        playerCount: cm?.[1] ?? "0",
        maxPlayers: cm?.[2] ?? cm?.[3] ?? "?",
        players: pm?.[1]
          ? pm[1]
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : [],
      };
    } catch {
      /* fall through */
    }
  }
  return { playerCount: "0", maxPlayers: "?", players: [] };
}

async function getTps() {
  if (!rcon) return null;

  // Try Paper-style /tps first
  try {
    const r = await rcon.send("tps");
    if (r.toLowerCase().includes("unknown")) {
      // Server does not know this command — fall through to tick query.
    } else {
      const m =
        r.match(/:\s*\*?([\d.]+),\s*\*?([\d.]+),\s*\*?([\d.]+)/) ??
        r.match(/^\s*\*?([\d.]+),\s*\*?([\d.]+),\s*\*?([\d.]+)/m);
      if (m) {
        return {
          type: "paper",
          tps1m: parseFloat(m[1]),
          tps5m: parseFloat(m[2]),
          tps15m: parseFloat(m[3]),
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

    const msptMatch = r.match(/Average time per tick:\s*([\d.]+)\s*ms/i);
    if (!msptMatch) return null; // unparseable response — do not signal 0 TPS

    const mspt = parseFloat(msptMatch[1]);
    const result = {
      type: "vanilla",
      tps1m: Math.min(20, 1000 / mspt),
      mspt,
      raw: r,
    };
    const p50 = r.match(/P50:\s*([\d.]+)\s*ms/i);
    const p95 = r.match(/P95:\s*([\d.]+)\s*ms/i);
    const p99 = r.match(/P99:\s*([\d.]+)\s*ms/i);
    if (p50?.[1]) result.p50 = parseFloat(p50[1]);
    if (p95?.[1]) result.p95 = parseFloat(p95[1]);
    if (p99?.[1]) result.p99 = parseFloat(p99[1]);
    return result;
  } catch {
    return null;
  }
}

// A-03: cache level-name for 60 s — server.properties rarely changes at
// runtime and getLevelName() is called on every getStats/listStatsUuids
// request, making repeated synchronous readFileSync calls unnecessary.
let _levelNameCache = null;
let _levelNameCachedAt = 0;
const LEVEL_NAME_TTL_MS = 60_000;

async function getLevelName() {
  if (_levelNameCache && Date.now() - _levelNameCachedAt < LEVEL_NAME_TTL_MS) {
    return _levelNameCache;
  }
  const propsPath = path.join(SERVER_PATH, "server.properties");
  try {
    const text = fs.readFileSync(propsPath, "utf-8");
    const m = text.match(/^level-name\s*=\s*(.+)$/m);
    _levelNameCache = m?.[1]?.trim() ?? "world";
  } catch {
    _levelNameCache = "world";
  }
  _levelNameCachedAt = Date.now();
  return _levelNameCache;
}

async function tailLog(lines) {
  const logFile = path.join(SERVER_PATH, "logs", "latest.log");
  return new Promise((resolve) => {
    execFile(
      "tail",
      ["-n", String(lines), logFile],
      { timeout: 5000 },
      (err, stdout) => {
        resolve(err ? "" : stdout);
      },
    );
  });
}

function getWhitelist() {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(SERVER_PATH, "whitelist.json"), "utf-8"),
    );
  } catch {
    return [];
  }
}

async function getStats(uuid) {
  const levelName = await getLevelName();
  const statsDir = path.join(SERVER_PATH, levelName, "stats");

  // A-11: use path.relative() instead of startsWith() — more robust across
  // platforms and avoids edge cases where statsDir itself has no trailing sep.
  const resolved = path.resolve(statsDir, `${uuid}.json`);
  const rel = path.relative(statsDir, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;

  try {
    return JSON.parse(fs.readFileSync(resolved, "utf-8"));
  } catch {
    return null;
  }
}

async function listStatsUuids() {
  const levelName = await getLevelName();
  const dir = path.join(SERVER_PATH, levelName, "stats");
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
}

// A-04: remove TOCTOU existsSync/statSync/readFileSync sequence — use a
// single try/catch instead, consistent with getWhitelist() and getStats().
// Only re-throw errors that are not "file not found".
function getModSlugs() {
  const jsonPath = path.join(
    INSTANCE_SCRIPTS_DIR,
    "common",
    "downloaded_versions.json",
  );
  try {
    const stat = fs.statSync(jsonPath);
    const raw = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    return { slugs: Object.keys(raw.mods ?? {}), mtimeMs: stat.mtimeMs };
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err; // surface genuine parse errors as 500
  }
}

function getBackups() {
  const subdirs = [
    "hourly",
    "archives/daily",
    "archives/weekly",
    "archives/monthly",
    "archives/update",
  ];
  const dirs = [];
  let totalBytes = 0;

  for (const dir of subdirs) {
    const fullDir = path.join(BACKUPS_PATH, dir);
    if (!fs.existsSync(fullDir)) continue;

    const files = fs
      .readdirSync(fullDir)
      .filter((f) => f.endsWith(".tar.zst") || f.endsWith(".tar.gz"));
    if (!files.length) continue;

    files.sort().reverse();
    const latest = files[0];

    // A-06: stat the latest file inside its own try/catch — backup rotation
    // can delete the file between readdirSync and statSync, which would throw
    // ENOENT and abort the entire response. Skip this directory instead.
    let stat;
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

function runScript(action, args) {
  const scriptRelPath = SCRIPT_MAP[action];
  if (!scriptRelPath) throw new Error(`Unknown script action: ${action}`);

  const scriptPath = path.join(INSTANCE_SCRIPTS_DIR, scriptRelPath);
  if (!fs.existsSync(scriptPath))
    throw new Error(`Script not found: ${scriptPath}`);

  const timeoutMs = SCRIPT_TIMEOUTS[action] ?? 120_000;

  return new Promise((resolve, reject) => {
    const child = spawn(
      "sudo",
      ["-n", "-u", LINUX_USER, "bash", scriptPath, ...(args || [])],
      {
        cwd: INSTANCE_SCRIPTS_DIR,
        env: { ...process.env, HOME: `/home/${LINUX_USER}` },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      // A-02: SIGTERM to the sudo wrapper does not reach the actual script
      // process, which has already been forked as LINUX_USER. Kill the whole
      // process group by signalling the negative PID (POSIX process groups).
      // Falls back to a direct child.kill() if the pgid signal fails.
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      reject(
        new Error(
          `Script timed out after ${timeoutMs / 1000}s\n\nOutput:\n${stdout.slice(-500)}`,
        ),
      );
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("close", (code) => {
      if (killed) return;
      clearTimeout(timer);

      if (/\[SUDO ERROR\]/i.test(`${stdout}\n${stderr}`)) {
        reject(
          new Error(
            `Sudo not configured for '${LINUX_USER}'. See docs/sudoers-setup.md.`,
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

module.exports = {
  sendCommand,
  isRunning,
  getList,
  getTps,
  getLevelName,
  tailLog,
  getWhitelist,
  getStats,
  listStatsUuids,
  getModSlugs,
  getBackups,
  runScript,
};
