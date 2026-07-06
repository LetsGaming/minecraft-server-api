/**
 * Entry point: config resolution, SEC-01 fail-closed key check, listen,
 * graceful shutdown. App assembly lives in app.ts (testable).
 */
import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";
import { log } from "./logger.js";
import { WRAPPER_VERSION } from "./version.js";

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

const { app, logStreamAPI } = await buildApp({
  config,
  allowNoAuth: ALLOW_NO_AUTH,
  // SEC-03: only set this when the wrapper sits behind a reverse proxy
  // that sets (not forwards) X-Forwarded-For — see README § Security.
  trustProxy: process.env.MC_TRUST_PROXY === "true",
});

const instanceList = Object.keys(config.instances).join(", ");

try {
  await app.listen({ port: config.PORT, host: BIND_HOST });
  log.info(
    "api-server",
    `v${WRAPPER_VERSION} — instances: [${instanceList}] — listening on ${BIND_HOST}:${config.PORT}`,
  );
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
