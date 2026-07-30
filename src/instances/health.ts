/**
 * Is the Minecraft server up, and is it answering? Those are two questions,
 * and this wrapper used to answer only one.
 *
 * `isRunning()` sent `list` over RCON and reported `false` when the round-trip
 * timed out. But a server pinned by chunk generation, a busy evening, or heavy
 * mob-AI simulation stops answering RCON long before it stops running — and a
 * server that is still starting has not begun answering yet. All three looked
 * identical to a server that had genuinely stopped, so the bot raised "server
 * offline" alerts, emptied player lists, and closed everyone's play sessions
 * for a server that was merely slow.
 *
 * The process probes here are picked for being immune to a stalled game
 * thread:
 *   - a TCP connect to the RCON port is accepted by the JVM's Netty IO
 *     threads, which keep running while the main thread is blocked;
 *   - `ps` and `screen -list` read the OS process table, which does not care
 *     how loaded the JVM is.
 *
 * RCON is then used only for the second question — responsiveness — and its
 * answer is reported separately instead of standing in for liveness.
 */
import net from "net";

import { cached, type Cached } from "../platform/cache.js";
import { execSafe } from "../platform/exec.js";
import { getServerProcessUsage } from "../platform/host/index.js";
import type { RconClient } from "../platform/rcon/client.js";
import type { InstanceConfig } from "../config/types.js";
import type {
  InstanceHealth,
  PlayerList,
  ProcessProbe,
  ServerState,
} from "../contracts/wire.js";

// ── Probe budgets ─────────────────────────────────────────────────────────
// Deliberately tight. None of these probes needs to succeed for the wrapper
// to answer: a probe that gives up quickly and reports "not responsive" is
// more useful than one that holds the request open hoping the server catches
// up, because "not responsive" is exactly the state we are trying to name.

/** TCP connect budget. Loopback connects in microseconds when the listener is bound. */
export const SOCKET_PROBE_TIMEOUT_MS = 1_500;
/** RCON round-trip budget for the health probe specifically. */
export const RCON_PROBE_TIMEOUT_MS = 2_500;
/** A round-trip this recent is proof enough; skip the probe entirely. */
export const RCON_TRUST_MS = 10_000;

/** Below this age a health snapshot is served as-is. */
export const HEALTH_FRESH_MS = 2_000;
/** Above this age callers wait for a fresh probe instead of taking the old one. */
export const HEALTH_STALE_MS = 20_000;
/** How long a player list survives an unresponsive server before it becomes empty. */
export const LIST_MAX_AGE_MS = 120_000;

/**
 * Parse the vanilla/Paper `list` response.
 *
 * Lives here rather than in the caller because the health probe already pays
 * for this round-trip — reusing its output is what lets a status poll and a
 * `/list` cost one RCON command between them instead of two.
 */
export function parsePlayerList(raw: string): PlayerList {
  const counts =
    /There are\s+(\d+)\s*(?:of a max of\s*(\d+)|\/\s*(\d+))\s*players online/i.exec(
      raw,
    );
  const names = /players online:\s*(.*)$/i.exec(raw);
  return {
    playerCount: counts?.[1] ?? "0",
    maxPlayers: counts?.[2] ?? counts?.[3] ?? "?",
    players: names?.[1]
      ? names[1]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
  };
}

/**
 * Does something accept a TCP connection on this port?
 *
 * A successful connect proves the JVM is alive and its listener is bound. It
 * says nothing about whether the server can *do* anything — which is the
 * point: that is the other probe's job.
 */
