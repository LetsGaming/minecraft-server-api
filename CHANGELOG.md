# Changelog

All notable changes to mc-api-server are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/); versions follow
semver.

Sections for 3.2.0 to 3.5.0 were reconstructed from git history. The 3.x line
has no release tags, so each section holds what landed up to the commit that
bumped `package.json` to that version, dated by that commit. Entries after the
3.5.0 bump commit stay under Unreleased even though `package.json` already
reads 3.5.0. If a release was cut at a different commit, the split between two
neighbouring sections is the part to doubt; the entries themselves are
unchanged.

## [Unreleased]

### Added

- **Mod compatibility check** (`mod-compat` manifest feature, v1): `POST /instances/:id/mods/compat` starts a background job that checks every installed mod for a release on a target Minecraft version, and `GET /instances/:id/mods/compat/:jobId` reports progress, partial results and the final per-mod `available` / `unavailable` / `unknown` answer with the target release. It runs `check-updates.js --only=<slug>` per mod, three at a time, so one failing mod is one `unknown` entry rather than a failed job. One job per version, results cached for 6 hours (dropped by any mod change, `refresh` skips it), finished jobs evicted after about 15 minutes, at most 3 jobs run per instance and 6 per process (further starts answer 429), and `refresh` is limited to once per version every 30 seconds. Needs a setup suite whose `check-updates.js` accepts `--only`. `GET /mods/updates` is unchanged. Touched: `src/instances/{modCompat,mods}.ts`, `src/http/routes/instance/mods.ts`, `src/contracts/{schemas,wire,manifest}.ts`, `openapi.json`.
- **`openapi.json`, generated from the router** (`npm run openapi:generate`). Every route now declares a response schema (`src/contracts/schemas.ts`), and the document is built from the same route census that backs `/manifest`, with the package version as `info.version`. minecraft-bot vendors this file and generates its wire types from it. Touched: `src/contracts/{schemas,routeSchema,openapi,generateOpenApi}.ts`, `src/http/routes/**`, `openapi.json`.
- **`POST /instances/:id/mods/:slug/update`** updates one installed mod to the latest compatible build (`mod-management`).
- **`versionId` on `POST /instances/:id/mods`** pins a specific Modrinth build instead of the latest.
- **Disable and enable mods** (`mod-management` v2): `POST /instances/:id/mods/:slug/disable` and `/enable` move the jar between `mods/` and `mods/disabled/`. Entries in `GET /mods/installed` gain `enabled`, derived from where the jar sits; `GET /mods` leaves disabled mods out.
- **`DELETE /instances/:id/backups/files/:fileId`** removes one archive (`backup-files` v2), addressed by the same opaque id as download.
- **`restartCount` and `unitFailed` on `GET /instances/:id/health`** (`server-health` v2): systemd restart-loop detection, so a crash loop is told apart from a clean outage.
- `GET /manifest` carries `scriptTimeoutsMs`, the per-action ceilings the wrapper enforces, so a caller can wait at least as long (`stop` 240 s, `restart` 420 s, `rollback` 300 s, `backup` 600 s).
- `MC_BASH_PATH` and `MC_NODE_PATH` pin the interpreters used through `sudo` to absolute paths; documented with the `node` sudoers grant the mod routes need (`docs/sudoers-setup.md`).

- **Bulk player stats** (`stats-bulk` manifest feature, v1): `GET /instances/:id/stats/bulk` returns every player's stats file in one response, bounded to 8 concurrent reads server-side. Replaces the pattern of one HTTP request per lifetime player a leaderboard build used to make against this wrapper — on a server with a few hundred players who have ever joined, that was a few hundred simultaneous requests landing on a 4-thread filesystem pool and a shared rate-limit budget at once. Cached 30s/300s, same as the bot's own `loadAllStats()` TTL.
- **`GET /metrics`** (authenticated, exempt from rate limiting): per-route request count/p50/p95/error/timeout, current and peak in-flight requests, cache hit/miss counts, rate-limit rejections, RCON reconnect count, event-loop delay, and process memory/uptime. There was previously no way to answer what the wrapper was doing right before it became briefly unreachable.
- **Mod config index lists more files and says when it is incomplete.** `GET /instances/:id/configs` now returns every text config file under the roots (`.toml`, `.json`, `.json5`, `.properties`, `.cfg`, `.conf`, `.ini`, `.yml`, `.yaml`, `.txt`, `.snbt`), walks eight levels deep instead of three, skips cache, backup, log, `.git` and `node_modules` directories, follows symlinks only when they stay inside their config root, and caps the listing at 2000 files with `truncated: true`. Each entry gains `editable` and `tooLarge`; files over the 1 MB cap are listed as too large instead of vanishing. A UTF-8 BOM is hidden from the client and kept on write. Touched: `src/instances/configFiles.ts`, `src/contracts/{schemas,wire}.ts`, `openapi.json`.

