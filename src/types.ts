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
