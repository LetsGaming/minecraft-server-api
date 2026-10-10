import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import type * as SpawnModule from "../../src/platform/spawn.js";

import { makeFixture, touch, type Fixture } from "../helpers/instanceFixture.js";

const runMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/platform/spawn.js", async (orig) => ({
  ...(await orig<typeof SpawnModule>()),
  runAsInstanceUser: runMock,
}));

import { createMods, MOD_VALIDATION } from "../../src/instances/mods.js";

let fx: Fixture;

function stage(...scripts: string[]): void {
  for (const s of scripts) touch(path.join(fx.cfg.scriptsDir, "update", s));
}

function ok(json: unknown) {
  return { output: JSON.stringify(json), stderr: "", exitCode: 0 };
}

beforeEach(() => {
  fx = makeFixture();
  runMock.mockReset();
});

afterEach(() => fx.cleanup());

describe("MOD_VALIDATION", () => {
  const { SLUG_RE, MC_VERSION_RE, LOADER_RE, VERSION_ID_RE } = MOD_VALIDATION;

  it("accepts ordinary slugs and project ids", () => {
    for (const s of ["sodium", "fabric-api", "ae2_1.2", "AbCdEfGh"]) {
      expect(SLUG_RE.test(s)).toBe(true);
    }
  });

  it("rejects shell and path syntax", () => {
    for (const s of ["a b", "a/b", "a;b", "", "x".repeat(97)]) {
      expect(SLUG_RE.test(s)).toBe(false);
    }
  });

  it("rejects anything that could read as an option or a dot path", () => {
    for (const s of ["--json", "-h", "--help", "-", "..", ".hidden", "_x"]) {
      expect(SLUG_RE.test(s)).toBe(false);
    }
  });

  it("accepts mixed-case project ids and the 96 character maximum only", () => {
    expect(SLUG_RE.test("P7dR8mSH")).toBe(true);
    expect(SLUG_RE.test("a".repeat(96))).toBe(true);
    expect(SLUG_RE.test("a".repeat(97))).toBe(false);
  });

  it("validates the version, loader and version id shapes", () => {
    expect(MC_VERSION_RE.test("1.21.4")).toBe(true);
    expect(MC_VERSION_RE.test("1.21 4")).toBe(false);
    expect(LOADER_RE.test("neoforge")).toBe(true);
    expect(LOADER_RE.test("Fabric")).toBe(false);
    expect(VERSION_ID_RE.test("AbCd-123")).toBe(true);
    expect(VERSION_ID_RE.test("a.b")).toBe(false);
  });
});

