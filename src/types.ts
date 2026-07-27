/**
 * Shared shapes. The response interfaces here are the wire contract the
 * bot consumes (minecraft-bot: src/core/utils/serverAccess.ts) — field
 * names and types must stay in lockstep with the bot's expectations.
 * Historical quirks (string playerCount, "?" maxPlayers) are part of
 * that contract and deliberately preserved.
 */

export interface InstanceConfig {
  id: string;
  serverPath: string;
  linuxUser: string;
  useRcon: boolean;
  rconHost: string;
  rconPort: number;
  rconPassword: string;
  backupsPath: string;
  /** Directory containing start.sh, shutdown.sh, etc. */
  scriptsDir: string;
}

export interface AppConfig {
  PORT: number;
  API_KEY: string;
  instances: Record<string, InstanceConfig>;
}

// ── Wire contract (bot-facing) ────────────────────────────────────────────

export interface PlayerList {
  playerCount: string;
  maxPlayers: string;
  players: string[];
}

// ── Health (the `server-health` manifest feature, v1) ─────────────────────

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
    backup: boolean;
    status: boolean;
  };
  backups: boolean;
  modManifest: boolean;
  variablesFile: boolean;
}

export interface ScriptResult {
  output: string;
  stderr: string;
  exitCode: number | null;
}

export interface WhitelistEntry {
  name: string;
  uuid: string;
}

// ── /info (wrapper >= 1.2.0 contract; this wrapper reports its own semver) ──

export interface ProcessUsage {
  pid: number;
  cpuPercent: number;
  rssBytes: number;
}

export interface DiskUsage {
  path: string;
  usedPercent: number;
  availableBytes: number;
  totalBytes: number;
}

export interface HostInfo {
  process: ProcessUsage | null;
  disks: DiskUsage[];
}

export interface InstanceInfo {
  version: string;
  host: HostInfo;
}
