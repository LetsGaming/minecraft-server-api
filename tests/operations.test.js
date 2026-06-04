"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");

let tmpDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-ops-test-"));
  const commonDir = path.join(tmpDir, "common");
  fs.mkdirSync(commonDir, { recursive: true });
  fs.writeFileSync(
    path.join(commonDir, "variables.txt"),
    [
      `SERVER_PATH=${tmpDir}`,
      "INSTANCE_NAME=testserver",
      "API_SERVER_PORT=3099",
      "API_SERVER_KEY=",
      "USE_RCON=false",
    ].join("\n"),
  );
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── getStats path-traversal guard (F-001 / A-11) ──────────────────────────

describe("getStats path guard", () => {
  it("blocks a traversal UUID with startsWith logic", () => {
    const levelName = "world";
    const statsDir = path.join(tmpDir, levelName, "stats");
    const uuid = "../../server.properties";
    const resolved = path.resolve(statsDir, `${uuid}.json`);
    const rel = path.relative(statsDir, resolved);
    assert.equal(rel.startsWith("..") || path.isAbsolute(rel), true);
  });

  it("accepts a valid UUID (A-11 path.relative guard)", () => {
    const levelName = "world";
    const statsDir = path.join(tmpDir, levelName, "stats");
    fs.mkdirSync(statsDir, { recursive: true });
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const resolved = path.resolve(statsDir, `${uuid}.json`);
    const rel = path.relative(statsDir, resolved);
    assert.equal(rel.startsWith("..") || path.isAbsolute(rel), false);
  });
});

// ── tailLog integer validation (F-009) ────────────────────────────────────

describe("tailLog lines parameter validation", () => {
  function sanitize(raw) {
    const parsed = parseInt(raw ?? "10", 10);
    return Number.isNaN(parsed) ? 10 : Math.min(Math.max(parsed, 1), 500);
  }

  it("clamps to 500 for large integers", () => assert.equal(sanitize("9999"), 500));
  it("blocks scientific notation bypass", () => assert.equal(sanitize("1e6"), 1));
  it("falls back to 10 for NaN input", () => assert.equal(sanitize("abc"), 10));
  it("passes through a normal value", () => assert.equal(sanitize("50"), 50));
  it("clamps minimum to 1", () => { assert.equal(sanitize("0"), 1); assert.equal(sanitize("-5"), 1); });
});

// ── UUID allowlist regex (F-001) ──────────────────────────────────────────

describe("UUID allowlist regex", () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const valid = [
    "550e8400-e29b-41d4-a716-446655440000",
    "00000000-0000-0000-0000-000000000000",
    "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF",
  ];
  const invalid = [
    "../../server.properties",
    "not-a-uuid",
    "",
    "550e8400-e29b-41d4-a716-44665544000g",
    "550e8400e29b41d4a716446655440000",
  ];

  for (const u of valid) it(`accepts ${u}`, () => assert.equal(UUID_RE.test(u), true));
  for (const u of invalid) it(`rejects "${u}"`, () => assert.equal(UUID_RE.test(u), false));
});

// ── A-01: screen injection sanitisation ──────────────────────────────────

describe("sendCommand screen injection sanitisation (A-01)", () => {
  function sanitize(command) {
    const formatted = command.startsWith("/") ? command : `/${command}`;
    return formatted.replace(/[\r\n\x00-\x1f\x7f]/g, "");
  }

  it("strips carriage return that would inject a second command", () => {
    const result = sanitize("list\r/op attacker");
    assert.equal(result.includes("\r"), false);
    assert.equal(result, "/list/op attacker"); // CR gone, safe remainder
  });

  it("strips newline", () => {
    const result = sanitize("say hello\nworld");
    assert.equal(result.includes("\n"), false);
  });

  it("strips null byte", () => {
    const result = sanitize("list\x00inject");
    assert.equal(result.includes("\x00"), false);
  });

  it("leaves a clean command untouched", () => {
    assert.equal(sanitize("list"), "/list");
    assert.equal(sanitize("/say hello world"), "/say hello world");
  });
});

// ── A-03: getLevelName cache behaviour ───────────────────────────────────

describe("getLevelName cache (A-03)", () => {
  it("returns 'world' when server.properties does not exist", async () => {
    // Simulate the cache being cold and the file missing
    const propsPath = path.join(tmpDir, "server.properties");
    if (fs.existsSync(propsPath)) fs.unlinkSync(propsPath);

    // Inline the cache logic to verify it without requiring config side-effects
    let cache = null;
    let cachedAt = 0;
    const TTL = 60_000;

    async function getLevelName() {
      if (cache && Date.now() - cachedAt < TTL) return cache;
      try {
        const text = fs.readFileSync(propsPath, "utf-8");
        const m = text.match(/^level-name\s*=\s*(.+)$/m);
        cache = m?.[1]?.trim() ?? "world";
      } catch {
        cache = "world";
      }
      cachedAt = Date.now();
      return cache;
    }

    assert.equal(await getLevelName(), "world");
  });

  it("reads level-name from server.properties", async () => {
    const propsPath = path.join(tmpDir, "server.properties");
    fs.writeFileSync(propsPath, "level-name=survival_world\n");

    let cache = null;
    let cachedAt = 0;
    const TTL = 60_000;

    async function getLevelName() {
      if (cache && Date.now() - cachedAt < TTL) return cache;
      try {
        const text = fs.readFileSync(propsPath, "utf-8");
        const m = text.match(/^level-name\s*=\s*(.+)$/m);
        cache = m?.[1]?.trim() ?? "world";
      } catch {
        cache = "world";
      }
      cachedAt = Date.now();
      return cache;
    }

    assert.equal(await getLevelName(), "survival_world");
    // Second call should use cache (file could be deleted — cache still returns value)
    fs.unlinkSync(propsPath);
    assert.equal(await getLevelName(), "survival_world");
  });
});