describe("runModScript via the public operations", () => {
  it("runs node on the script with --json last and parses the result", async () => {
    stage("add-mod.js");
    runMock.mockResolvedValue(ok({ ok: true, slug: "sodium" }));
    const res = await createMods(fx.cfg).addMod("sodium", "1.21.4", "fabric", "AbCd");
    expect(res).toEqual({ ok: true, slug: "sodium" });
    const [target, command, options] = runMock.mock.calls[0]!;
    expect(target).toBe(fx.cfg);
    expect(command[0]).toBe("node");
    expect(command[1]).toBe(path.join(fx.cfg.scriptsDir, "update/add-mod.js"));
    expect(command.slice(2)).toEqual([
      "--mcVersion=1.21.4",
      "--modLoader=fabric",
      "--versionId=AbCd",
      "--json",
      "--",
      "sodium",
    ]);
    expect(options).toEqual({ timeoutMs: 120_000, label: "Add mod" });
  });

  it("passes a script's own ok:false through as data", async () => {
    stage("remove-mod.js");
    runMock.mockResolvedValue(ok({ ok: false, error: "not installed" }));
    const res = await createMods(fx.cfg).removeMod("nope");
    expect(res).toMatchObject({ ok: false });
  });

  it("throws when the script file is missing", async () => {
    await expect(createMods(fx.cfg).removeMod("x")).rejects.toThrow(/Mod script not found/);
    expect(runMock).not.toHaveBeenCalled();
  });

  it("throws with the stderr tail when output is not JSON", async () => {
    stage("remove-mod.js");
    runMock.mockResolvedValue({ output: "garbage", stderr: "boom", exitCode: 2 });
    await expect(createMods(fx.cfg).removeMod("x")).rejects.toThrow(
      /produced no parseable result \(exit 2\): boom/,
    );
  });

  it("throws when the result lacks a boolean ok", async () => {
    stage("remove-mod.js");
    runMock.mockResolvedValue(ok({ fine: 1 }));
    await expect(createMods(fx.cfg).removeMod("x")).rejects.toThrow(/unrecognised result shape/);
  });

  it("requires a results array from check-updates", async () => {
    stage("check-updates.js");
    runMock.mockResolvedValue(ok({ mcVersion: "1.21", results: [] }));
    const res = await createMods(fx.cfg).checkUpdates("1.21");
    expect(res.results).toEqual([]);
    runMock.mockResolvedValue(ok({ ok: true }));
    await expect(createMods(fx.cfg).checkUpdates()).rejects.toThrow(/unrecognised result shape/);
  });

  it("maps enable and disable onto toggle-mod flags", async () => {
    stage("toggle-mod.js");
    runMock.mockResolvedValue(ok({ ok: true }));
    const mods = createMods(fx.cfg);
    await mods.disableMod("sodium");
    await mods.enableMod("sodium");
    expect(runMock.mock.calls[0]![1].slice(2)).toEqual(["--disable", "--json", "--", "sodium"]);
    expect(runMock.mock.calls[1]![1].slice(2)).toEqual(["--enable", "--json", "--", "sodium"]);
  });

  it("uses a ten minute ceiling for apply and 15 s for toggle", async () => {
    stage("update-mods.js", "toggle-mod.js");
    runMock.mockResolvedValue(ok({ ok: true }));
    const mods = createMods(fx.cfg);
    await mods.applyUpdates();
    await mods.disableMod("a");
    expect(runMock.mock.calls[0]![2].timeoutMs).toBe(600_000);
    expect(runMock.mock.calls[1]![2].timeoutMs).toBe(15_000);
  });
});

describe("manifest reads and cache invalidation", () => {
  const manifest = {
    gameVersion: "1.21.4",
    modLoader: "fabric",
    mods: { b: { versionId: "v2", filename: "b.jar" }, a: "legacy-id" },
  };

  it("returns null when there is no manifest", async () => {
    const mods = createMods(fx.cfg);
    expect(await mods.listInstalled()).toBeNull();
    expect(await mods.getModSlugs()).toBeNull();
  });

  it("lists mods sorted by slug and flags disabled jars", async () => {
    touch(path.join(fx.cfg.scriptsDir, "common/downloaded_versions.json"), JSON.stringify(manifest));
    touch(path.join(fx.cfg.serverPath, "mods/disabled/b.jar"));
    const installed = await createMods(fx.cfg).listInstalled();
    expect(installed!.mods.map((m) => [m.slug, m.versionId, m.enabled])).toEqual([
      ["a", "legacy-id", true],
      ["b", "v2", false],
    ]);
    expect((await createMods(fx.cfg).getModSlugs())!.slugs).toEqual(["a"]);
  });

  it("invalidates the cached list after a mutation but not after a check", async () => {
    const file = path.join(fx.cfg.scriptsDir, "common/downloaded_versions.json");
    touch(file, JSON.stringify({ mods: {} }));
    stage("remove-mod.js", "check-updates.js");
    const mods = createMods(fx.cfg);
    expect((await mods.listInstalled())!.mods).toHaveLength(0);
    touch(file, JSON.stringify({ mods: { x: "1" } }));
    runMock.mockResolvedValue(ok({ results: [] }));
    await mods.checkUpdates();
    expect((await mods.listInstalled())!.mods).toHaveLength(0);
    runMock.mockResolvedValue(ok({ ok: true }));
    await mods.removeMod("x");
    expect((await mods.listInstalled())!.mods).toHaveLength(1);
  });
});
