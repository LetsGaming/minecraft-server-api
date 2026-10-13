/**
 * JSON Schemas for every response body this wrapper sends.
 *
 * They are attached to the routes as Fastify `schema.response`, so Fastify
 * serializes each reply through its schema and a field that is not declared
 * here never reaches a client. `openapi.ts` turns the same objects into
 * `openapi.json`, which the bot vendors and generates its wire types from.
 *
 * Written in the OpenAPI 3.0 dialect (`nullable`, not a `"null"` type) so one
 * object serves both Fastify's serializer and the published document. A schema
 * created with `named()` becomes a reusable component in the document and is
 * referenced by name wherever the same object is reused.
 *
 * The TypeScript counterparts live in wire.ts; tests/contracts/schemas.test.ts
 * keeps the two from drifting.
 */

export type JsonSchema = Record<string, unknown>;

const componentNames = new Map<object, string>();

/** Registers a schema as an OpenAPI component. Returns the same object. */
function named<T extends JsonSchema>(name: string, schema: T): T {
  componentNames.set(schema, name);
  return schema;
}

export function componentNameOf(schema: object): string | undefined {
  return componentNames.get(schema);
}

export function namedSchemas(): ReadonlyMap<object, string> {
  return componentNames;
}

const string = { type: "string" } as const;
const number = { type: "number" } as const;
const integer = { type: "integer" } as const;
const boolean = { type: "boolean" } as const;

const nullable = <T extends JsonSchema>(schema: T): T & { nullable: true } => ({
  ...schema,
  nullable: true,
});

/**
 * A nullable reference to a named schema. Fastify's serializer rejects
 * `nullable` without a `type`, and a `$ref` cannot carry siblings in 3.0, so
 * the reference travels inside `allOf`.
 */
const nullableRef = (schema: JsonSchema): JsonSchema => ({
  type: "object",
  nullable: true,
  allOf: [schema],
});

const array = (items: JsonSchema): JsonSchema => ({ type: "array", items });

const record = (values: JsonSchema): JsonSchema => ({
  type: "object",
  additionalProperties: values,
});

interface ObjectOptions {
  required?: readonly string[];
  /** Pass-through payloads (script output, raw game files) keep unknown keys. */
  open?: boolean;
  description?: string;
}

const object = (
  properties: Record<string, JsonSchema>,
  { required, open, description }: ObjectOptions = {},
): JsonSchema => ({
  type: "object",
  ...(description ? { description } : {}),
  properties,
  ...((required ?? Object.keys(properties)).length > 0
    ? { required: required ?? Object.keys(properties) }
    : {}),
  additionalProperties: open === true,
});

/** An object whose keys the wrapper does not interpret. */
const freeForm = (description: string): JsonSchema => ({
  type: "object",
  description,
  additionalProperties: true,
});

// ── Errors ───────────────────────────────────────────────────────────────

export const ErrorBody = named(
  "Error",
  object(
    { error: string },
    { description: "Every non-2xx body: `{ error }`." },
  ),
);

export const BusyBody = named(
  "OperationBusy",
  object(
    {
      error: string,
      busy: object(
        {
          kind: { ...string, description: "What holds the instance: stop, backup, restore, mods, upgrade, ..." },
          jobId: { ...string, description: "Set when the holder is a job that can be polled." },
        },
        { required: ["kind"] },
      ),
    },
    { description: "Another operation holds the instance. Try again when it finishes." },
  ),
);

export const NotOfflineBody = named(
  "RestoreRefused",
  object(
    {
      error: string,
      state: { type: "string", enum: ["online", "unresponsive", "offline"] },
    },
    { required: ["error", "state"] },
  ),
);

// ── Wrapper meta ─────────────────────────────────────────────────────────

export const WrapperHealth = named(
  "WrapperHealth",
  object({ ok: boolean, version: string }),
);

export const InstanceList = named(
  "InstanceList",
  object({ instances: array(object({ id: string })) }),
);