### Changed

- **`POST /instances/:id/command` reports how the command travelled** (`rcon-command` v2). The reply is now `{ result, via: "rcon"|"screen", sent, rconError? }`; `result` is unchanged for older bots. `rconError` names why RCON was skipped when the screen fallback carried the command. A command that neither RCON nor `screen` could deliver now answers `502 { error }` instead of `200 { result: null }`. Touched: `src/instances/commands.ts`, `src/http/routes/instance/control.ts`, `src/contracts/{schemas,wire,manifest,routeSchema}.ts`, `openapi.json`.
- Replies are serialized through their response schema, so a field that is not part of the contract no longer reaches a client. The restore test stub returned a shape the real route never produced; it now matches `ScriptResult`.
- The README route table lists the mod, config and delete routes it was missing, and no longer names wrapper versions for features. Read the features in `GET /manifest` instead.
- **Startup now fails** for an API key shorter than 32 characters and for a `linuxUser` that is not a valid Linux user name, each with a message naming the problem. Existing deployments with a short key must set a longer one (`openssl rand -hex 32`) in both the wrapper and the bot.
- Mod slugs must start with a letter or digit (`^[a-zA-Z0-9][\w.-]{0,95}$`), and slugs reach the update scripts after a `--` separator so a value can never be read as an option.
- Mutating mod scripts (add, remove, update, apply, enable, disable) run one at a time per instance, so concurrent requests no longer lose each other's manifest writes. Update checks are not queued.
- `stop` and `restart` script timeouts rose from 60 s to 240 s and 420 s: the scripts warn players, count down, wait up to 60 s for the save and wait for systemd, and a kill mid-sequence could land after `save-off`.
- The write rate limit (10 per minute per IP) is charged after authentication. Its table is swept when it grows large.
- `remove-mod` results no longer have an `orphanedDependencies` field; it was always empty.
- `.claude-flow/` is untracked and ignored.

- The global rate limit (300 requests / 15 min, shared by every client and every route) is now two separate budgets: reads get 100/min, writes (scripts, mod mutations, restore, console commands) get a stricter 10/min. Both return `Retry-After`. The old flat budget was easy for a single leaderboard build or one open dashboard tab to exhaust well before the window rolled, and every request past it looked identical to the bot as "wrapper unreachable" rather than "rate limited".
- Added a global in-flight request ceiling (32) returning a fast 503 + `Retry-After` above it, instead of accepting more work than the process can serve in time.
- Previously-uncached routes now use the existing single-flight/stale-while-revalidate cache: `/instances/:id/info`'s host block (60s/300s — this route ran two full `du` walks per call), `/capabilities` (5min/1h), `/whitelist` (30s/300s), `/usercache` (60s/600s), `/backups` (60s/600s), `/backups/files` (60s/600s), and `/mods` + `/mods/installed` (60s/600s). Each is invalidated by the mutation that can change it.
- `mods.ts`'s `getModSlugs()` checked each installed mod's enabled/disabled state one at a time in a sequential loop; it and `listInstalled()`'s equivalent unbounded `Promise.all` now both go through a bounded-concurrency helper (`platform/concurrency.ts`), also applied to the backup-files index.
- PM2's memory ceiling moved from `max_memory_restart: "256M"` to `768M` with a matching `--max-old-space-size`, and both the PM2 and systemd deployment paths now set `UV_THREADPOOL_SIZE=8`; the systemd unit gained a `MemoryMax` it never had.

### Removed

- `openapi.yaml`. It was hand-written, had drifted (`info.version` read 3.0.0), and is replaced by the generated `openapi.json`. A test fails when the committed file is not what the router generates.

### Fixed

