# minecraft-server-api (mc-api-server): project audit

**Date:** 2026-10-14
**Commit:** `0a0c022` (v4.1.0, shallow clone of the default branch)
**Type:** audit only. No project files were changed. The repository was cloned read-only into a separate working directory.
**Companion report:** `minecraft-bot-audit-2026-10-14.md`, which covers the client side.

## 1. Executive summary

The wrapper is defensively written in the places that are usually the weakest:

- no shell anywhere, argv arrays only
- a validated `linuxUser`
- an allow-listed child environment, so the API key and RCON passwords never reach scripts
- constant-time API-key comparison, header only, at least 32 characters
- opaque, unforgeable file ids with realpath checks
- a strict slug regex
- closed response schemas with drift tests

Typecheck, lint, and all 643 tests pass, and `npm audit` reports nothing.

The serious problems are in protocol and runtime behaviour that the tests do not exercise.

**Top risks**

1. **Console-command injection through GNU screen escapes** (W-001). The screen fallback strips real control characters, but `screen -X stuff` itself turns `^M` and `\015` into Enter. Any console text can therefore carry extra commands. That text includes a Discord message relayed by the bot's chat bridge, so a Discord member could run `op <self>`. The fallback is used whenever `useRcon` is false (the default) and after any RCON error.
2. **The whole API can lock itself into 503** (W-002). The in-flight counter is decremented only in `onResponse`, which never fires for requests the client aborted. **Reproduced.** After 33 aborted slow requests, every route except `/health` and `/metrics` returns 503 until the process restarts.
3. **One long RCON reply jams RCON** (W-003). Packets over 4096 bytes are rejected but left in the buffer, so every later command times out. Each timeout then re-sends the command through screen (W-005), which both double-executes it and opens W-001 on instances that do use RCON.
4. **`/list` reports zero players while people are online** (W-004), whenever a request lands in the "recent RCON success" trust window.

**Structural weakness.** The wrapper runs as `apiuser` but reads and writes files in directories owned by the instance user (`minecraft`) and follows symlinks there. Several operations also release their exclusive slot before the underlying process has exited. Both undermine the privilege and concurrency boundaries the design otherwise draws well (W-007, W-008).

**Main limitation.** The setup-suite scripts that the wrapper drives (`upgrade.sh`, `restore.sh`, `prune-chunks.js`, the mod scripts, and their file lock) are in a third repository and were not audited. GNU screen is not installed in this environment, so W-001 is not reproduced.

**Finding counts:** Critical 0 · High 4 · Medium 8 · Low 10 · Informational 5.

## 2. Audit scope and method

- **Scope:** the whole repository, weighted by risk:
  - HTTP auth, hooks and limits
  - config loading
  - process spawning, sudo, screen and RCON
  - the operation slot and locking
  - config-file editor, backups, restore, stats, mods, prune and upgrades
  - log streaming, health and metrics
  - contracts with the bot
  - CI/release and scripts
  - test gaps
- **Context assumed, carried over from the bot audit interview** (I did not re-ask):
  - The wrapper is reachable from the bot host over a private network.
  - The API key is held only by the bot and dashboard processes.
  - Several user inputs reach the wrapper verbatim through the bot: dashboard console commands, chat-bridge text, ban reasons, config edits, prune dimensions and mod slugs.
  - The report location is the session scratchpad.
- **Method:** static review first. Three parallel read-only reviews covered:
  - auth, exec and RCON
  - files, backups, mods and prune
  - reliability, contract, CI and tests

  I then re-checked every High and most Medium findings in the source. W-002 was reproduced with a minimal Fastify script against the same Fastify/Node versions; the script was deleted afterwards. W-003's decoder rejection was confirmed by the reviewer's script and by my reading of the code.
- **Labelling:** findings I did not re-check myself are marked "traced, not independently re-checked".

## 3. Findings

### [HIGH] W-001: Screen fallback lets console text inject extra commands (`^M` / `\015`)

