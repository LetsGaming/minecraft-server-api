# Changelog

All notable changes to mc-api-server are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/); versions follow
semver.

## [3.1.0] - 2026-01-15

### Added

- **`GET /manifest`** — the wrapper now publishes what it can do, so a bot
  can report exactly which features it is missing instead of inferring it
  from one semver compare. Returns the route census, a versioned feature
  list with summaries, and the script actions the runner accepts.
  Authenticated (a route census is reconnaissance); bots that get a 404
  fall back to the `/instances/:id/info` version check.

  It is **generated, not written**: `routes` comes from Fastify's own
  router via an `onRoute` hook and `scriptActions` from the same
  `SCRIPT_MAP` the runner validates against, so neither can describe
  something this wrapper does not do. That distinction is the whole point
  — serving `openapi.yaml` instead would have handed the bot a document
  that has already lied (the 2.x spec described `/players`, `/logs`,
  `/action` and `/whitelist/{username}`, none of which existed).

  Three CI checks keep it honest, and each fails on real drift: every
  feature's routes must exist, every instance route must belong to a
  feature (so a new route cannot ship without the bot hearing about it),
  and `openapi.yaml` must match the router exactly — which retires the
  spec-drift problem the 3.0.0 rewrite had to clean up by hand.

- **`bot contract` CI job** — runs minecraft-bot's real serverAccess against
  this wrapper on every PR that touches `src/` or `openapi.yaml`. The bot casts
  our responses to its own types, so renaming a field type-checks on both sides
  and only shows up as a remote instance quietly returning `undefined`; `npm
  test` here cannot see that. The check lives in the bot repo (it asserts the
  bot's expectations) and this job points it at the checkout.

### Fixed

- README pointed at a `your-org/minecraft-server-setup` placeholder that was
  never filled in.

### Security

- **SSE log streams are capped per instance** (audit SEC-02): more than
  50 concurrent `/logs/stream` clients (configurable via
  `MC_SSE_MAX_CLIENTS`) now receive `503` instead of exhausting sockets
  and file descriptors. The cap is checked before the reply is hijacked.
- **Slow SSE consumers no longer stall the fan-out** (audit SEC-06):
  when `write()` reports a full socket buffer the client is skipped
  until `'drain'` instead of buffering unboundedly — one stuck consumer
  can no longer degrade delivery for everyone.
- **Proxy-aware rate limiting** (audit SEC-03): `MC_TRUST_PROXY=true`
  makes Fastify honor `X-Forwarded-For`, so the auth-failure lockout and
  global limiter key on the real client behind a reverse proxy. Without
  it, all proxied callers shared the proxy's IP — one attacker's 20
  failed keys locked out every client. Only enable behind a proxy that
  *sets* the header; default stays `false` for direct binds. Documented
  in `.env.example` and README § Security.
- **`500` bodies are a fixed string** (audit SEC-05): all 16 route catch
  blocks returned `String(err)` — absolute paths, sudo/stderr fragments
  included. Detail now goes to the wrapper log; clients get
  `{ "error": "Internal server error" }`. Unknown script actions are
  validated up front and return a helpful `400` instead of tripping the
  generic path.

### Fixed

- **Unparseable ports fall back with a warning** (audit BUG-02):
  `RCON_PORT=garbage` in the vars/env fallback produced `NaN` (nullish
  coalescing does not catch `NaN`); `API_SERVER_PORT`/`MC_PORT` had the
  same hole, and hand-edited JSON `rconPort` values were unvalidated.
  All port sources now validate to 1–65535 and warn-and-default
  otherwise.

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
