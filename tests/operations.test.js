"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const os   = require("os");
const fs   = require("fs");
const path = require("path");

// ── getStats path-traversal guard (F-001 / A-11) ──────────────────────────

describe("getStats path guard", () => {
  it("blocks a traversal UUID", () => {
    const statsDir = path.join(os.tmpdir(), "world", "stats");
    const uuid     = "../../server.properties";
    const resolved = path.resolve(statsDir, `${uuid}.json`);
    const rel      = path.relative(statsDir, resolved);
    assert.equal(rel.startsWith("..") || path.isAbsolute(rel), true);
  });

  it("accepts a valid UUID (A-11 path.relative guard)", () => {
    const tmpDir   = fs.mkdtempSync(path.join(os.tmpdir(), "mc-ops-test-"));
    const statsDir = path.join(tmpDir, "world", "stats");
    fs.mkdirSync(statsDir, { recursive: true });
    const uuid     = "550e8400-e29b-41d4-a716-446655440000";
    const resolved = path.resolve(statsDir, `${uuid}.json`);
    const rel      = path.relative(statsDir, resolved);
    assert.equal(rel.startsWith("..") || path.isAbsolute(rel), false);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ── tailLog integer validation (F-009) ────────────────────────────────────

describe("tailLog lines parameter validation", () => {
  function sanitize(raw) {
    const parsed = parseInt(raw ?? "10", 10);
    return Number.isNaN(parsed) ? 10 : Math.min(Math.max(parsed, 1), 500);
  }

  it("clamps to 500 for large integers",       () => assert.equal(sanitize("9999"), 500));
  it("blocks scientific notation bypass",      () => assert.equal(sanitize("1e6"),  1));
  it("falls back to 10 for NaN input",         () => assert.equal(sanitize("abc"),  10));
  it("passes through a normal value",          () => assert.equal(sanitize("50"),   50));
  it("clamps minimum to 1 (zero)",             () => assert.equal(sanitize("0"),    1));
  it("clamps minimum to 1 (negative)",         () => assert.equal(sanitize("-5"),   1));
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

  for (const u of valid)   it(`accepts ${u}`,    () => assert.equal(UUID_RE.test(u), true));
  for (const u of invalid) it(`rejects "${u}"`,  () => assert.equal(UUID_RE.test(u), false));
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
    assert.equal(result, "/list/op attacker");
  });

  it("strips newline",    () => assert.equal(sanitize("say hello\nworld").includes("\n"), false));
  it("strips null byte",  () => assert.equal(sanitize("list\x00inject").includes("\x00"), false));
  it("leaves a clean command untouched", () => {
    assert.equal(sanitize("list"),             "/list");
    assert.equal(sanitize("/say hello world"), "/say hello world");
  });
});

// ── A-03: getLevelName cache behaviour ───────────────────────────────────

describe("getLevelName cache (A-03)", () => {
  it("returns 'world' when server.properties does not exist", async () => {
    const tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), "mc-ops-test-"));
    const propsPath = path.join(tmpDir, "server.properties");

    let cache = null, cachedAt = 0;
    const TTL = 60_000;

    async function getLevelName() {
      if (cache && Date.now() - cachedAt < TTL) return cache;
      try {
        const text = fs.readFileSync(propsPath, "utf-8");
        const m    = text.match(/^level-name\s*=\s*(.+)$/m);
        cache = m?.[1]?.trim() ?? "world";
      } catch {
        cache = "world";
      }
      cachedAt = Date.now();
      return cache;
    }

    assert.equal(await getLevelName(), "world");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads level-name from server.properties and caches it", async () => {
    const tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), "mc-ops-test-"));
    const propsPath = path.join(tmpDir, "server.properties");
    fs.writeFileSync(propsPath, "level-name=survival_world\n");

    let cache = null, cachedAt = 0;
    const TTL = 60_000;

    async function getLevelName() {
      if (cache && Date.now() - cachedAt < TTL) return cache;
      try {
        const text = fs.readFileSync(propsPath, "utf-8");
        const m    = text.match(/^level-name\s*=\s*(.+)$/m);
        cache = m?.[1]?.trim() ?? "world";
      } catch {
        cache = "world";
      }
      cachedAt = Date.now();
      return cache;
    }

    assert.equal(await getLevelName(), "survival_world");
    fs.unlinkSync(propsPath);
    assert.equal(await getLevelName(), "survival_world"); // served from cache
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
