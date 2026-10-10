import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { createWorld } from "../../src/instances/world.js";
import { createPlayers } from "../../src/instances/players.js";
import type { HealthMonitor } from "../../src/instances/health.js";
import { makeFixture, touch, type Fixture } from "../helpers/instanceFixture.js";

let fx: Fixture;
const props = () => path.join(fx.cfg.serverPath, "server.properties");

beforeEach(() => {
  fx = makeFixture();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  fx.cleanup();
});

describe("world.getLevelName", () => {
  it("reads level-name, trimming whitespace", async () => {
    touch(props(), "motd=hi\nlevel-name =  My World  \n");
    expect(await createWorld(fx.cfg).getLevelName()).toBe("My World");
  });

  it("falls back to 'world' when the file or the key is missing", async () => {
    expect(await createWorld(fx.cfg).getLevelName()).toBe("world");
    touch(props(), "motd=hi\n");
    expect(await createWorld(fx.cfg).getLevelName()).toBe("world");
  });

  it("memoises for a minute, then picks up a world switch", async () => {
    touch(props(), "level-name=one\n");
    const world = createWorld(fx.cfg);
    expect(await world.getLevelName()).toBe("one");

    fs.writeFileSync(props(), "level-name=two\n");
    vi.advanceTimersByTime(59_000);
    expect(await world.getLevelName()).toBe("one");
    vi.advanceTimersByTime(2_000);
    expect(await world.getLevelName()).toBe("two");
  });

  it("caches the fallback too, so a missing file is not re-read on every request", async () => {
    const world = createWorld(fx.cfg);
    expect(await world.getLevelName()).toBe("world");
    touch(props(), "level-name=late\n");
    expect(await world.getLevelName()).toBe("world");
  });
});

describe("world.getGamePort", () => {
  it.each([
    ["server-port=25566", 25566],
    ["server-port = 25570  ", 25570],
    ["server-port=0", null],
    ["server-port=65536", null],
    ["server-port=abc", null],
    ["server-port=123456", null],
    ["motd=none", null],
  ])("parses %j as %s", async (line, expected) => {
    touch(props(), `${line}\n`);
    expect(await createWorld(fx.cfg).getGamePort()).toBe(expected);
  });

  it("is null without a properties file and caches that for a minute", async () => {
    const world = createWorld(fx.cfg);
    expect(await world.getGamePort()).toBeNull();
    touch(props(), "server-port=25565\n");
    expect(await world.getGamePort()).toBeNull();
    vi.advanceTimersByTime(61_000);
    expect(await world.getGamePort()).toBe(25565);
  });
});

describe("players", () => {
  const health = { getList: vi.fn() } as unknown as HealthMonitor & {
    getList: ReturnType<typeof vi.fn>;
  };

  it("delegates the live list to the health monitor", async () => {
    const list = { online: 1, players: ["Steve"] };
    health.getList.mockResolvedValue(list);
    expect(await createPlayers(fx.cfg, health).getList()).toBe(list);
  });

  it("returns [] for a missing, corrupt or non-array whitelist", async () => {
    const players = createPlayers(fx.cfg, health);
    expect(await players.getWhitelist()).toEqual([]);

    const corrupt = makeFixture();
    touch(path.join(corrupt.cfg.serverPath, "whitelist.json"), "{nope");
    expect(await createPlayers(corrupt.cfg, health).getWhitelist()).toEqual([]);
    corrupt.cleanup();

    const obj = makeFixture();
    touch(path.join(obj.cfg.serverPath, "whitelist.json"), '{"a":1}');
    expect(await createPlayers(obj.cfg, health).getWhitelist()).toEqual([]);
    obj.cleanup();
  });

  it("returns whitelist entries verbatim and serves them from cache for 30 seconds", async () => {
    const file = path.join(fx.cfg.serverPath, "whitelist.json");
    touch(file, JSON.stringify([{ uuid: "u1", name: "Steve", extra: 1 }]));
    const players = createPlayers(fx.cfg, health);
    expect(await players.getWhitelist()).toEqual([{ uuid: "u1", name: "Steve", extra: 1 }]);

    fs.writeFileSync(file, "[]");
    vi.advanceTimersByTime(29_000);
    expect(await players.getWhitelist()).toHaveLength(1);
    vi.advanceTimersByTime(2_000);
    expect(await players.getWhitelist()).toEqual([]);
  });

  it("keeps only well-formed name/uuid pairs from usercache and drops extra fields", async () => {
    touch(
      path.join(fx.cfg.serverPath, "usercache.json"),
      JSON.stringify([
        { name: "Steve", uuid: "u1", expiresOn: "2030" },
        { name: "NoUuid" },
        { uuid: "u3" },
        { name: 5, uuid: "u4" },
        null,
      ]),
    );
    expect(await createPlayers(fx.cfg, health).getUserCache()).toEqual([
      { name: "Steve", uuid: "u1" },
    ]);
  });

  it("returns [] for a missing or non-array usercache", async () => {
    expect(await createPlayers(fx.cfg, health).getUserCache()).toEqual([]);
    touch(path.join(fx.cfg.serverPath, "usercache.json"), '"str"');
    expect(await createPlayers(fx.cfg, health).getUserCache()).toEqual([]);
  });
});