export const Manifest = named(
  "Manifest",
  object(
    {
      wrapper: string,
      manifest: integer,
      routes: array(string),
      features: record(object({ version: integer, summary: string })),
      scriptActions: array(string),
      scriptTimeoutsMs: record(integer),
    },
    { description: "What this wrapper serves; see src/contracts/manifest.ts." },
  ),
);

export const Metrics = named(
  "Metrics",
  object({
    uptimeSeconds: number,
    memory: object({
      rss: number,
      heapTotal: number,
      heapUsed: number,
      external: number,
      arrayBuffers: number,
    }),
    inFlight: integer,
    peakInFlight: integer,
    rateLimitRejections: integer,
    rconReconnects: integer,
    eventLoopDelayMs: object({ mean: number, p95: number, max: number }),
    cache: record(object({ hits: integer, misses: integer, hitRate: number })),
    routes: record(
      object({
        count: integer,
        errorCount: integer,
        timeoutCount: integer,
        p50Ms: number,
        p95Ms: number,
      }),
    ),
  }),
);

// ── Server state ─────────────────────────────────────────────────────────

export const PlayerList = named(
  "PlayerList",
  object(
    { playerCount: string, maxPlayers: string, players: array(string) },
    {
      description:
        '`playerCount` and `maxPlayers` are strings; maxPlayers is "?" when unknown.',
    },
  ),
);

export const Running = object({ running: boolean });

/**
 * One flat object for both flavours: Fastify's serializer cannot choose a
 * `oneOf` branch for a nullable value. Paper reports tps5m and tps15m,
 * vanilla reports mspt and optional percentiles; wire.ts keeps the strict
 * union.
 */
const Tps = named(
  "Tps",
  object(
    {
      type: { type: "string", enum: ["paper", "vanilla"] },
      tps1m: number,
      tps5m: number,
      tps15m: number,
      mspt: number,
      p50: number,
      p95: number,
      p99: number,
      raw: string,
    },
    { required: ["type", "tps1m", "raw"] },
  ),
);

export const TpsResponse = object({ tps: nullableRef(Tps) });

export const LevelName = object({ levelName: string });

export const InstanceHealth = named(
  "InstanceHealth",
  object({
    state: { type: "string", enum: ["online", "unresponsive", "offline"] },
    processUp: boolean,
    probe: {
      type: "string",
      enum: ["rcon", "socket", "process", "screen", "none"],
    },
    rcon: object({
      configured: boolean,
      responsive: boolean,
      lastSuccessMsAgo: nullable(number),
    }),
    gamePort: nullable(integer),
    restartCount: integer,
    unitFailed: boolean,
    checkedAt: number,
    ageMs: number,
  }),
);

// ── Host info ────────────────────────────────────────────────────────────

const ProcessUsage = named(
  "ProcessUsage",
  object({ pid: integer, cpuPercent: number, rssBytes: number }),
);

const HostUsage = named(
  "HostUsage",
  object({
    cpuPercent: number,
    cpuCount: integer,
    memTotalBytes: number,
    memUsedBytes: number,
    uptimeSeconds: number,
  }),
);

const DiskUsage = named(
  "DiskUsage",
  object({
    path: string,
    sizeBytes: nullable(number),
    filesystem: object({
      mountPoint: string,
      usedPercent: number,
      availableBytes: number,
      totalBytes: number,
    }),
  }),
);

const HostInfo = named(
  "HostInfo",
  object({
    process: nullableRef(ProcessUsage),
    host: nullableRef(HostUsage),
    disks: array(DiskUsage),
  }),
);

export const InstanceInfo = named(
  "InstanceInfo",
  object({ version: string, host: HostInfo }),
);