- **Saving a config above 4 KB failed with 413.** The global 4 KB body limit applied to `PUT /instances/:id/configs/:fileId`, so most real mod configs could not be saved. That route now accepts bodies up to twice the 1 MB config cap plus headroom; the writer still enforces the cap on the text itself and answers 413 when it is exceeded.
- Config files in nested mod folders (`config/xaero/minimap/settings.json`) are grouped under the folder's mod instead of the filename.
- The config index is reused for five seconds per instance and dropped on every write, instead of walking the tree for every read and write.
- `POST /instances/:id/backups/files/:fileId/restore` now answers `409` with `{ error, state }` unless instance health reports `offline` (`online` and `unresponsive` both refuse) using a fresh, uncached probe, and `503` when that probe cannot complete, instead of running `restore.sh` against a live world. Touched: `src/http/routes/instance/backups.ts`, `tests/http/backupRestore.test.ts`.
- RCON: the 10 s authentication timer stayed armed after a socket error or close and later tore down whatever newer, healthy connection existed, which showed up as flapping after an outage. The timer is now cleared on cleanup, and an authentication timeout reports `RCON auth timeout`.
- Log streaming: a read window ending mid-line (the 1 MB clamp, or the server between two writes of one line) emitted a truncated line and then a bogus second one, which the chat bridge parsed. Only complete lines are sent now; the remainder is read on the next pass.
- Log streams (`GET /logs/stream`) permanently held an in-flight slot each, because Fastify does not run `onResponse` for hijacked replies. After 32 streams over the wrapper's lifetime every route except `/health` and `/metrics` answered 503. The slot is released when the stream starts.
- `AuthFailTracker.isBlocked` created an entry for every IP it was asked about, and aged-out entries were only swept above 10,000 IPs. Lookups no longer create entries and a sweep runs every minute.
- Script children no longer inherit the wrapper's environment (`MC_API_KEY`, `RCON_PASSWORD_*`), and a child that ignores `SIGTERM` after a timeout is killed with `SIGKILL` ten seconds later.
- Two `monitoredPaths` tests failed on Windows because they compared POSIX literals to `path.resolve` output.

- `POST /instances/:id/backups/files/:fileId/restore` now answers `409` with `{ error, state }` unless instance health reports `offline` (`online` and `unresponsive` both refuse) using a fresh, uncached probe, and `503` when that probe cannot complete, instead of running `restore.sh` against a live world. Touched: `src/http/routes/instance/backups.ts`, `openapi.yaml`, `tests/http/backupRestore.test.ts`.
- A sustained RCON outage had no backoff: every failed `send()` retried a full TCP connect + up to a 10s auth timeout on the very next call, and a burst of concurrent `/command` requests during that window could each hold a request open for up to 25s (the auth timeout plus the `screen stuff` fallback). The RCON client now fails fast for 2s after a failed connect instead.
- `AuthFailTracker` (the auth-failure rate limiter) never evicted an IP once tracked, growing forever under a scanner hitting many source addresses. It now sweeps aged-out entries once past 10,000 tracked IPs.
- `logStream.ts`'s per-instance 1s log-tail poller used synchronous `fs` calls on the event loop and ran its full read-and-broadcast work every tick regardless of whether any SSE client was attached to that instance; it now uses async `fs` calls and skips straight to tracking the read offset when nobody is watching.
- `platform/spawn.ts` (the shared runner behind scripts, mod mutations, and restore) accumulated a spawned process's entire stdout/stderr in memory with no cap; a chatty script over the 600s mod-update timeout could grow unbounded. Capped at 2 MiB per stream.

## [3.5.0] - 2026-08-17

### Added

- **Mod management API** (`mod-management` manifest feature, v1): `GET /instances/:id/mods/installed` (versions and filenames), `POST /instances/:id/mods` (install by slug), `DELETE /instances/:id/mods/:slug`, `GET /instances/:id/mods/updates` (check) and `POST /instances/:id/mods/updates` (apply). Each runs the suite's `update/*.js` script as the instance user with `--json`. A script that ran returns its structured result at 200, including its own handled `{ ok: false, error, code }`; only a failure to run it is a 500.
- `platform/spawn.ts`, the one place a child is spawned as the instance's Linux user, now shared by the script runner, restore and the mod runner.

## [3.4.0] - 2026-08-02

### Added

- **Mod config file API** (`mod-configs` manifest feature, v1): index, read,
  write and revert for mod config files.

  Same addressing rule as the backup routes — no route accepts a path. Files
  come from an allow-list of roots (`config/`, `defaultconfigs/`,
  `world/serverconfig/`, `plugins/`, plus `server.properties`), and a client
  gets an opaque id it can send back and nothing else.

  That matters more here than for backups. Backups live in one directory with
  one extension; configs sit inside a server directory that also holds the
  world, the jar and `ops.json`. An editor that can reach those is a remote
  shell with extra steps, so the allow-list is the feature. Symlinks are
  neither followed nor listed, a realpath check backs that up, and files over
  1 MiB are skipped.

  `PUT` requires `If-Match` (428 without it, 412 on mismatch): two open editors
  would otherwise overwrite each other, and many mods rewrite their own config
  at shutdown. Every write snapshots the previous contents first, and the last
  10 are revertable.

  The wrapper does not parse config formats. It serves bytes and takes bytes;
  parsing, schema derivation and the splicing writer live in the bot, because a
  wrapper release is a deploy on every Minecraft host and TOML dialects are not
  worth that.

