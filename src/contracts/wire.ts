/**
 * The response types the route layer returns. Their runtime counterparts are
 * the JSON Schemas in schemas.ts, which Fastify serializes every reply
 * through and which become openapi.json; the bot generates its own types from
 * that document. tests/contracts/wireAgreement.test.ts fails when a type here
 * and its schema disagree. Historical quirks (string playerCount, "?"
 * maxPlayers) are part of the contract and deliberately preserved.
 *
 * Config shapes live in config/types.ts; this file is responses only.
 */

export interface WrapperHealth {
  ok: boolean;
  version: string;
}

export interface CommandResult {
  /** null when the command went through the screen fallback, which has no reply channel. */
  result: string | null;
}

export interface ModSlugs {
  slugs: string[];
  /** mtime of downloaded_versions.json. */
  mtimeMs: number;
}

export interface BackupFileDeleted {
  ok: boolean;
  name: string;
  tier: string;
  sizeBytes: number;
}

export interface ConfigFileInfo {
  /** Opaque handle; the only file reference a client may send back. */
  id: string;
  /** Display path relative to the server directory. */
  relPath: string;
  /** Best guess at the owning mod; a grouping hint, not an identity. */
  modId: string;
  format: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface ConfigFileRead {
  text: string;
  etag: string;
  file: ConfigFileInfo;
  /** Snapshot names, newest first. */
  snapshots: string[];
}

export interface ConfigFileWritten {
  etag: string;
  snapshot: string;
}

export interface PlayerList {
  playerCount: string;
  maxPlayers: string;
  players: string[];
}

// ── Health (the `server-health` manifest feature, v2) ─────────────────────

/**
 * What the Minecraft server is doing. Note what is *not* here: "the wrapper
 * is down". This process cannot report its own absence, so that distinction
 * belongs to the client (minecraft-bot models it as `unreachable`), and
 * conflating the two is the bug this feature exists to fix.
 */
export type ServerState = "online" | "unresponsive" | "offline";

/** Which probe established that the process exists. `none` = all said no. */
export type ProcessProbe = "rcon" | "socket" | "process" | "screen" | "none";

export interface InstanceHealth {
  state: ServerState;
  /** A probe confirmed the process. Never inferred from `state`. */
  processUp: boolean;
  probe: ProcessProbe;
  rcon: {
    configured: boolean;
    responsive: boolean;
    /** Since the last successful round-trip; null when there has never been one. */
    lastSuccessMsAgo: number | null;
  };
  /**
   * The server's `server-port` from server.properties, or null when it could
   * not be read.
   *
   * Here so a client can ping the game server directly — which it needs most
   * when this wrapper is the thing that has stopped answering. Telling it the
   * port while we still can is what makes that fallback work without asking
   * the operator to configure it twice.
   */
  gamePort: number | null;
  /**
   * v2: how many times systemd has restarted this unit (NRestarts), and
   * whether it has given up (StartLimitBurst tripped — see
   * create_service.sh). This is the only signal that distinguishes a crash
   * loop from a clean outage: both look identical to every probe above,
   * since a looping server can be briefly up between attempts. Always
   * `{restartCount: 0, unitFailed: false}` when the server answered RCON
   * (nothing to report) or when systemd/sudo isn't available to ask.
   */
  restartCount: number;
  unitFailed: boolean;
  /** When the underlying probe ran (epoch ms). */
  checkedAt: number;
  /** Age of the served snapshot. Non-zero is normal and expected under load. */
  ageMs: number;
}

export interface TpsPaper {
  type: "paper";
  tps1m: number;
  tps5m: number;
  tps15m: number;
  raw: string;
}

export interface TpsVanilla {
  type: "vanilla";
  tps1m: number;
  mspt: number;
  raw: string;
  p50?: number;
  p95?: number;
  p99?: number;
}

export type Tps = TpsPaper | TpsVanilla | null;

export interface BackupDirInfo {
  dir: string;
  count: number;
  latestFile: string;
  latestMtimeMs: number;
  latestSizeBytes: number;
}

export interface BackupSummary {
  dirs: BackupDirInfo[];
  totalBytes: number;
}

export interface Capabilities {
  scripts: {
    start: boolean;
    stop: boolean;
    restart: boolean;
    /** rollback.sh. */
    rollback: boolean;
    backup: boolean;
    status: boolean;
  };
  backups: boolean;
  /** backup/restore.sh. Not a SCRIPT_MAP action. */
  restore: boolean;
  modManifest: boolean;
  variablesFile: boolean;
}

/** One archive in the backups directory. */
export interface BackupFileInfo {
  /** Opaque handle; the only file reference a client may send back. */
  id: string;
  tier: string;
  name: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface BackupFileIndex {
  files: BackupFileInfo[];
  nextCursor: string | null;
  total: number;
}

export interface ScriptResult {
  output: string;
  stderr: string;
  exitCode: number | null;
}

// ── Mod management (the `mod-management` feature) ──────────────────────────

/** One entry from downloaded_versions.json, in its current object form. */
export interface InstalledMod {
  slug: string;
  /** null on a legacy entry that recorded no version id. */
  versionId: string | null;
  /** null when the installed jar's filename was never captured. */
  filename: string | null;
  /**
   * Whether the jar is in mods/ (true) or mods/disabled/ (false) — derived
   * from disk location, not a manifest field, so it can't drift from
   * reality. True when the jar couldn't be located at all (nothing to
   * disable), matching the pre-existing default of "installed = active".
   */
  enabled: boolean;
}

export interface ModToggleResult {
  ok: boolean;
  slug?: string;
  filename?: string | null;
  alreadyEnabled?: boolean;
  alreadyDisabled?: boolean;
  error?: string;
  code?: string;
}

/** The richer installed list the dashboard reads (vs. the bot's slug-only /mods). */
export interface InstalledMods {
  gameVersion: string | null;
  modLoader: string | null;
  /** mtime of downloaded_versions.json, so a client can cache on it. */
  mtimeMs: number;
  mods: InstalledMod[];
}

/**
 * The results the suite scripts emit in --json mode. Their `ok` flag is the
 * contract this wrapper relies on; the rest is passed through to the client,
 * which renders the human summary. A script's own handled failure arrives as
 * `{ ok: false, error, code }` rather than as an HTTP 500.
 */
export interface ModAddResult {
  ok: boolean;
  slug?: string;
  projectId?: string;
  /** added | already-present | filename-updated */
  action?: string;
  versionId?: string;
  filename?: string;
  dependencies?: Array<{ slug: string; action: string }>;
  error?: string;
  code?: string;
}

export interface ModRemoveResult {
  ok: boolean;
  slug?: string;
  removedFile?: string | null;
  error?: string;
  code?: string;
}

/** The output of check-updates.js --json, passed through verbatim. */
export interface ModUpdateCheck {
  mcVersion: string;
  modLoader: string;
  results: Array<{ slug: string; status: string; [key: string]: unknown }>;
}

export type ModCompatAvailability = "available" | "unavailable" | "unknown";

export interface ModCompatMod {
  slug: string;
  name?: string;
  availability: ModCompatAvailability;
  currentVersionId?: string;
  target?: {
    versionId: string;
    versionName: string;
    datePublished: string;
    downloadUrl?: string;
  };
  reason?: string;
}

export interface ModCompatResult {
  mcVersion: string;
  modLoader: string | null;
  checkedAt: number;
  complete: boolean;
  summary: {
    available: number;
    unavailable: number;
    unknown: number;
    total: number;
  };
  mods: ModCompatMod[];
}

export interface ModCompatStarted {
  jobId: string;
}

/** A mod compatibility check; the final fields appear once `state` is `done`. */
export interface ModCompatJob extends Partial<ModCompatResult> {
  jobId: string;
  state: "running" | "done" | "failed";
  mcVersion: string;
  modLoader: string | null;
  progress: { done: number; total: number };
  partial: ModCompatMod[];
  error?: string;
}

export interface ModApplyResult {
  ok: boolean;
  updated?: Array<{
    slug: string;
    fromVersionId?: string | null;
    toVersionId: string;
    filename: string;
  }>;
  upToDate?: string[];
  failed?: Array<{ slug: string; error: string }>;
  error?: string;
  code?: string;
}

export interface WhitelistEntry {
  name: string;
  uuid: string;
}

// ── /info ──────────────────────────────────────────────────────────────────

export interface ProcessUsage {
  pid: number;
  /**
   * Instantaneous CPU share, sampled over a short window.
   *
   * NOT `ps -o pcpu`, which is the average over the process's whole
   * lifetime: a server that worked hard during world-gen reported ~90%
   * forever while idling. Normalised across cores the same way `top`
   * shows it, so a fully busy 4-core box reads 400%.
   */
  cpuPercent: number;
  /** Resident set size. For a JVM this tracks committed heap, not live objects. */
  rssBytes: number;
}

/** Whole-machine load — what an operator means by "the server is at 14%". */
export interface HostUsage {
  /** Busy share across all cores, 0–100, sampled over the same window. */
  cpuPercent: number;
  /** Logical CPUs, so a reader can turn a per-core figure into a total. */
  cpuCount: number;
  memTotalBytes: number;
  /**
   * In-use memory, MemTotal - MemAvailable. MemAvailable (not MemFree)
   * because reclaimable page cache is not "used" in any sense an operator
   * cares about — counting it reports a healthy box as full.
   */
  memUsedBytes: number;
  /** Seconds since boot, for context on the CPU average. */
  uptimeSeconds: number;
}

export interface DiskUsage {
  /** The directory that was measured. */
  path: string;
  /** Size of the directory's own contents (du), not of the filesystem. */
  sizeBytes: number | null;
  /**
   * Filesystem the directory sits on, and its figures. Two monitored
   * paths on one filesystem repeat the same block — that is the truth,
   * and naming the mount point is what makes it readable instead of
   * looking like two coincidentally identical disks.
   */
  filesystem: {
    mountPoint: string;
    usedPercent: number;
    availableBytes: number;
    totalBytes: number;
  };
}

export interface HostInfo {
  process: ProcessUsage | null;
  /** null on non-Linux hosts, where /proc is unavailable. */
  host: HostUsage | null;
  disks: DiskUsage[];
}

export interface InstanceInfo {
  version: string;
  host: HostInfo;
}