export const Capabilities = named(
  "Capabilities",
  object({
    scripts: object({
      start: boolean,
      stop: boolean,
      restart: boolean,
      rollback: boolean,
      backup: boolean,
      status: boolean,
    }),
    backups: boolean,
    restore: boolean,
    modManifest: boolean,
    variablesFile: boolean,
    upgrade: { ...boolean, description: "update/upgrade.sh exists, so the version upgrade job can run." },
    prune: { ...boolean, description: "world/prune-chunks.js exists, so chunks can be pruned." },
  }),
);

// ── Players and stats ────────────────────────────────────────────────────

const WhitelistEntry = named(
  "WhitelistEntry",
  object({ name: string, uuid: string }, { required: [], open: true }),
);

export const WhitelistResponse = object({ whitelist: array(WhitelistEntry) });
export const UserCacheResponse = object({ usercache: array(WhitelistEntry) });

const PlayerStats = freeForm("A player's stats file, verbatim from the game.");

export const StatsUuids = object({ uuids: array(string) });
export const StatsBulk = object({ stats: record(PlayerStats) });
export const StatsOne = object({ stats: PlayerStats });
export const StatsDeleted = object({ deleted: boolean });

// ── Backups ──────────────────────────────────────────────────────────────

const BackupDirInfo = named(
  "BackupDirInfo",
  object({
    dir: string,
    count: integer,
    latestFile: string,
    latestMtimeMs: number,
    latestSizeBytes: number,
  }),
);

export const BackupSummary = named(
  "BackupSummary",
  object({ dirs: array(BackupDirInfo), totalBytes: number }),
);

export const BackupFileInfo = named(
  "BackupFileInfo",
  object({
    id: string,
    tier: string,
    name: string,
    sizeBytes: number,
    mtimeMs: number,
  }),
);

export const BackupFileIndex = named(
  "BackupFileIndex",
  object({
    files: array(BackupFileInfo),
    nextCursor: nullable(string),
    total: integer,
  }),
);

export const BackupFileDeleted = named(
  "BackupFileDeleted",
  object({ ok: boolean, name: string, tier: string, sizeBytes: number }),
);

export const ScriptResult = named(
  "ScriptResult",
  object(
    { output: string, stderr: string, exitCode: nullable(integer) },
    { description: "A script that ran. A non-zero exit is still a 200." },
  ),
);

// ── Mod config files ─────────────────────────────────────────────────────

export const ConfigFileInfo = named(
  "ConfigFileInfo",
  object({
    id: string,
    relPath: string,
    modId: string,
    format: {
      ...string,
      description:
        "File type by extension: toml, json, json5, properties, cfg, conf, ini, yaml, text or snbt.",
    },
    editable: {
      ...boolean,
      description: "False when the file is listed but cannot be read or written.",
    },
    tooLarge: boolean,
    sizeBytes: number,
    mtimeMs: number,
  }),
);

export const ConfigFileIndex = object({
  files: array(ConfigFileInfo),
  truncated: {
    ...boolean,
    description: "The listing was cut at the file limit; some files are missing.",
  },
});

export const ConfigFileRead = named(
  "ConfigFileRead",
  object({
    text: string,
    etag: string,
    file: ConfigFileInfo,
    snapshots: array(string),
  }),
);

export const ConfigFileWritten = named(
  "ConfigFileWritten",
  object({ etag: string, snapshot: string }),
);

export const ConfigFileReverted = named(
  "ConfigFileReverted",
  object({ etag: string }),
);

// ── Mods ─────────────────────────────────────────────────────────────────

export const ModSlugs = named(
  "ModSlugs",
  object({ slugs: array(string), mtimeMs: number }),
);

const InstalledMod = named(
  "InstalledMod",
  object({
    slug: string,
    versionId: nullable(string),
    filename: nullable(string),
    enabled: boolean,
  }),
);

export const InstalledMods = named(
  "InstalledMods",
  object({
    gameVersion: nullable(string),
    modLoader: nullable(string),
    mtimeMs: number,
    mods: array(InstalledMod),
  }),
);

const scriptOutcome = (
  properties: Record<string, JsonSchema>,
  description: string,
): JsonSchema =>
  object(
    { ok: boolean, error: string, code: string, ...properties },
    { required: ["ok"], open: true, description },
  );

