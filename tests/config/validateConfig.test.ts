import { describe, it, expect } from "vitest";

import { MIN_API_KEY_LENGTH, validateConfig } from "../../src/config/load.js";
import type { AppConfig, InstanceConfig } from "../../src/config/types.js";

function config(overrides: { key?: string; user?: string } = {}): AppConfig {
  const inst: InstanceConfig = {
    id: "survival",
    serverPath: "/srv/mc",
    linuxUser: overrides.user ?? "minecraft",
    useRcon: false,
    rconHost: "localhost",
    rconPort: 25575,
    rconPassword: "",
    backupsPath: "",
    scriptsDir: "/srv/mc/scripts",
  };
  return { PORT: 3000, API_KEY: overrides.key ?? "k".repeat(MIN_API_KEY_LENGTH), instances: { survival: inst } };
}

describe("validateConfig", () => {
  it("accepts a long key and an ordinary user name", () => {
    expect(validateConfig(config())).toEqual([]);
  });

  it("rejects a key shorter than the minimum", () => {
    const problems = validateConfig(config({ key: "short-key" }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/at least 32/);
  });

  it("leaves an absent key to the startup no-auth decision", () => {
    expect(validateConfig(config({ key: "" }))).toEqual([]);
  });

  it.each(["", "Root", "-x", "a b", "a;rm", "$(id)", "a".repeat(33), "user\n"])(
    "rejects linuxUser %j",
    (user) => {
      expect(validateConfig(config({ user })).join()).toMatch(/linuxUser/);
    },
  );

  it.each(["minecraft", "_svc", "mc-server_2"])("accepts linuxUser %s", (user) => {
    expect(validateConfig(config({ user }))).toEqual([]);
  });
});

describe("instance ids", () => {
  it.each(["survival", "smp_2", "creative-1"])("accepts %s", (id) => {
    const c = config();
    expect(validateConfig({ ...c, instances: { [id]: c.instances.survival! } })).toEqual([]);
  });

  it.each(["a b", "x;y", "../up", "a.b", ""])("rejects %j", (id) => {
    const c = config();
    expect(validateConfig({ ...c, instances: { [id]: c.instances.survival! } }).join()).toMatch(/Instance id/);
  });
});
