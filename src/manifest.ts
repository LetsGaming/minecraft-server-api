/**
 * The feature manifest the bot reads to learn what this wrapper can do.
 *
 * Why this exists: the bot degrades per route — a 404 on `/usercache`
 * silently turns into "no usercache names" — so an outdated wrapper looked
 * identical to a working one. The only signal was a single semver compare
 * against the bot's MIN_WRAPPER_VERSION, which is far too coarse to say
 * *which* feature is missing, and says nothing at all in the other
 * direction (a wrapper newer than the bot).
 *
 * Why not just serve openapi.yaml: it is hand-maintained, and it has already
 * drifted — the 2.x spec described `/players`, `/logs`, `/action` and
 * `/whitelist/{username}`, none of which ever existed, while missing half
 * the real routes. A mismatch check reading that file would be confidently
 * wrong, which is worse than the honest 404 it replaces. So `routes` below
 * is collected from Fastify's own router at boot and cannot disagree with
 * what this process actually serves; `openapi.yaml` is checked against it in
 * CI instead of being trusted.
 */
import { SCRIPT_MAP } from "./operations.js";
import { WRAPPER_VERSION } from "./version.js";

/**
 * Envelope version. Bump only when the manifest's own shape changes in a
 * way an older reader would misparse — not when features are added.
 */
export const MANIFEST_VERSION = 1;

/** Routes that describe the wrapper rather than serve an instance. */
export const META_ROUTES = [
  "GET /health",
  "GET /manifest",
  "GET /instances",
] as const;

export interface FeatureSpec {
  /**
   * Contract version for this feature. Bump on a breaking change to its
   * shape or semantics; the bot compares it against the version it
   * implements and reports either side being behind.
   */
  version: number;
  /** Routes this feature is served by. Asserted against the real router. */
  routes: readonly string[];
  /** What a bot loses without it — surfaced in the bot's startup report. */
  summary: string;
}

/**
 * Every instance route belongs to exactly one feature. That is enforced in
 * CI (both directions), which is the point of the whole mechanism: a route
 * cannot be added without naming the capability it provides, so the bot
 * cannot fail to hear about it.
 */
export const FEATURES: Record<string, FeatureSpec> = {
  "server-state": {
    version: 1,
    routes: [
      "GET /instances/:id/running",
      "GET /instances/:id/list",
      "GET /instances/:id/tps",
      "GET /instances/:id/level-name",
    ],
    summary: "Liveness, player list, TPS, and level name.",
  },
  "host-info": {
    version: 1,
    routes: ["GET /instances/:id/info"],
    summary: "Wrapper version handshake plus host process and disk metrics.",
  },
  whitelist: {
    version: 1,
    routes: ["GET /instances/:id/whitelist"],
    summary: "whitelist.json contents.",
  },
  usercache: {
    version: 1,
    routes: ["GET /instances/:id/usercache"],
    summary: "usercache.json names for players not on the whitelist.",
  },
  capabilities: {
    version: 1,
    routes: ["GET /instances/:id/capabilities"],
    summary: "Which setup-suite artifacts this instance has.",
  },
  "stats-read": {
    version: 1,
    routes: ["GET /instances/:id/stats", "GET /instances/:id/stats/:uuid"],
    summary: "Player stat files, for stats and leaderboards.",
  },
  "stats-delete": {
    version: 1,
    routes: ["DELETE /instances/:id/stats/:uuid"],
    summary: "Removing a player's stat file.",
  },
  mods: {
    version: 1,
    routes: ["GET /instances/:id/mods"],
    summary: "The suite's downloaded_versions.json mod manifest.",
  },
  backups: {
    version: 1,
    routes: ["GET /instances/:id/backups"],
    summary: "Backup tier listing and sizes.",
  },
  "rcon-command": {
    version: 1,
    routes: ["POST /instances/:id/command"],
    summary: "Running a console command on the server.",
  },
  scripts: {
    version: 1,
    routes: ["POST /instances/:id/scripts/run"],
    summary: "Running the suite's management scripts.",
  },
  "logs-tail": {
    version: 1,
    routes: ["GET /instances/:id/logs/tail"],
    summary: "Reading the end of the server log.",
  },
  "log-stream": {
    version: 1,
    routes: ["GET /instances/:id/logs/stream"],
    summary: "The SSE log feed that drives log watchers and in-game commands.",
  },
};

export interface Manifest {
  wrapper: string;
  manifest: number;
  routes: string[];
  features: Record<string, { version: number; summary: string }>;
  scriptActions: string[];
}

/**
 * Build the manifest from what this process actually serves.
 *
 * `routes` comes from the caller's onRoute collection, and `scriptActions`
 * from the same SCRIPT_MAP the runner validates against — so neither can
 * describe something this wrapper does not do.
 */
export function buildManifest(routes: readonly string[]): Manifest {
  const features: Manifest["features"] = {};
  for (const [name, spec] of Object.entries(FEATURES)) {
    features[name] = { version: spec.version, summary: spec.summary };
  }
  return {
    wrapper: WRAPPER_VERSION,
    manifest: MANIFEST_VERSION,
    routes: [...routes].sort(),
    features,
    scriptActions: Object.keys(SCRIPT_MAP).sort(),
  };
}
