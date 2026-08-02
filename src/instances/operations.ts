/**
 * Per-instance composition root.
 *
 * Each concern below is its own module; this wires them together once per
 * configured instance at startup and returns the flat bundle the routes
 * call. The returned shape is the wrapper's internal contract with its own
 * route layer — adding to it is safe, renaming is not.
 *
 * Two orderings matter and are the reason this is a factory rather than a
 * set of loose imports:
 *   - `world` is built before `health`, which needs the game port to decide
 *     whether a socket probe is even possible;
 *   - `health` is shared by players and the runtime routes, so a status
 *     poll, a player list and a liveness check cost one RCON round-trip
 *     between them rather than three.
 */
import { RconClient } from "../platform/rcon/client.js";
import { createHealthMonitor } from "./health.js";
import { createBackups } from "./backups.js";
import { createBackupFiles } from "./backupFiles.js";
import { createRestore } from "./restore.js";
import { createConfigFiles } from "./configFiles.js";
import { createCommands } from "./commands.js";
import { createLogs } from "./logs.js";
import { createMods } from "./mods.js";
import { createPlayers } from "./players.js";
import { createScripts } from "./scripts.js";
import { createStats } from "./stats.js";
import { createTps } from "./tps.js";
import { createWorld } from "./world.js";
import type { InstanceConfig } from "../config/types.js";
import type { InstanceHealth } from "../contracts/wire.js";

export type Operations = ReturnType<typeof createOperations>;

export function createOperations(cfg: InstanceConfig) {
  // One RCON client per instance; null when the instance has no credentials.
  const rcon =
    cfg.useRcon && cfg.rconPassword
      ? new RconClient(cfg.rconHost, cfg.rconPort, cfg.rconPassword)
      : null;

  const world = createWorld(cfg);
  const health = createHealthMonitor(cfg, rcon, () => world.getGamePort());

  const commands = createCommands(cfg, rcon);
  const players = createPlayers(cfg, health);
  const tps = createTps(rcon);
  const stats = createStats(cfg, world);
  const logs = createLogs(cfg);
  const mods = createMods(cfg);
  const backups = createBackups(cfg);
  const backupFiles = createBackupFiles(cfg);
  const restore = createRestore(cfg);
  const configFiles = createConfigFiles(cfg);
  const scripts = createScripts(cfg);

  /** Full three-state health — see health.ts for why one boolean was not enough. */
  async function getHealth(): Promise<InstanceHealth> {
    return health.get();
  }

  /**
   * Legacy boolean. It now means "the server process is up", which is what
   * every caller always wanted it to mean — it used to mean "RCON answered
   * within three seconds", so a loaded server reported itself stopped.
   * New clients should read /health and handle `unresponsive` explicitly.
   */
  async function isRunning(): Promise<boolean> {
    return (await health.get()).state !== "offline";
  }

  return {
    ...commands,
    ...players,
    ...tps,
    ...stats,
    ...logs,
    ...mods,
    ...backups,
    ...restore,
    // Named rather than spread: `index` and `resolve` are far too generic for
    // a flat bundle shared by ten modules.
    indexBackupFiles: backupFiles.index,
    resolveBackupFile: backupFiles.resolve,
    indexConfigFiles: configFiles.index,
    readConfigFile: configFiles.read,
    writeConfigFile: configFiles.write,
    listConfigSnapshots: configFiles.listSnapshots,
    revertConfigFile: configFiles.revert,
    ...scripts,
    getLevelName: world.getLevelName,
    getHealth,
    isRunning,
  };
}