export const ModAddResult = named(
  "ModAddResult",
  scriptOutcome(
    {
      slug: string,
      projectId: string,
      action: string,
      versionId: string,
      filename: string,
      dependencies: array(
        object({ slug: string, action: string }, { open: true }),
      ),
    },
    "Result of add-mod.js. A handled failure is `{ ok: false, error, code }` at 200.",
  ),
);

export const ModRemoveResult = named(
  "ModRemoveResult",
  scriptOutcome(
    {
      slug: string,
      removedFile: nullable(string),
    },
    "Result of remove-mod.js.",
  ),
);

export const ModToggleResult = named(
  "ModToggleResult",
  scriptOutcome(
    {
      slug: string,
      filename: nullable(string),
      alreadyEnabled: boolean,
      alreadyDisabled: boolean,
    },
    "Result of toggle-mod.js.",
  ),
);

export const ModApplyResult = named(
  "ModApplyResult",
  scriptOutcome(
    {
      updated: array(
        object(
          {
            slug: string,
            fromVersionId: nullable(string),
            toVersionId: string,
            filename: string,
          },
          { required: ["slug", "toVersionId", "filename"], open: true },
        ),
      ),
      upToDate: array(string),
      failed: array(object({ slug: string, error: string }, { open: true })),
    },
    "Result of apply-updates.js and update-mod.js.",
  ),
);

export const ModUpdateCheck = named(
  "ModUpdateCheck",
  object(
    {
      mcVersion: string,
      modLoader: string,
      results: array(object({ slug: string, status: string }, { open: true })),
    },
    { open: true, description: "check-updates.js output, passed through." },
  ),
);

export const ModCompatMod = named(
  "ModCompatMod",
  object(
    {
      slug: string,
      name: string,
      availability: {
        type: "string",
        enum: ["available", "unavailable", "unknown"],
      },
      currentVersionId: string,
      target: object(
        {
          versionId: string,
          versionName: string,
          datePublished: string,
          downloadUrl: string,
        },
        { required: ["versionId", "versionName", "datePublished"] },
      ),
      reason: string,
    },
    { required: ["slug", "availability"] },
  ),
);

export const ModCompatStarted = named(
  "ModCompatStarted",
  object({ jobId: string }, { description: "The job to poll for the result." }),
);

export const ModCompatJob = named(
  "ModCompatJob",
  object(
    {
      jobId: string,
      state: { type: "string", enum: ["running", "done", "failed"] },
      mcVersion: string,
      modLoader: nullable(string),
      progress: object({ done: integer, total: integer }),
      partial: {
        ...array(ModCompatMod),
        description: "Results so far while running; empty once finished.",
      },
      checkedAt: { ...number, description: "Epoch ms. Set once done." },
      complete: {
        ...boolean,
        description:
          "True when every mod got a definitive answer (no `unknown`). Set once done.",
      },
      summary: object({
        available: integer,
        unavailable: integer,
        unknown: integer,
        total: integer,
      }),
      mods: array(ModCompatMod),
      error: { ...string, description: "Why a failed job failed." },
    },
    {
      required: ["jobId", "state", "mcVersion", "modLoader", "progress", "partial"],
      description:
        "A mod compatibility check. `checkedAt`, `complete`, `summary` and " +
        "`mods` are present once `state` is `done`; `error` when it is `failed`.",
    },
  ),
);

export const ModCompatRequest = named(
  "ModCompatRequest",
  object(
    {
      mcVersion: string,
      refresh: { ...boolean, description: "Skip the cached answer." },
    },
    { required: ["mcVersion"] },
  ),
);

// ── Operations ───────────────────────────────────────────────────────────