**Location:**
- `src/instances/commands.ts:15-17`: `sanitizeScreenCommand` strips only `[\r\n\x00-\x1f\x7f]`.
- `commands.ts:~58-62`: `sudo -n -u <user> screen -S <id> -X stuff "<cmd>\r"`.
- `src/http/consoleCommand.ts`: rejects `\p{C}` only.
- `config/load.ts:104,166`: `useRcon` defaults to false.

**Evidence:**
- GNU screen processes string escapes in `stuff` arguments. `^M` (caret notation) and `\ooo` (octal) become a carriage return. The common `screen -X stuff "stop^M"` idiom relies on exactly this.
- Neither the wrapper's sanitiser nor the bot's `stripControlChars` touches `^` or `\`. A payload like `say hi^Mop Attacker` reaches screen intact. The reviewer confirmed this against both sanitisers with a scratch script.
- The minecraft console then executes `op Attacker` as a second command.

**Who can reach it:**
- Any Discord member who can post in a bridged channel. The bot relays Discord chat as a console `/say …` (minecraft-bot `chatBridge.ts:~417`, `serverMessages.ts:28`).
- Anyone who can supply a ban or kick reason.
- A dashboard `server:console` holder, who could use it to bypass the bot's `op`/`stop` deny-list.

**Preconditions:** the instance uses the screen path. That is the case when `useRcon` is off (the default), and also on RCON instances after an RCON error or timeout (W-005).

**Consequence:** in-game operator takeover and arbitrary console commands (`stop`, `whitelist off`, griefing). The command runs as the Minecraft console, not as a host shell.

**Remediation:**
- On the screen path, reject (do not strip) `^` and `\`, and evaluate `$` as well.
- Or deliver the line through `screen -X readbuf <tmpfile>` plus `paste`, so no escape processing happens.
- Prefer RCON wherever it is available.
- Mirror the rejection in the bot for bridge text and reasons.
- Add a test against a real screen session running `cat`.

**Confidence:** strongly supported but not reproduced. The sanitiser behaviour is verified; the screen escape semantics are documented and widely relied upon, but screen was not available here to run it.

### [HIGH] W-002: In-flight counter leaks on client aborts and eventually returns 503 for every route

**Location:** `src/http/app.ts:114-119` (`beginRequest` in `onRequest`, `endRequest` only in `onResponse`), `:130-139` (503 gate, `MAX_IN_FLIGHT = 32`).

**Evidence:**
- Fastify runs `onResponse` only on the response's `finish`/`error`. When the client has already closed the socket, sending the reply emits neither.
- **Reproduced:** a minimal Fastify 5.12.5 / Node 22.22.0 app using the same hook pattern, an 800 ms handler and five client requests aborted at 100 ms ended with the counter stuck at 5.
- The bot aborts its wrapper calls with `AbortSignal.timeout` (8 s by default for GETs). Wrapper handlers that can outlive that include `/info` waiting on `du` (20 s), RCON stalls (W-003), and slow script status checks.
- Each such abort permanently consumes one slot. After 33, every route except `/health` and `/metrics` returns 503 "Too many concurrent requests" until restart. The bot then sees the wrapper as down.

**Remediation:** decrement exactly once per request on `reply.raw.once("close")` (or `onRequestAbort`) using a per-request guard, and route the SSE path's `endRequest` through the same guard. Add a test that aborts a slow request.

**Confidence:** verified by reproduction of the mechanism, using the same versions and the same hook pattern.

### [HIGH] W-003: One RCON reply over 4096 bytes jams the RCON connection permanently

**Location:**
- `src/platform/rcon/packet.ts:~34`: `if (length < 10 || length > 4096) return null`.
- `src/platform/rcon/client.ts:~140-146`: the data loop `break`s on `null` and keeps appending to `_buf`.
- `client.ts:~176`: a pending request is resolved on the first fragment.

**Evidence:**
- Vanilla servers split replies into 4096-character chunks, so a valid packet's length field can be up to 4106, and more with multi-byte UTF-8 characters.
- Such a packet makes `decodePkt` return `null` forever. Nothing tears the socket down and `_auth` stays true.
- From then on, every command, TPS read and player list times out after 5 s, and `_buf` grows without bound.
- Triggers include `help`, a large `data get`, or a long player list with formatting.
- **Related:** later fragments of a multi-packet reply arrive after the pending entry was deleted, so long replies are silently truncated.

**Remediation:**
- Accept lengths up to the protocol's real maximum (about 4096 × 3 + 10).
- On an undecodable frame, call `_cleanup()` and reconnect.
- Collect fragments, using the usual empty follow-up packet as the end marker.

**Confidence:** verified (code read; the reviewer's script confirmed `decodePkt` returns `null` for a 4096-character body).

### [HIGH] W-004: `/list` reports 0 players while players are online

**Location:** `src/instances/health.ts:~222-226` (trust path: `rconResponsive = true`, `list` stays `null`) and `:~321-335` (`getList` falls through to `{playerCount:"0", players: []}` unless the state is "unresponsive").

**Evidence:**
- Every successful RCON call refreshes `lastSuccessTime`, including `/tps`, `/command` and the probe itself.
- A `/list` request that misses the 2 s cache but falls inside the 10 s trust window gets an empty roster.
- On the bot side this empties player embeds, can close play-session tracking, and feeds wrong counts into player-count history and the sleep/AFK logic.
- `tests/instances/health.test.ts:~56` uses a `fakeRcon` that never updates `lastSuccessTime`, which hides the bug.

**Remediation:** on the trust path, serve the last known list (or run `list` when one is needed), and return `lastList` whenever the state is "online" and the list is recent. Make the test fake update `lastSuccessTime`.

**Confidence:** verified (code read).

### [MEDIUM] W-005: An RCON timeout re-sends the command through screen

**Location:** `src/instances/commands.ts:~41-52`. Every `rcon.send` error, including `"RCON timeout"` (`client.ts:~201`, 5 s), falls through to the screen path.

**Evidence:**
- A command the server executed but answered slowly runs a second time: double `give`, `summon`, `kill`, `ban`. Lag spikes and heavy commands make this realistic.
- Combined with W-003, every command after a jam goes through screen. RCON-configured instances are then exposed to W-001 and lose command output, which breaks the bot's `delivered` outcome.

**Remediation:** fall back to screen only when connecting or authenticating fails, never after the command packet has been written.

**Confidence:** verified (code read).

### [MEDIUM] W-006: The config editor exposes and allows changing security-critical server settings

**Location:** `src/instances/configFiles.ts:35-43` (roots `config`, `defaultconfigs`, `world/serverconfig`, `plugins`, plus `server.properties`) and `:~381-407` (write path). There is no redaction and no key deny-list.

**Evidence:**
- **Reads expose:**
  - `rcon.password` and `management-server-secret`
  - plugin secrets such as DiscordSRV tokens and LuckPerms database credentials
- **Writes can change:**
  - `enable-rcon`, `rcon.password` and `rcon.port`
  - `online-mode=false`, after which anyone can join under an op's name
  - `white-list`, `op-permission-level` and `enforce-secure-profile`
  - `level-name`, which also redirects where stats are read and deleted (`world.ts:~33`, `stats.ts`)
- The bot forwards dashboard edits verbatim to holders of `config:read`/`config:write`, a capability the bot documents as mod tuning. This resolves the open question in bot finding AUD-009: **confirmed**.

**Remediation:** in the wrapper, redact secret keys on read and refuse edits to privilege-relevant keys unless the request carries an explicit elevated flag. Alternatively, move `server.properties` and `plugins/` behind a sysadmin-only capability on the bot side.

**Confidence:** verified (code read).

### [MEDIUM] W-007: Files owned by the instance user are opened as `apiuser` with symlinks followed

**Location:**
- `configFiles.ts:~176-185` (`walkRoot`) and `:~320-330` (`resolve`): each root is compared only against its own realpath, never against `realpath(serverPath)`.
- `configFiles.ts:~354-369` (`snapshot`): no realpath check, then pruning `rm` of every entry except the last 10.
- `configFiles.ts:~428-438` (revert).
- Same pattern in `prune.ts:~321-358` (tiles and map files), `logs.ts:~81`, and a check-then-use race in `backupFiles.ts:~204-231` / `routes/instance/backups.ts:~161-170`.

**Evidence:** the wrapper (`apiuser`) and the server (`minecraft`) are separate users by design (`docs/sudoers-setup.md`). Code running as `minecraft`, such as a malicious mod or plugin or a compromised server, can:

- symlink `plugins/` to the wrapper directory, making the wrapper's own `api-server-config.json` (the API key and every instance's RCON password) listable, readable and writable through the API;
- pre-plant `.mcbot-config-snapshots/<id>` as a symlink to a directory `apiuser` can write. The next config save writes a snapshot there and then deletes all but 10 files in it, which is arbitrary file deletion as `apiuser`;
- plant a "future" snapshot that is a symlink to a wrapper secret. An admin's revert copies it into a file `minecraft` can read.

**Consequence:** escalation from one instance's user to the API key, and with it control of every instance on the host and their sudo users.

**Remediation:**
- Require each root's realpath to be inside `realpath(serverPath)`.
- Open files with `O_NOFOLLOW` and use fd-based `fstat`/`read`/`write`.
- Realpath-check the snapshot directory and its entries.
- Or perform config I/O through `sudo -u linuxUser`, as the scripts already do.

**Confidence:** verified for the missing checks (code read). Exploitation needs code execution as the instance user.

### [MEDIUM] W-008: Gaps in operation exclusion

**Location:**
- `src/platform/spawn.ts:~154-171, ~275-293`: rejects as soon as SIGTERM is sent.
- `src/instances/operationSlot.ts:~68-72`: releases in `finally`.
- `upgrades.ts:~410-418`.
- `routes/instance/backups.ts:~230-248`: restore offline probe runs before the slot is taken.
- `routes/instance/backups.ts:~174-197` and `backupFiles.ts:~225-231`: backup DELETE is not gated by the slot.

**Evidence:**
- **Slot released while the process may still run:** when a timeout fires, the slot is freed while tar, zip or java may still be writing.
  - `apiuser` can signal only sudo, not the `minecraft`-owned grandchildren.
  - With sudo `use_pty` (the default since sudo 1.9.14), the process-group kill may never reach them.
  - A following restore, rollback or start can therefore overlap a still-running backup or restore.
- **Restore probe outside the slot:** a `start` can begin between "server is offline" and the restore taking the slot.
- **Backup DELETE ungated:** it can remove the archive an upgrade or prune job is about to restore from on failure.

**Remediation:**
- Hold the slot until the child's `close` event (or the end of the SIGKILL grace period).
- Take the slot before the offline probe.
- Refuse backup deletes while an upgrade, prune or restore holds the slot, or protect that job's archive.
- Recommend that scripts trap TERM and kill their children.

**Confidence:** code paths verified. The real-world impact depends on the setup suite's own file lock, which I could not inspect.

### [MEDIUM] W-009: Upgrade jobs don't reliably survive a wrapper restart, and their state is misreported afterwards

**Location:** `src/platform/spawn.ts:~249-262` (spawned `detached`, but stdout and stderr are pipes to the wrapper); `src/instances/upgrades.ts:~259-289` (`readStatusFile`).

**Evidence:**
- The code comment claims "a wrapper restart does not kill an upgrade". In practice:
  - after the wrapper exits, the script's next write to the pipe raises SIGPIPE;
  - PM2's tree-kill and systemd's default `KillMode=control-group` kill the group anyway.
- After the restart, the in-memory jobs map and slot are empty:
  - a job that did survive is reported as `failed`/`interrupted` while it is still running, and the slot is open to stop or restart;
  - a job that was killed can leave the server stopped mid-upgrade.
- `src/index.ts` also has no `unhandledRejection`/`uncaughtException` handler, so a missed rejection kills the process mid-job.

**Remediation:** send job output to a file that the wrapper tails rather than a pipe, and detect live jobs from a PID file or the suite's lock instead of from `slot.current()`. Document `KillMode=process` for the systemd unit, or don't claim the job survives.

**Confidence:** strongly supported (traced, not independently re-checked). It depends on the process supervisor.

### [MEDIUM] W-010: Unauthenticated requests grow the per-route metrics map without bound

**Location:** `src/http/app.ts:121` (`req.routeOptions.url ?? req.url`); `src/platform/metrics.ts:~157-203` (map with no eviction).

**Evidence:**
- For unmatched routes the raw URL, query string included, becomes a new key.
- `onResponse` still runs for 401/404 responses, so no API key is needed.
- With the default bind of `0.0.0.0`, anyone who can reach the port can grow the heap with distinct URLs until PM2's `max_memory_restart` triggers a restart loop.
- The reviewer believes the not-found path is not rate-limited. That point was not re-checked.

**Remediation:** use `req.routeOptions.url ?? "<unmatched>"` and cap the size of the map.

**Confidence:** verified for the key derivation (code read). The rate-limit coverage is assumption-dependent.

### [MEDIUM] W-011: Config-file writes are neither atomic nor serialized

**Location:** `configFiles.ts:~392-402` (etag check, then several awaits, then `fsp.writeFile` in place) and `:~438` (revert, with no `If-Match`).

**Evidence:**
- A crash, or a mod reading the file during the truncate-then-write, sees an empty or partial file. Many mods then regenerate defaults, which loses the config.
- Two concurrent PUTs with the same `If-Match` both pass the check, and one change is silently lost.

**Remediation:** a per-file mutex; write a temp file in the same directory, fsync, rename and chown; require `If-Match` on revert.

**Confidence:** verified (code read).

### [MEDIUM] W-012: `api-server-config.json` is not gitignored

**Location:** `.gitignore`. `git check-ignore api-server-config.json` exits 1, so the file is not ignored. `.gitignore` does cover `variables.txt` and `.env`. `config/load.ts:~27` looks for the file in the repo root.

**Evidence:** the README tells operators to create this file in the checkout. It holds the API key and RCON passwords, so a `git add -A`, or pushing a fork with local changes, publishes them.

**Remediation:** add it to `.gitignore`.

**Confidence:** verified.

### [LOW] W-013: `mcVersion` can inject a flag into `upgrade.sh`

**Location:** `src/instances/mods.ts:86` (`MC_VERSION_RE = /^[\w.-]{1,20}$/`); `src/instances/upgrades.ts:185` (passed as the first positional argument with no `--`).

**Evidence:** `{"mcVersion":"--prune-only"}` on `/operations/upgrade` switches the script's mode while the job is recorded as an upgrade. Other flags depend on `upgrade.sh`, which was not inspected.

**Remediation:** require a leading alphanumeric character and pass `--` before the version.

**Confidence:** the injection is verified; its impact is not.

### [LOW] W-014: `scripts/run` arguments may start with `-`

**Location:** `src/http/validation.ts:~14` (`SAFE_ARG`).

**Evidence:** arguments like `--file …` or `--y` reach `rollback.sh`, `start.sh` and `backup.sh`. Whether any flag is dangerous depends on the suite's scripts, which were not inspected.

**Remediation:** a per-action argument allowlist, or reject a leading `-`.

**Confidence:** assumption-dependent.

### [LOW] W-015: The documented sudoers rule gives `apiuser` a full shell as `minecraft`

**Location:** `docs/sudoers-setup.md:~58` (`NOPASSWD: /usr/bin/screen` with any arguments).

**Evidence:** `screen -dm bash -c …` runs arbitrary code as `minecraft`, so any compromise of `apiuser` becomes code execution as `minecraft`. The other rules are narrowly scoped.

**Remediation:** restrict the rule to `screen -S * -X stuff *` and `screen -list`.

**Confidence:** verified (doc read; standard sudo semantics).

### [LOW] W-016: Large prune selections fail because their parameters go through argv

**Location:** `src/instances/prune.ts:~256-257` (`--params=<JSON>`); `routes/instance/prune.ts:~53` (up to 2500 operations).

**Evidence:** about 250 KB of JSON exceeds Linux's 128 KiB limit for a single argument, so the spawn fails and the route returns 500. Scans already send params on stdin.

**Remediation:** use stdin here too.

**Confidence:** strongly supported (traced, not independently re-checked).

### [LOW] W-017: Cache invalidation doesn't cover a load already in flight

**Location:** `src/platform/cache.ts:~66, ~88-90`.

**Evidence:** `invalidate()` clears only the stored entry. A `get()` right afterwards reuses the old in-flight promise, which then caches pre-mutation data as fresh for 60 s. This affects mods after an install or remove, backups after a delete, and stats after a delete.

**Remediation:** add a generation counter and drop stale loads.

**Confidence:** verified (code read).

### [LOW] W-018: Backup download sizes come from a cached index, and there is no ETag/If-Range

**Location:** `backupFiles.ts:~45-46`; `routes/instance/backups.ts:~131-167`.

**Evidence:**
- A size up to 10 minutes stale sets `Content-Length` and the Range math. An archive that was replaced or is still growing yields a silently truncated 200.
- A resumed download can splice two different files together.

**Remediation:** `fstat` the opened file descriptor; emit an ETag built from mtime and size; honour `If-Range`.

**Confidence:** strongly supported.

### [LOW] W-019: Log tail and lifecycle cursor edge cases

**Location:** `src/platform/logStream.ts:~118` and `lifecycleEvents.ts:~305` (rotation detected by size only); `lifecycleEvents.ts:~315-316`.

**Evidence:**
- On polling-only file systems, a rotated file that grows past the old offset before the next poll goes undetected, so lines are lost or garbled.
- One NDJSON line over 256 KB stalls the lifecycle cursor permanently.

**Remediation:** compare inode or birthtime; skip oversized lines.

**Confidence:** strongly supported.

### [LOW] W-020: Synchronous logger I/O on the event loop

**Location:** `src/platform/logger.ts:~96-113` (`existsSync`, `statSync` and `appendFileSync` per line); every 429 is logged (`app.ts:~151,170`).

**Evidence:** under a request flood, the logging itself blocks the event loop.

**Remediation:** use an async append stream, and rate-limit the 429 log lines.

**Confidence:** strongly supported.

### [LOW] W-021: CI/release token scope and supply chain

**Location:**
- `.github/workflows/release.yml:~112-113`: `contents: write` in the same job that runs `npm ci`, lint and test.
- `contract.yml` and `tests.yml`: no `permissions:` block.
- `contract.yml`: builds the bot's `main`, with `persist-credentials` left at its default; `:~81` interpolates `${{ inputs.bot_ref }}` into a shell step.
- Actions are pinned by tag, not SHA.
- Any `v*` tag publishes, with no check that the commit is on `main`.
- `scripts/update-deps.mjs` runs an unpinned `npx npm-check-updates -u` and `npm audit fix`.

**Evidence:**
- Dependency or upstream compromise runs with write scope.
- The `.sha256` file is produced in the same job, so it proves transport integrity, not provenance. The real trust anchor is the setup suite's pin PR.

**Remediation:**
- Default to `contents: read`.
- Move publishing into its own job.
- Set `persist-credentials: false`.
- Pin actions by SHA.
- Verify the tag is on `main`.
- Consider build-provenance attestation.
- Pin the `ncu` version.

**Confidence:** strongly supported.

### [LOW] W-022: Default bind is `0.0.0.0` over plain HTTP

**Location:** `src/index.ts:~22`.

**Evidence:** the API key travels in a header in cleartext. That is acceptable on a trusted LAN, but the README does not call for TLS or a reverse proxy when the bot runs on another host.

**Remediation:** document TLS or proxy deployment, or default to loopback when only a co-located bot is expected.

**Confidence:** verified.

### Informational

- **Small validation gaps:**
  - `control.ts:~98` uses `action in SCRIPT_MAP`, so prototype keys return 500 instead of 400. Use `Object.hasOwn`.
  - A non-string JSON `apiKey` skips the length check and then fails closed with 500 on every request (`load.ts:~79,143`).
  - The instance id is not validated, although it is used as a screen session name and in env-var names.
  - The JSON `port` value is unchecked.
- **Health probe cost:** the fallback probe sleeps 250 ms to sample CPU only to test liveness (`host/index.ts:~131`).
- **Contract is consistent:** wrapper feature names and versions match the bot's `EXPECTED_WRAPPER_FEATURES`; `scriptTimeoutsMs` matches the enforced table; schemas are closed and round-trip tested.
- **Answers to the bot audit's open wrapper questions:**
  - **Mod slugs:** validated strictly in the wrapper (`SLUG_RE` forbids a leading `.` or `-` and `/`). However, bot AUD-024 remains a bot-side defect: the bot's URL normalisation collapses `/mods/..` before the wrapper ever sees a slug.
  - **Prune dimension:** the wrapper's regex also allows `..`, which arrives only inside a single `--dimension=` token. How it is used is up to the suite's script.
  - **Stats-file UUIDs:** strictly validated, with a `path.relative` guard.
  - **Locking:** mostly present (see W-008 for the gaps).
- **Test gaps on high-risk behaviour:**
  - no test aborts a request mid-handler (W-002)
  - the health fake hides W-004
  - no RCON oversize or multi-packet test (W-003)
  - no screen escape test (W-001)
  - no runtime sweep proving every route returns 401 without the key
  - no slot-across-timeout test
  - `tests/http/sse.test.ts:~138` asserts `< 900 ms` on real fs events, which is timing-flaky

## 4. Coverage and limitations

**Inspected adequately:**
- auth, hooks, rate limit and body limits
- config loading
- spawn, exec and sudo argv
- the screen command path
- the RCON packet codec and client
- the operation slot
- config-file editor, backup listing/download/restore/delete
- stats deletion, mod validation, prune and upgrade argv
- health, list and metrics
- contracts
- workflows and `.gitignore`

**Inspected with limits:**
- `logStream`/`lifecycleEvents` (traced by a reviewer)
- `tps.ts` parsing of Paper's `§`-coloured output
- `host/cpu.ts`
- the auth tracker's growth
- `restore.ts` and `prune.ts` in depth
- the rate-limiter's coverage of 404s

**Not inspected:**
- the minecraft-server-setup scripts (`upgrade.sh`, `restore.sh`, `rollback.sh`, `prune-chunks.js`, the mod scripts, and their lock and flag semantics)
- live Minecraft, screen and sudo behaviour

**Checks run (actual outcomes):**

| Check | Outcome |
|---|---|
| `npm ci` | succeeded (in the clone, outside the bot repo) |
| `tsc -p tsconfig.json` | passed |
| `npm run lint` | passed (0 warnings) |
| `vitest run` | 42 files, 643 tests passed |
| `npm audit` | 0 vulnerabilities |
| W-002 Fastify abort reproduction | counter stuck at 5 after 5 aborts (scratch script, deleted) |
| `git check-ignore api-server-config.json` | not ignored |

**Not run:**
- A screen reproduction for W-001 (screen is not installed, and installing tools was not part of the agreed scope).
- A live RCON test for W-003.
- The `openapi:check` and `pack:release` scripts. They build into `dist/`; the drift test already runs inside `npm test`.

**Assumptions that could change conclusions:**
- **W-001** severity assumes the screen path is in use. If every instance runs `useRcon: true` and RCON never errors, exposure drops, but W-003 and W-005 make RCON errors likely.
- **W-007** assumes `apiuser` and `minecraft` are separate users as documented. If the wrapper runs as the instance user, it collapses to a robustness issue.
- **W-008** and **W-009** depend on the setup suite's own locking and on the process supervisor.

## 5. Conclusion

**Priorities**

1. **W-001 together with W-003 and W-005:** close the screen escape injection, make the RCON codec handle real packet sizes, and stop falling back to screen after a command has already been sent. Together these are the path from a Discord chat message to operator access.
2. **W-002:** fix the in-flight counter, which a slow disk or RCON stall alone can trigger.
3. **W-004:** fix the empty `/list`, which silently corrupts the bot's player data.
4. **W-006 and W-007:** harden the file boundaries (redact or lock privileged server settings; contain realpaths and stop following symlinks owned by the instance user).
5. **W-008:** hold the operation slot until processes have actually exited.

**Principal limitations:** the setup-suite scripts that actually perform restore, prune and upgrade were not audited, and the screen-specific finding was not executed in a real screen session.