## [3.3.0] - 2026-08-02

### Added

- **Individual backup archives: listing, download, and restore**
  (`backup-files` and `backup-restore` manifest features, both v1).

  `GET /backups` only ever answered "how big is each tier". Everything that
  needed a *file* — downloading one, restoring from one — had to be done over
  SSH or from the old web panel, which is the last thing keeping that panel
  installed.

  Three routes: `GET /backups/files` (cursor-paged, newest first),
  `GET /backups/files/:fileId/download`, and
  `POST /backups/files/:fileId/restore`.

  **No route accepts a path.** Clients get an opaque `id` from the index and
  can send nothing else back. The obvious design — a filename plus a
  `resolve` + `startsWith` guard — is a check that has to be written correctly
  every time, and it does not catch a symlink planted inside a tier anyway.
  Addressing by handle means the path is one this wrapper chose, so traversal
  is not defended against, it is unrepresentable. A `realpath` containment
  check sits behind that for the symlink case.

  The id is derived from the instance id and the archive's relative path, so it
  survives a restart (a download URL keeps working across a redeploy) and an id
  from one instance cannot resolve against another's backups directory.

  Downloads stream with `Content-Length` set and support `Range`: these
  archives run to gigabytes, and without ranges an interrupted download starts
  over.

  Restore is deliberately **not** a `scripts/run` action. That route validates
  every argument against `SAFE_ARG`, which forbids `/` precisely so a client
  cannot hand a path to a spawned shell — and `restore.sh` needs an absolute
  path. Loosening the validator to fit would give the guard away for every
  script at once, so restore gets its own route and resolves the path itself.

- **`rollback` is a runnable script action.** `rollback.sh` joins `SCRIPT_MAP`
  with a 300s timeout, and the capability probe reports whether it exists.

- **`capabilities` gained `scripts.rollback` and `restore`.** Additive; a
  client reading the old fields is unaffected.

- **Host metrics v2** (`host-info` manifest feature, v2): `process.cpuPercent` is sampled over a short window instead of `ps`'s lifetime average, `GET /instances/:id/info` gains a whole-machine `host` block (CPU, memory, uptime), and each disk entry carries its directory's own size plus the filesystem it sits on.

### Changed

- **The backup timeout is 600s, was 300s.** A large modded world takes longer
  than five minutes to archive, and the timeout does not merely give up: it
  SIGTERMs the process group, so `backup.sh` dies partway through and leaves a
  truncated archive where a good one should be. Ten minutes is what the old
  panel allowed for the same script, so this is the conservative value rather
  than a generous one.

### Fixed

- **`npm audit` reported a high-severity advisory** (`brace-expansion`, DoS via
  unbounded expansion). Transitive through ESLint only, so it never reached the
  running wrapper, but it made every CI log say "1 high severity vulnerability"
  and that is how a real one gets ignored. Lockfile-only fix.

- **The hand-written OpenAPI file documented `scripts/run` without `rollback`, and referenced
  a `ScriptResult` schema that was never defined.** The route-coverage check in
  CI compares paths against the real router, so neither showed up there; both
  are now correct, and `ScriptResult` is defined once and shared.

## [3.2.0] - 2026-07-27

### Added

- **`GET /instances/:id/health` — liveness and responsiveness, reported
  separately** (`server-health` manifest feature, v1).

  `/running` answered one question — *did RCON reply to `list` within three
  seconds?* — and every caller read it as a different one: *is the server up?*
  Those come apart exactly when it matters. A server pinned by chunk
  generation, a busy evening, or heavy mob-AI simulation stops answering RCON
  long before it stops running, and a server still loading its world has not
  started answering yet. All of them reported `running: false`.

  The new route reports `state` as `online` / `unresponsive` / `offline`,
  alongside `processUp`, which probe established it, and the RCON picture as
  its own object. Liveness now comes from probes that survive a stalled game
  thread, cheapest first: a TCP connect to the RCON port (accepted by the
  JVM's Netty IO threads while the main thread is blocked), then `ps` for the
  instance user's java process (no sudo, and it covers the startup window
  before RCON binds), then `screen -list`. RCON is used only for
  responsiveness.

  Note what the body deliberately cannot say: "the wrapper is down". This
  process cannot report its own absence — clients model that themselves and
  must not fold it into `offline`.

  The body also carries `gamePort`, read from `server.properties`. That is
  there for the case this endpoint cannot cover: a client that has lost
  contact with this wrapper can ping the Minecraft server directly, and
  telling it the port while we still can is what makes that work without the
  operator configuring the same thing twice.