export const UpgradeRequest = named(
  "UpgradeRequest",
  object(
    {
      mcVersion: { ...string, description: "The Minecraft version to move to." },
      prunePlan: { ...string, description: "A stored prune plan id to apply after the install, before the first start." },
      expectUnavailable: {
        ...array(string),
        description:
          "The mods a compatibility check reported as unavailable. The job refuses to start if the installed set no longer gives the same list.",
      },
      countdownSeconds: { ...integer, description: "Warning before the stop; default 30, at most 600." },
    },
    { required: ["mcVersion"] },
  ),
);

export const UpgradeStarted = named(
  "UpgradeStarted",
  object({ jobId: { ...string, description: "The job to poll." } }),
);

const UpgradeEvent = named(
  "UpgradeEvent",
  object({
    seq: integer,
    ts: { ...integer, description: "Epoch seconds." },
    phase: string,
    status: { type: "string", enum: ["running", "done", "error", "info"] },
    msg: string,
  }),
);

const UpgradeResult = named(
  "UpgradeResult",
  object(
    {
      ok: boolean,
      branch: { type: "string", enum: ["clean", "mods_disabled"], description: "How a successful upgrade got there." },
      target: string,
      archive: { ...string, description: "Name of the backup this job took." },
      disabled: { ...array(string), description: "Mods moved to mods/disabled/ to get the server up." },
      keptOnOldBuild: { ...array(string), description: "Mods running on a build made for an older version." },
      rolledBack: boolean,
      previousVersionRunning: boolean,
      reason: { ...string, description: "Why it failed: apply_failed, prune_failed, crash_loop, timeout, backup_failed, ..." },
      prunedChunks: { ...integer, description: "Chunks the job deleted." },
      bytesFreed: { ...integer, description: "Disk space the prune returned." },
    },
    { required: ["ok"], open: true },
  ),
);

export const UpgradeJob = named(
  "UpgradeJob",
  object(
    {
      jobId: string,
      kind: { type: "string", enum: ["upgrade", "prune"] },
      state: { type: "string", enum: ["running", "done", "failed"] },
      mcVersion: string,
      events: { ...array(UpgradeEvent), description: "Progress lines after `since`." },
      next: { ...integer, description: "Pass as `since` to get only newer events." },
      result: UpgradeResult,
      error: { ...string, description: "busy, failed or interrupted when there is no result." },
    },
    { required: ["jobId", "state", "mcVersion", "events", "next"] },
  ),
);

const PruneZone = named(
  "PruneZone",
  object({
    name: string,
    dimension: string,
    x1: integer,
    z1: integer,
    x2: integer,
    z2: integer,
  }),
);

export const PruneParams = named(
  "PruneParams",
  object(
    {
      thresholdMinutes: { ...number, description: "Chunks inhabited for less than this many minutes are candidates." },
      spawnRadiusChunks: { ...integer, description: "Chunks around the world spawn that are never pruned." },
      playerRadiusChunks: { ...integer, description: "Chunks around each player's last position that are never pruned." },
      bufferChunks: { ...integer, description: "Candidates this close to anything that stays are kept." },
      zones: { ...array(PruneZone), description: "Protected rectangles, in chunk coordinates, inclusive." },
      dimensions: {
        ...array(string),
        nullable: true,
        description: "Dimension ids to scan; null means every one found.",
      },
    },
    { required: ["thresholdMinutes", "spawnRadiusChunks", "playerRadiusChunks", "bufferChunks", "zones", "dimensions"] },
  ),
);

/** Every field optional: the script fills what is missing from its defaults. */
export const PruneParamsRequest = named(
  "PruneParamsRequest",
  object(
    {
      thresholdMinutes: number,
      spawnRadiusChunks: integer,
      playerRadiusChunks: integer,
      bufferChunks: integer,
      zones: array(PruneZone),
      dimensions: { ...array(string), nullable: true },
    },
    { required: [] },
  ),
);

const PruneDimensionSummary = named(
  "PruneDimensionSummary",
  object({
    id: string,
    regions: integer,
    chunks: integer,
    delete: integer,
    active: integer,
    protected: integer,
    buffer: integer,
    unreadable: integer,
    regionsEmptied: integer,
    bytes: integer,
  }),
);

