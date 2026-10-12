/**
 * wire.ts types and schemas.ts schemas describe the same replies. Each sample
 * below is typed by the wire type and sent through Fastify with the schema as
 * its response schema: a field the schema omits is dropped on the way out, a
 * field it requires but the type lacks makes serialization throw, and either
 * shows up as a changed round trip.
 */
import { describe, it, expect } from "vitest";
import Fastify from "fastify";

import * as S from "../../src/contracts/schemas.js";
import type * as W from "../../src/contracts/wire.js";

const health: W.InstanceHealth = {
  state: "online",
  processUp: true,
  probe: "rcon",
  rcon: { configured: true, responsive: true, lastSuccessMsAgo: 12 },
  gamePort: 25565,
  restartCount: 0,
  unitFailed: false,
  checkedAt: 1700000000000,
  ageMs: 4,
};

const info: W.InstanceInfo = {
  version: "3.5.0",
  host: {
    process: { pid: 42, cpuPercent: 12.5, rssBytes: 1024 },
    host: {
      cpuPercent: 3.2,
      cpuCount: 4,
      memTotalBytes: 8192,
      memUsedBytes: 4096,
      uptimeSeconds: 99,
    },
    disks: [
      {
        path: "/srv/mc",
        sizeBytes: 1000,
        filesystem: {
          mountPoint: "/",
          usedPercent: 40,
          availableBytes: 600,
          totalBytes: 1000,
        },
      },
    ],
  },
};

const backupFile: W.BackupFileInfo = {
  id: "A".repeat(22),
  tier: "hourly",
  name: "world.tar.zst",
  sizeBytes: 10,
  mtimeMs: 1700000000000.5,
};

const configFile: W.ConfigFileInfo = {
  id: "B".repeat(22),
  relPath: "config/jei.toml",
  modId: "jei",
  format: "toml",
  editable: true,
  tooLarge: false,
  sizeBytes: 5,
  mtimeMs: 1700000000000.25,
};