### Changed

- **`/running` is now process liveness, not an RCON probe.** `running` is
  `state !== "offline"`, so a loaded server stops reporting itself stopped
  without any client change. Clients that need the distinction should move to
  `/health`.

- **Concurrent reads share one round-trip.** Health, the player list and TPS
  go through a single-flight, short-TTL cache that serves a recent value while
  a refresh is in flight rather than queueing. A status poll, a `/list` and a
  TPS check arriving together used to start three RCON commands against the
  same stalled game thread and each waited for the ones in front of it — which
  is how the *API* came to look unresponsive when only the server was. The
  health probe's own `list` output now feeds `GET /list`, so the two cost one
  command between them.

- **An unresponsive server keeps its last known player roster** (up to two
  minutes) instead of answering with zero players. "0 online" is a claim, and
  a stale-but-true roster beats a fresh lie — a lag spike is not an exodus.

- **Every filesystem read is off the event loop.** `getBackups`,
  `getWhitelist`, `getUserCache`, `getStats`, `listStatsUuids`,
  `getCapabilities` and `getModSlugs` were synchronous. A backup scan across
  five tiers of thousands of archives blocked *every* concurrent request,
  `/health` included. The backup tiers are also scanned in parallel now.

### Fixed

- **The log stream dropped filesystem events that arrived mid-read.**
  `processLogChanges` returned early when a read was already draining, so
  those lines waited for the next fs event or the 1 s poller. On a busy server
  — longest reads, fastest writes — that was most of them, and it is the
  wrapper's half of the lag minecraft-bot's chat bridge shows between someone
  typing in game and the message reaching Discord. Events are coalesced and
  re-run on completion now, and the 1 MB-per-cycle catch-up clamp no longer
  costs a poll interval per chunk.

- **An unreadable stats directory was reported as an empty one.**
  `GET /instances/:id/stats` caught every error from reading
  `<serverPath>/<level-name>/stats` and answered `200 {"uuids": []}` — so a
  permissions problem, a wrong `serverPath`, or a mismatched `level-name` was
  indistinguishable from a world nobody has played on.

  That is not a cosmetic difference. minecraft-bot takes an hourly stat
  snapshot per server, and a snapshot with zero players acts as a **zero
  baseline**: every period leaderboard then subtracts nothing and reports
  all-time totals as the period's gains. A quiet wrong answer here became a
  quiet wrong answer several layers away, in another repo.

  ENOENT still returns `[]` — no stats directory genuinely means nobody has
  played. Anything else (EACCES above all) now logs the path and the reason
  and returns 500, so the operator sees the failure instead of the bot
  inferring emptiness from it.

## [3.1.1] — 2026-07-15

### Fixed

- **Player stats were unreachable on servers that do not use the vanilla world
  layout.** `getStats`, `listStatsUuids` and `deleteStats` each built
  `<serverPath>/<level-name>/stats` and looked nowhere else. A Fabric instance
  in the field keeps its stat files at `<level-name>/players/stats`, beside
  `players/advancements`, and has no `<level-name>/stats` at all — so every
  read missed, `/stats/:uuid` 404'd for players who plainly had stats, and
  `/stats` answered `{uuids: []}` with a 200.

  **The wrong path and an empty world are the same ENOENT**, which is why this
  was silent rather than loud: 3.1.0 taught `listStatsUuids` to distinguish
  unreadable from empty, but a mismatched path still reads as "nobody has
  played here". Both layouts are now probed, resolved once per level name, and
  the chosen directory is logged at startup. If a third layout turns up, add it
  to `STATS_DIR_CANDIDATES` in `operations.ts`.

### Added

- **TPS parsing now has regression tests** (`tests/tps.test.ts`, 10 cases).
  The parser already carried three fixes, and had no test at all — the guards
  lived in minecraft-bot, against the RCON client it used to own. Bot 5.0.0
  drops local mode, so the wrapper is now the only side that ever sees a `tps`
  response and inherits the bugs along with the job:

  - an unanchored regex reading "ticking 12, 34, 56 ms behind" as a TPS
    triplet and firing a false Low TPS alert;
  - a missing tick-query line parsed as zero TPS rather than "no answer";
  - `1000 / mspt` uncapped, reporting >20 TPS on a fast server.

  Each was verified to fail the suite when reintroduced.

## [3.1.0] — 2026-07-15

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
