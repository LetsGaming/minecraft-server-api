import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { createWorld, isSafeLevelName } from "../../src/instances/world.js";
import { createStats } from "../../src/instances/stats.js";
import { createPlayers } from "../../src/instances/players.js";
import type { HealthMonitor } from "../../src/instances/health.js";
import { makeFixture, touch, type Fixture } from "../helpers/instanceFixture.js";

const UUID = "11111111-2222-3333-4444-555555555555";

let fx: Fixture;
beforeEach(() => {
  fx = makeFixture();
  touch(path.join(fx.cfg.serverPath, "server.properties"), "level-name=world\n");
});
afterEach(() => fx.cleanup());

function trySymlink(target: string, link: string): boolean {
  try {
    fs.symlinkSync(target, link);
    return true;
  } catch {
    return false;
  }
}

describe("level-name", () => {
  it.each(["..", ".", "", "../x", "a/b", "a\\b", "C:evil", "a\0b"])("rejects %j", (name) => {
    expect(isSafeLevelName(name)).toBe(false);
  });

  it.each(["world", "My World", "world_nether", "a.b"])("accepts %j", (name) => {
    expect(isSafeLevelName(name)).toBe(true);
  });

  it("falls back to world for an unsafe level-name", async () => {
    touch(path.join(fx.cfg.serverPath, "server.properties"), "level-name=../../etc\n");
    expect(await createWorld(fx.cfg).getLevelName()).toBe("world");
  });

  it("reads level-name through the Properties grammar", async () => {
    touch(path.join(fx.cfg.serverPath, "server.properties"), "level-name world\nlevel-name:other\n");
    expect(await createWorld(fx.cfg).getLevelName()).toBe("other");
  });
});

describe("player stats reads", () => {
  const statsFile = () => path.join(fx.cfg.serverPath, "world", "stats", `${UUID}.json`);

  it("reads a regular stats file", async () => {
    touch(statsFile(), '{"stats":{"a":1}}');
    const stats = createStats(fx.cfg, createWorld(fx.cfg));
    expect(await stats.getStats(UUID)).toEqual({ stats: { a: 1 } });
  });

  it("does not follow a stats file replaced by a symlink", async () => {
    const secret = path.join(fx.root, "secret.json");
    touch(secret, '{"apiKey":"leak"}');
    fs.mkdirSync(path.dirname(statsFile()), { recursive: true });
    if (!trySymlink(secret, statsFile())) return;
    const stats = createStats(fx.cfg, createWorld(fx.cfg));
    expect(await stats.getStats(UUID)).toBeNull();
    expect(await stats.getAllStats()).toEqual({});
  });

  it("does not read a stats directory that is a link out of the server directory", async () => {
    const outside = path.join(fx.root, "outside");
    touch(path.join(outside, `${UUID}.json`), '{"leak":true}');
    fs.mkdirSync(path.join(fx.cfg.serverPath, "world"), { recursive: true });
    if (!trySymlink(outside, path.join(fx.cfg.serverPath, "world", "stats"))) return;
    const stats = createStats(fx.cfg, createWorld(fx.cfg));
    expect(await stats.getStats(UUID)).toBeNull();
    expect(await stats.listStatsUuids()).toEqual([]);
  });

  it("refuses an oversized stats file", async () => {
    touch(statsFile(), `{"pad":"${"x".repeat(3 * 1024 * 1024)}"}`);
    const stats = createStats(fx.cfg, createWorld(fx.cfg));
    expect(await stats.getStats(UUID)).toBeNull();
  });
});

describe("whitelist and usercache reads", () => {
  const health = {} as HealthMonitor;

  it("reads both files", async () => {
    touch(path.join(fx.cfg.serverPath, "whitelist.json"), '[{"name":"a","uuid":"u"}]');
    touch(path.join(fx.cfg.serverPath, "usercache.json"), '[{"name":"a","uuid":"u","expiresOn":"x"}]');
    const players = createPlayers(fx.cfg, health);
    expect(await players.getWhitelist()).toEqual([{ name: "a", uuid: "u" }]);
    expect(await players.getUserCache()).toEqual([{ name: "a", uuid: "u" }]);
  });

  it("returns nothing for a symlinked file", async () => {
    const secret = path.join(fx.root, "secret.json");
    touch(secret, '[{"name":"leak","uuid":"u"}]');
    if (!trySymlink(secret, path.join(fx.cfg.serverPath, "whitelist.json"))) return;
    if (!trySymlink(secret, path.join(fx.cfg.serverPath, "usercache.json"))) return;
    const players = createPlayers(fx.cfg, health);
    expect(await players.getWhitelist()).toEqual([]);
    expect(await players.getUserCache()).toEqual([]);
  });
});
