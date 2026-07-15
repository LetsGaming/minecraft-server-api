/**
 * Operations-level invariants — every case here encodes an audit finding
 * (A-01, A-03, A-11, F-001, F-009, H-05, M-13) and must keep passing
 * verbatim across refactors.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createOperations, sanitizeScreenCommand } from "../src/operations.js";
import { sanitizeLines, UUID_RE, validateArgs } from "../src/routes/instances.js";
import type { InstanceConfig } from "../src/types.js";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

function scaffold(): { cfg: InstanceConfig; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ops-"));
  roots.push(root);
  const serverPath = path.join(root, "server");
  const scriptsDir = path.join(root, "scripts");
  fs.mkdirSync(serverPath, { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });
  return {
    root,
    cfg: {
      id: "test",
      serverPath,
      linuxUser: "minecraft",
      useRcon: false,
      rconHost: "localhost",
      rconPort: 25575,
      rconPassword: "",
      backupsPath: "",
      scriptsDir,
    },
  };
}

// ── F-009: tail lines sanitisation ──────────────────────────────────────

describe("tailLog lines parameter validation (F-009)", () => {
  it("clamps to 500 for large integers", () => expect(sanitizeLines("9999")).toBe(500));
  it("blocks scientific notation bypass", () => expect(sanitizeLines("1e6")).toBe(1));
  it("falls back to 10 for NaN input", () => expect(sanitizeLines("abc")).toBe(10));
  it("passes through a normal value", () => expect(sanitizeLines("50")).toBe(50));
  it("clamps minimum to 1 (zero)", () => expect(sanitizeLines("0")).toBe(1));
  it("clamps minimum to 1 (negative)", () => expect(sanitizeLines("-5")).toBe(1));
  it("defaults to 10 when absent", () => expect(sanitizeLines(undefined)).toBe(10));
});

// ── F-001: UUID allowlist ───────────────────────────────────────────────

describe("UUID allowlist regex (F-001)", () => {
  const valid = [
    "069a79f4-44e9-4726-a5be-fca90e38aaf5",
    "853C80EF-3C37-49FD-AA49-938B674ADAE6",
  ];
  const invalid = [
    "../../../etc/passwd",
    "069a79f444e94726a5befca90e38aaf5", // no dashes
    "069a79f4-44e9-4726-a5be-fca90e38aaf5.json",
    "",
    "g69a79f4-44e9-4726-a5be-fca90e38aaf5",
  ];
  for (const u of valid) it(`accepts ${u}`, () => expect(UUID_RE.test(u)).toBe(true));
  for (const u of invalid) it(`rejects "${u}"`, () => expect(UUID_RE.test(u)).toBe(false));
});

// ── F-001: script args allowlist ────────────────────────────────────────

describe("script args validation (F-001)", () => {
  it("accepts undefined", () => expect(validateArgs(undefined)).toBe(true));
  it("accepts simple safe args", () => expect(validateArgs(["daily", "v1.2"])).toBe(true));
  it("rejects a path-traversal arg", () => expect(validateArgs(["../../evil.sh"])).toBe(false));
  it("rejects a forward slash", () => expect(validateArgs(["a/b"])).toBe(false));
  it("rejects more than 5 args", () =>
    expect(validateArgs(["a", "b", "c", "d", "e", "f"])).toBe(false));
  it("rejects non-string entries", () => expect(validateArgs([42])).toBe(false));
  it("rejects shell metacharacters", () => expect(validateArgs(["a;rm"])).toBe(false));
});

// ── A-01: screen command sanitisation ───────────────────────────────────

describe("sendCommand screen injection sanitisation (A-01)", () => {
  it("strips carriage return that would inject a second command", () => {
    const out = sanitizeScreenCommand("/say hi\rstop");
    expect(out.includes("\r")).toBe(false);
    expect(out).toBe("/say histop");
  });
  it("strips newline", () =>
    expect(sanitizeScreenCommand("say hello\nworld").includes("\n")).toBe(false));
  it("strips null byte", () =>
    expect(sanitizeScreenCommand("list\x00inject").includes("\x00")).toBe(false));
  it("leaves a clean command untouched", () =>
    expect(sanitizeScreenCommand("/whitelist add Steve_1")).toBe(
      "/whitelist add Steve_1",
    ));
});

// ── A-03: level-name cache ──────────────────────────────────────────────

describe("getLevelName cache (A-03)", () => {
  it("returns 'world' when server.properties does not exist", async () => {
    const { cfg } = scaffold();
    const ops = createOperations(cfg);
    expect(await ops.getLevelName()).toBe("world");
  });

  it("reads level-name from server.properties and caches it", async () => {
    const { cfg } = scaffold();
    fs.writeFileSync(
      path.join(cfg.serverPath, "server.properties"),
      "motd=hi\nlevel-name=skyblock\n",
    );
    const ops = createOperations(cfg);
    expect(await ops.getLevelName()).toBe("skyblock");
    // Mutate the file — the 60 s TTL cache must still serve the old value.
    fs.writeFileSync(
      path.join(cfg.serverPath, "server.properties"),
      "level-name=changed\n",
    );
    expect(await ops.getLevelName()).toBe("skyblock");
  });
});

// ── A-11 / H-05: stats path guards ──────────────────────────────────────

describe("stats path guards (A-11)", () => {
  let cfg: InstanceConfig;
  const UUID = "069a79f4-44e9-4726-a5be-fca90e38aaf5";

  beforeEach(async () => {
    ({ cfg } = scaffold());
    const statsDir = path.join(cfg.serverPath, "world", "stats");
    fs.mkdirSync(statsDir, { recursive: true });
    fs.writeFileSync(path.join(statsDir, `${UUID}.json`), '{"stats":{}}');
  });

  it("reads a valid UUID's stats", async () => {
    const ops = createOperations(cfg);
    expect(await ops.getStats(UUID)).toEqual({ stats: {} });
  });

  it("blocks a traversal UUID even if the route guard were bypassed", async () => {
    const ops = createOperations(cfg);
    expect(await ops.getStats("../../../../etc/passwd")).toBeNull();
  });

  it("lists stats uuids", async () => {
    const ops = createOperations(cfg);
    expect(await ops.listStatsUuids()).toEqual([UUID]);
  });

  it("deletes an existing stats file and returns true (H-05)", async () => {
    const ops = createOperations(cfg);
    expect(await ops.deleteStats(UUID)).toBe(true);
    expect(await ops.getStats(UUID)).toBeNull();
  });

  it("returns false for a missing file", async () => {
    const ops = createOperations(cfg);
    expect(await ops.deleteStats("00000000-0000-0000-0000-000000000000")).toBe(false);
  });

  it("blocks deleteStats traversal even if the route guard were bypassed", async () => {
    const outside = path.join(cfg.serverPath, "..", "victim.json");
    fs.writeFileSync(outside, "{}");
    const ops = createOperations(cfg);
    expect(await ops.deleteStats("../../victim" as string)).toBe(false);
    expect(fs.existsSync(outside)).toBe(true);
  });
});

// ── The stats directory is not always <level>/stats ────────────────────
// Found in production on a Fabric instance: no <level>/stats at all, the
// files under <level>/players/stats next to players/advancements. Every
// read was an ENOENT, which is indistinguishable from "nobody has played
// yet", so the wrapper answered {uuids: []} and 404s with a 200-shaped
// conscience and the bot's leaderboards were simply blank.

describe("resolves the stats directory instead of assuming it", () => {
  const UUID = "f168ae84-0305-4f7e-ba34-7ae738bb50d1";

  /** Write a stats file at <level>/<rel>/<uuid>.json. */
  function seed(cfg: InstanceConfig, rel: string[], uuid = UUID): string {
    const dir = path.join(cfg.serverPath, "world", ...rel);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${uuid}.json`), '{"stats":{"minecraft:custom":{}}}');
    return dir;
  }

  it("finds vanilla stats at <level>/stats", async () => {
    const { cfg } = scaffold();
    seed(cfg, ["stats"]);
    const ops = createOperations(cfg);
    expect(await ops.listStatsUuids()).toEqual([UUID]);
    expect(await ops.getStats(UUID)).toEqual({ stats: { "minecraft:custom": {} } });
  });

  it("finds modded stats at <level>/players/stats", async () => {
    const { cfg } = scaffold();
    // Exactly the layout from the field report: no <level>/stats exists.
    seed(cfg, ["players", "stats"]);
    fs.mkdirSync(path.join(cfg.serverPath, "world", "players", "advancements"), {
      recursive: true,
    });
    const ops = createOperations(cfg);
    expect(await ops.listStatsUuids()).toEqual([UUID]);
    expect(await ops.getStats(UUID)).toEqual({ stats: { "minecraft:custom": {} } });
  });

  it("deletes from whichever layout the world uses", async () => {
    const { cfg } = scaffold();
    const dir = seed(cfg, ["players", "stats"]);
    const ops = createOperations(cfg);
    expect(await ops.deleteStats(UUID)).toBe(true);
    expect(fs.existsSync(path.join(dir, `${UUID}.json`))).toBe(false);
  });

  it("prefers vanilla when a world somehow has both", async () => {
    const { cfg } = scaffold();
    seed(cfg, ["stats"], UUID);
    seed(cfg, ["players", "stats"], "00000000-0000-0000-0000-000000000000");
    const ops = createOperations(cfg);
    expect(await ops.listStatsUuids()).toEqual([UUID]);
  });

  it("picks up a directory created after the first miss", async () => {
    const { cfg } = scaffold();
    fs.mkdirSync(path.join(cfg.serverPath, "world"), { recursive: true });
    const ops = createOperations(cfg);
    // Fresh world: neither layout exists yet, and [] is the right answer.
    expect(await ops.listStatsUuids()).toEqual([]);

    // The server creates it when someone first plays. A cached miss would
    // mean the wrapper never noticed until it was restarted.
    seed(cfg, ["players", "stats"]);
    expect(await ops.listStatsUuids()).toEqual([UUID]);
  });
});

// ── listStatsUuids must not report a failure as emptiness ───────────────
// Found in production: a stats directory the wrapper could not read came
// back as `{uuids: []}` with a 200, so the bot recorded hourly snapshots
// with zero players. Those act as a zero baseline on its side, silently
// turning every period leaderboard into all-time totals. "No stats yet"
// and "I cannot read the stats" must not look the same on the wire.

describe("listStatsUuids distinguishes empty from unreadable", () => {
  const UUID = "069a79f4-44e9-4726-a5be-fca90e38aaf5";

  it("returns [] when the world has no stats directory yet", async () => {
    const { cfg } = scaffold();
    fs.mkdirSync(path.join(cfg.serverPath, "world"), { recursive: true });
    const ops = createOperations(cfg);
    await expect(ops.listStatsUuids()).resolves.toEqual([]);
  });

  it("returns [] when the stats directory exists but is empty", async () => {
    const { cfg } = scaffold();
    fs.mkdirSync(path.join(cfg.serverPath, "world", "stats"), {
      recursive: true,
    });
    const ops = createOperations(cfg);
    await expect(ops.listStatsUuids()).resolves.toEqual([]);
  });

  it("throws when the stats directory cannot be read", async () => {
    const { cfg } = scaffold();
    const statsDir = path.join(cfg.serverPath, "world", "stats");
    fs.mkdirSync(statsDir, { recursive: true });
    fs.writeFileSync(path.join(statsDir, `${UUID}.json`), '{"stats":{}}');

    // Take away the read bit. Root ignores permissions, so skip there
    // rather than assert something that cannot hold.
    fs.chmodSync(statsDir, 0o000);
    const readable = (() => {
      try {
        fs.readdirSync(statsDir);
        return true;
      } catch {
        return false;
      }
    })();
    if (!readable) {
      const ops = createOperations(cfg);
      await expect(ops.listStatsUuids()).rejects.toThrow();
    }
    fs.chmodSync(statsDir, 0o755);
  });
});

// ── M-13: capabilities shape ────────────────────────────────────────────

describe("getCapabilities (M-13)", () => {
  it("reports all-false for a plain server without suite artifacts", () => {
    const { cfg } = scaffold();
    const ops = createOperations(cfg);
    expect(ops.getCapabilities()).toEqual({
      scripts: { start: false, stop: false, restart: false, backup: false, status: false },
      backups: false,
      modManifest: false,
      variablesFile: false,
    });
  });

  it("reports all-true for a full suite layout (shape matches the bot's ServerCapabilities)", () => {
    const { cfg, root } = scaffold();
    for (const rel of [
      "start.sh",
      "shutdown.sh",
      "smart_restart.sh",
      "backup/backup.sh",
      "misc/status.sh",
      "common/downloaded_versions.json",
      "common/variables.txt",
    ]) {
      const p = path.join(cfg.scriptsDir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, "");
    }
    cfg.backupsPath = path.join(root, "backups");
    fs.mkdirSync(cfg.backupsPath);
    const ops = createOperations(cfg);
    expect(ops.getCapabilities()).toEqual({
      scripts: { start: true, stop: true, restart: true, backup: true, status: true },
      backups: true,
      modManifest: true,
      variablesFile: true,
    });
  });

  it("detects partial layouts per script", () => {
    const { cfg } = scaffold();
    fs.writeFileSync(path.join(cfg.scriptsDir, "start.sh"), "");
    const ops = createOperations(cfg);
    const caps = ops.getCapabilities();
    expect(caps.scripts.start).toBe(true);
    expect(caps.scripts.stop).toBe(false);
  });
});

// ── usercache filtering ─────────────────────────────────────────────────

describe("getUserCache", () => {
  it("filters entries to the {name, uuid} shape the bot expects", () => {
    const { cfg } = scaffold();
    fs.writeFileSync(
      path.join(cfg.serverPath, "usercache.json"),
      JSON.stringify([
        { name: "Steve", uuid: "u-1", expiresOn: "2026-08-01" },
        { name: 42, uuid: "u-2" },
        { uuid: "u-3" },
        { name: "Alex", uuid: "u-4" },
      ]),
    );
    const ops = createOperations(cfg);
    expect(ops.getUserCache()).toEqual([
      { name: "Steve", uuid: "u-1" },
      { name: "Alex", uuid: "u-4" },
    ]);
  });

  it("returns [] for a missing or malformed file", () => {
    const { cfg } = scaffold();
    const ops = createOperations(cfg);
    expect(ops.getUserCache()).toEqual([]);
    fs.writeFileSync(path.join(cfg.serverPath, "usercache.json"), "{not json");
    expect(ops.getUserCache()).toEqual([]);
  });
});