const cases: Array<[string, S.JsonSchema, unknown]> = [
  [
    "WrapperHealth",
    S.WrapperHealth,
    { ok: true, version: "3.5.0" } satisfies W.WrapperHealth,
  ],
  ["InstanceHealth", S.InstanceHealth, health],
  ["InstanceInfo", S.InstanceInfo, info],
  [
    "PlayerList",
    S.PlayerList,
    {
      playerCount: "1",
      maxPlayers: "?",
      players: ["a"],
    } satisfies W.PlayerList,
  ],
  [
    "Capabilities",
    S.Capabilities,
    {
      scripts: {
        start: true,
        stop: true,
        restart: true,
        rollback: false,
        backup: true,
        status: true,
      },
      backups: true,
      restore: false,
      modManifest: true,
      variablesFile: true,
      upgrade: true,
    } satisfies W.Capabilities,
  ],
  [
    "BackupSummary",
    S.BackupSummary,
    {
      dirs: [
        {
          dir: "hourly",
          count: 2,
          latestFile: "a.tar.zst",
          latestMtimeMs: 1.5,
          latestSizeBytes: 9,
        },
      ],
      totalBytes: 9,
    } satisfies W.BackupSummary,
  ],
  [
    "BackupFileIndex",
    S.BackupFileIndex,
    {
      files: [backupFile],
      nextCursor: null,
      total: 1,
    } satisfies W.BackupFileIndex,
  ],
  [
    "BackupFileDeleted",
    S.BackupFileDeleted,
    {
      ok: true,
      name: "a",
      tier: "hourly",
      sizeBytes: 1,
    } satisfies W.BackupFileDeleted,
  ],
  [
    "ScriptResult",
    S.ScriptResult,
    { output: "out", stderr: "", exitCode: null } satisfies W.ScriptResult,
  ],
  [
    "ConfigFileIndex",
    S.ConfigFileIndex,
    { files: [configFile], truncated: false } satisfies W.ConfigFileIndex,
  ],
  [
    "ConfigFileRead",
    S.ConfigFileRead,
    {
      text: "a=1",
      etag: "e",
      file: configFile,
      snapshots: ["2024"],
    } satisfies W.ConfigFileRead,
  ],
  [
    "ConfigFileWritten",
    S.ConfigFileWritten,
    { etag: "e", snapshot: "s" } satisfies W.ConfigFileWritten,
  ],
  ["ModSlugs", S.ModSlugs, { slugs: ["a"], mtimeMs: 2.5 } satisfies W.ModSlugs],
  [
    "InstalledMods",
    S.InstalledMods,
    {
      gameVersion: "1.21.4",
      modLoader: null,
      mtimeMs: 1.5,
      mods: [{ slug: "a", versionId: null, filename: "a.jar", enabled: false }],
    } satisfies W.InstalledMods,
  ],
  [
    "ModAddResult",
    S.ModAddResult,
    {
      ok: true,
      slug: "a",
      projectId: "p",
      action: "added",
      versionId: "v",
      filename: "a.jar",
      dependencies: [{ slug: "b", action: "added" }],
    } satisfies W.ModAddResult,
  ],
  [
    "ModRemoveResult",
    S.ModRemoveResult,
    {
      ok: true,
      slug: "a",
      removedFile: null,
    } satisfies W.ModRemoveResult,
  ],
  [
    "ModToggleResult",
    S.ModToggleResult,
    {
      ok: true,
      slug: "a",
      filename: "a.jar",
      alreadyDisabled: true,
    } satisfies W.ModToggleResult,
  ],
  [
    "ModApplyResult",
    S.ModApplyResult,
    {
      ok: true,
      updated: [
        {
          slug: "a",
          fromVersionId: null,
          toVersionId: "v2",
          filename: "a2.jar",
        },
      ],
      upToDate: ["b"],
      failed: [{ slug: "c", error: "x" }],
    } satisfies W.ModApplyResult,
  ],
  [
    "ModUpdateCheck",
    S.ModUpdateCheck,
    {
      mcVersion: "1.21.4",
      modLoader: "fabric",
      results: [{ slug: "a", status: "update-available", latest: "v3" }],
    } satisfies W.ModUpdateCheck,
  ],
  [
    "ModCompatJob",
    S.ModCompatJob,
    {
      jobId: "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f",
      state: "done",
      mcVersion: "1.21.5",
      modLoader: "fabric",
      progress: { done: 2, total: 2 },
      partial: [],
      checkedAt: 1700000000000,
      complete: false,
      summary: { available: 1, unavailable: 0, unknown: 1, total: 2 },
      mods: [
        {
          slug: "a",
          availability: "available",
          currentVersionId: "v1",
          target: {
            versionId: "v2",
            versionName: "A 2",
            datePublished: "2026-01-01T00:00:00Z",
            downloadUrl: "https://cdn/a.jar",
          },
        },
        { slug: "b", availability: "unknown", reason: "rate limited" },
      ],
    } satisfies W.ModCompatJob,
  ],
  [
    "CommandResult",
    S.CommandResult,
    {
      result: null,
      via: "screen",
      sent: true,
      rconError: "refused",
    } satisfies W.CommandResult,
  ],
  [
    "TpsResponse (paper)",
    S.TpsResponse,
    {
      tps: {
        type: "paper",
        tps1m: 20,
        tps5m: 20,
        tps15m: 19.9,
        raw: "r",
      } satisfies W.TpsPaper,
    },
  ],
  [
    "TpsResponse (vanilla)",
    S.TpsResponse,
    {
      tps: {
        type: "vanilla",
        tps1m: 20,
        mspt: 5.5,
        raw: "r",
        p95: 7,
      } satisfies W.TpsVanilla,
    },
  ],
  ["TpsResponse (none)", S.TpsResponse, { tps: null }],
];

describe("response schemas round-trip their wire types", () => {
  it.each(cases)("%s", async (_name, schema, sample) => {
    const app = Fastify();
    app.get(
      "/x",
      { schema: { response: { 200: schema } } },
      async () => sample,
    );
    const res = await app.inject({ method: "GET", url: "/x" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(sample);
    await app.close();
  });
});
