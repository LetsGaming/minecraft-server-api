/**
 * Entry point: config resolution, SEC-01 fail-closed key check, listen,
 * graceful shutdown. App assembly lives in app.ts (testable).
 */
import { loadConfig } from "./config/load.js";
import { resolveTrustProxy } from "./config/trustProxy.js";
import { buildApp } from "./http/app.js";
import { log } from "./platform/logger.js";
import { sweepOrphanedJobFiles } from "./platform/spawn.js";
import { WRAPPER_VERSION } from "./contracts/version.js";

// W-009: a stray rejection used to take the process down mid-job. Log it and
// keep serving; a real exception still exits (after logging) so the
// supervisor restarts a process whose state can no longer be trusted. Jobs
// survive that (see platform/spawn.ts).
process.on("unhandledRejection", (reason) => {
  log.error(
    "api-server",
    `Unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
  );
});
process.on("uncaughtException", (err) => {
  log.error("api-server", `Uncaught exception: ${err.stack ?? err.message}`);
  process.exit(1);
});

const config = loadConfig();

// ── SEC-01: fail closed on missing API key ─────────────────────────────
// This API can start/stop servers and dispatch arbitrary console
// commands, so running it with no key = unauthenticated remote control.
// Refuse to boot keyless. A keyless *local* dev mode is available only
// when the operator explicitly opts in via MC_ALLOW_NO_AUTH=true, and
// even then we bind to loopback so it is never network-reachable.
const ALLOW_NO_AUTH = process.env.MC_ALLOW_NO_AUTH === "true";
const BIND_HOST =
  !config.API_KEY && ALLOW_NO_AUTH
    ? "127.0.0.1"
    : (process.env.MC_BIND_HOST ?? "0.0.0.0");

if (!config.API_KEY) {
  if (!ALLOW_NO_AUTH) {
    log.error(
      "api-server",
      "FATAL: no API key configured.\n" +
        "  Set apiKey in api-server-config.json, or the MC_API_KEY / API_SERVER_KEY env var.\n" +
        "  Refusing to start an unauthenticated server-control API.\n" +
        "  For a loopback-only keyless dev instance, set MC_ALLOW_NO_AUTH=true.",
    );
    process.exit(1);
  }
  log.warn(
    "api-server",
    "Running with NO API KEY (MC_ALLOW_NO_AUTH=true). " +
      "Auth is disabled and the server is bound to 127.0.0.1 only. Do NOT use in production.",
  );
}

const trust = resolveTrustProxy(process.env.MC_TRUST_PROXY, BIND_HOST);
if (trust.error) {
  log.error("api-server", `FATAL: ${trust.error}`);
  process.exit(1);
}

const { app, logStreamAPI } = await buildApp({
  config,
  allowNoAuth: ALLOW_NO_AUTH,
  trustProxy: trust.trustProxy,
});

// After the instances have recovered their job records, which name the only
// output files still worth keeping.
const swept = sweepOrphanedJobFiles();
if (swept > 0) log.info("api-server", `Removed ${swept} job output file(s) left by an earlier run`);

const instanceList = Object.keys(config.instances).join(", ");

try {
  await app.listen({ port: config.PORT, host: BIND_HOST });
  log.info(
    "api-server",
    `v${WRAPPER_VERSION} — instances: [${instanceList}] — listening on ${BIND_HOST}:${config.PORT}`,
  );
  // W-022: the API key crosses the network in a header, in clear text.
  if (BIND_HOST !== "127.0.0.1" && BIND_HOST !== "::1" && BIND_HOST !== "localhost") {
    log.info(
      "api-server",
      "Listening beyond loopback over plain HTTP: keep it on a trusted network, " +
        "or put a TLS reverse proxy in front (README § Security).",
    );
  }
} catch (err) {
  log.error("api-server", `Failed to listen: ${(err as Error).message}`);
  process.exit(1);
}

// ── Graceful shutdown ───────────────────────────────────────────────────
// A-10: dispose() releases all fs.watch handles and polling intervals so
// a long processLogChanges() iteration doesn't prevent a clean exit.
function shutdown(signal: string): void {
  log.info("api-server", `${signal} received — shutting down`);
  logStreamAPI.dispose();
  // Belt and braces: if close() still stalls (a socket mid-handshake),
  // exit anyway after 3 s rather than waiting for SIGKILL.
  setTimeout(() => process.exit(0), 3_000).unref();
  void app.close().finally(() => process.exit(0));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