export function tcpProbe(
  host: string,
  port: number,
  timeoutMs = SOCKET_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (up: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

/** Is there a screen session named after this instance? */
export async function screenSessionExists(cfg: InstanceConfig): Promise<boolean> {
  const { stdout, ok } = await execSafe(
    "sudo",
    ["-n", "-u", cfg.linuxUser, "screen", "-list"],
    10_000,
  );
  if (!ok) return false;
  // F-011: escape the instance name before embedding it in a regex so ids
  // like "server.1" don't misfire on the dot metacharacter.
  const escaped = cfg.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b\\d+\\.${escaped}\\b`).test(stdout);
}

/**
 * Establish that the server process exists, cheapest and most load-immune
 * probe first. Returns which probe answered, or `"none"` when all of them
 * came back negative — that, and only that, means the server is stopped.
 */
export async function probeProcess(
  cfg: InstanceConfig,
): Promise<ProcessProbe> {
  if (cfg.useRcon && cfg.rconPort) {
    const host = cfg.rconHost || "127.0.0.1";
    if (await tcpProbe(host, cfg.rconPort)) return "socket";
  }
  // No sudo needed: ps reads other users' processes. Also covers the window
  // during startup where the JVM is up but has not bound RCON yet.
  if (await getServerProcessUsage(cfg.linuxUser)) return "process";
  if (await screenSessionExists(cfg)) return "screen";
  return "none";
}

// ── Monitor ───────────────────────────────────────────────────────────────

interface Probe {
  health: InstanceHealth;
  /** Player list from this probe's RCON round-trip; null when it failed. */
  list: PlayerList | null;
}

export interface HealthMonitor {
  /** Current health, cached and single-flighted (see cache.ts). */
  get(): Promise<InstanceHealth>;
  /**
   * The player list, from the same round-trip the health probe makes.
   * A server that has stopped answering keeps its last known roster for
   * LIST_MAX_AGE_MS rather than reporting zero players, because "0 online"
   * is a claim, and a stale-but-true one beats a fresh lie.
   */
  getList(): Promise<PlayerList>;
}

export function createHealthMonitor(
  cfg: InstanceConfig,
  rcon: RconClient | null,
  /**
   * Reads `server-port` from server.properties. Injected rather than imported
   * so this module stays free of filesystem knowledge — and so the caller can
   * share the parse it already does for the level name.
   */
  readGamePort: () => Promise<number | null> = async () => null,
): HealthMonitor {
  let lastList: { value: PlayerList; at: number } | null = null;

  async function probe(): Promise<Probe> {
    const startedAt = Date.now();
    const rconConfigured = rcon !== null;

    let list: PlayerList | null = null;
    let rconResponsive = false;

    if (rcon) {
      // A round-trip inside RCON_TRUST_MS already proves both liveness and
      // responsiveness — another `list` would only add load to a server we
      // just heard from.
      if (startedAt - rcon.lastSuccessTime < RCON_TRUST_MS) {
        rconResponsive = true;
      } else {
        try {
          list = parsePlayerList(await rcon.send("list", RCON_PROBE_TIMEOUT_MS));
          rconResponsive = true;
        } catch {
          // Not an error — it is the answer to one of the two questions.
        }
      }
    }

    // RCON answering is itself proof the process is up, so the OS probes only
    // run when it did not.
    const usedProbe: ProcessProbe = rconResponsive
      ? "rcon"
      : await probeProcess(cfg);
    const processUp = usedProbe !== "none";

    // Published so a client can ping the game server directly when this
    // wrapper stops answering — see types.ts. Never fails the probe: a
    // missing port costs the client a default, not an answer.
    const gamePort = await readGamePort().catch(() => null);

    const state: ServerState = !processUp
      ? "offline"
      : rconResponsive || !rconConfigured
        ? "online"
        : "unresponsive";

    if (list) lastList = { value: list, at: Date.now() };

    return {
      health: {
        state,
        processUp,
        probe: usedProbe,
        rcon: {
          configured: rconConfigured,
          responsive: rconResponsive,
          lastSuccessMsAgo:
            rcon && rcon.lastSuccessTime > 0
              ? Date.now() - rcon.lastSuccessTime
              : null,
        },
        gamePort,
        checkedAt: startedAt,
        ageMs: 0,
      },
      list,
    };
  }

  const monitor: Cached<Probe> = cached(probe, {
    freshMs: HEALTH_FRESH_MS,
    staleMs: HEALTH_STALE_MS,
  });

  return {
    async get(): Promise<InstanceHealth> {
      const { value, at } = await monitor.get();
      // Report how old the answer is rather than hiding it — a caller that
      // cares (an alerting loop) can weigh a 15-second-old snapshot itself.
      return { ...value.health, ageMs: Math.max(Date.now() - at, 0) };
    },

    async getList(): Promise<PlayerList> {
      const { value } = await monitor.get();
      if (value.list) return value.list;
      // The probe's RCON call failed. If the server is up but unresponsive we
      // still know who was on it a moment ago; if it is genuinely offline,
      // nobody is.
      if (
        value.health.state === "unresponsive" &&
        lastList &&
        Date.now() - lastList.at < LIST_MAX_AGE_MS
      ) {
        return lastList.value;
      }
      if (value.health.state === "offline") lastList = null;
      return { playerCount: "0", maxPlayers: "?", players: [] };
    },
  };
}
