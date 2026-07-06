# Changelog

All notable changes to mc-api-server are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/); versions follow
semver.

## [3.0.0] — 2026-07-06

TypeScript rework + the two endpoints minecraft-bot has been waiting
for. Upgrading: `npm ci && npm run build` (Node 20+ now required) —
config files, `node index.js`, the PM2 ecosystem and systemd units all
keep working unchanged. The API is a superset of 2.x.

### Added

- **`GET /instances/:id/info`** — wrapper version + host metrics: the
  server's Java process (pid, CPU %, RSS — biggest java process of the
  instance's linuxUser) and `df` disk usage for the server and backups
  directories. This is the wrapper half of the bot's "remote host
  metrics + version handshake" feature: the bot's startup warning about
  a missing `/info` disappears, and remote instances get host metrics
  in the status view plus disk-space alerts. Satisfies the bot's
  `MIN_WRAPPER_VERSION` (1.2.0).
- **`GET /instances/:id/usercache`** — `usercache.json` filtered to the
  `{name, uuid}` entries the bot expects; its best-effort name source
  on top of the whitelist.
- `GET /health` now reports the wrapper version alongside `ok`.
- Failed authentications are rate-limited separately (20 per IP per
  15 min) on top of the global limit, with constant-time key comparison
  as before.
- `MC_DEBUG=true` enables debug logging.

### Changed

- **TypeScript, ESM, Fastify.** The source moved to strict TypeScript
  under `src/` (built to `dist/`), Express 4 was replaced with
  Fastify 5, and tests run on vitest — matching the conventions of the
  minecraft-bot repo this wrapper serves. A root `index.js` shim keeps
  every existing start command working; the PM2 ecosystem still points
  at `index.js`.
- Node.js 20+ required (was 18+).
- `openapi.yaml` rewritten to match the implemented API (the old spec
  described `/players`, `/logs`, `/action` and `/whitelist/{username}`
  routes that never existed in 2.x, and was missing half the real
  ones). Every route, shape, and error body is now specified.
- README rewritten: `api-server-config.json` is documented as the
  primary configuration (matching the actual load order), with
  `variables.txt`/env vars as the single-instance fallback.
- Structured log output (same `[time] [LEVEL] [scope]` format as the
  bot).
- Graceful shutdown force-closes open SSE connections instead of
  waiting on them (SIGTERM completes in milliseconds even with
  connected log-stream clients).

### Preserved

Every audit invariant from the 2.x line carries over verbatim, with
its tests: fail-closed startup without an API key + loopback-only
keyless dev mode (SEC-01), screen command sanitisation (A-01), script
process-group kill on timeout (A-02/BUG-01), level-name cache (A-03),
TOCTOU-free mod manifest read (A-04), log stream read clamp (A-05),
backup rotation race guard (A-06), 4 KB body limit (A-07), command
validation (A-08), RCON packet length validation (A-09), watcher
disposal on shutdown (A-10), stats path-traversal guards (A-11),
UUID + script-args allowlists (F-001), variables.txt parser
fixes (F-007), mods 404 semantics (F-008), tail lines clamp (F-009),
screen-name regex escaping (F-011), and the capabilities
contract (M-13).

## [2.1.0] and earlier

See the git history of the 2.x line.