export const PruneSummary = named(
  "PruneSummary",
  object({
    ok: boolean,
    id: { ...string, description: "The plan id; pass it to the prune to apply exactly this preview." },
    createdAt: string,
    params: PruneParams,
    warnings: array(string),
    totals: object({ chunks: integer, delete: integer, regions: integer, regionsEmptied: integer, bytes: integer }),
    dimensions: array(PruneDimensionSummary),
  }),
);

export const PruneScanStarted = named(
  "PruneScanStarted",
  object({ jobId: { ...string, description: "The scan to poll." } }),
);

export const PruneScanJob = named(
  "PruneScanJob",
  object(
    {
      jobId: string,
      state: { type: "string", enum: ["running", "done", "failed"] },
      result: PruneSummary,
      error: { ...string, description: "A fixed reason code when the scan failed." },
    },
    { required: ["jobId", "state"] },
  ),
);

export const PruneRequest = named(
  "PruneRequest",
  object(
    {
      planId: { ...string, description: "A plan id from a finished scan." },
      countdownSeconds: { ...integer, description: "Warning before the stop; default 30, at most 600." },
    },
    { required: ["planId"] },
  ),
);

export const PruneMap = named(
  "PruneMap",
  object(
    {
      dimension: string,
      regions: freeForm("Per region (r.X.Z): base64 cell classes and heat levels, 1024 bytes each."),
    },
    { description: "One dimension of a plan, for drawing the map." },
  ),
);

export const LifecycleEvents = named(
  "LifecycleEvents",
  object({
    events: {
      ...array(freeForm("One event: ts, type (jvm_start, jvm_exit, restart_scheduled, crash_loop_gave_up) and its fields.")),
    },
    next: { ...integer, description: "Byte offset to pass as `since`." },
    reset: { ...boolean, description: "The file was rotated; this is a read from its start." },
  }),
);

// ── Control ──────────────────────────────────────────────────────────────

export const CommandResult = named(
  "CommandResult",
  object(
    {
      result: nullable(string),
      via: { type: "string", enum: ["rcon", "screen"] },
      sent: boolean,
      rconError: string,
    },
    {
      required: ["result", "via", "sent"],
      description:
        "`via` names the channel that carried the command. `result` is the " +
        "console's reply, or `null` over the screen fallback, which has no " +
        "reply channel. `rconError` is set when RCON failed and the screen " +
        "fallback was used instead. A command neither channel could deliver " +
        "is a 502, never a 200.",
    },
  ),
);

// ── Request bodies (documentation; the handlers validate) ────────────────

export const CommandRequest = named(
  "CommandRequest",
  object({
    command: {
      ...string,
      description: "At most 1400 bytes, no control characters.",
    },
  }),
);

export const ScriptRunRequest = named(
  "ScriptRunRequest",
  object(
    {
      action: {
        ...string,
        description: "One of `scriptActions` in the manifest.",
      },
      args: {
        type: "array",
        items: string,
        maxItems: 5,
        description:
          "Up to five arguments of letters, digits, `.`, `@`, `_` and `-`.",
      },
    },
    { required: ["action"] },
  ),
);

export const ConfigWriteRequest = named(
  "ConfigWriteRequest",
  object({ text: string }),
);

export const ConfigRevertRequest = named(
  "ConfigRevertRequest",
  object({
    snapshot: { ...string, description: "A name from the file's `snapshots`." },
  }),
);

export const ModAddRequest = named(
  "ModAddRequest",
  object(
    {
      slug: string,
      mcVersion: string,
      modLoader: string,
      versionId: { ...string, description: "Pins one Modrinth version." },
    },
    { required: ["slug"] },
  ),
);

export const ModUpdatesRequest = named(
  "ModUpdatesRequest",
  object({ mcVersion: string }, { required: [] }),
);

export const LogTail = object({ output: string });
