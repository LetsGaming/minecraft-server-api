# mc-api-server

Lightweight HTTP wrapper for managing Minecraft server instances — start/stop/restart, console commands, stats, logs (including a live SSE stream), whitelist, backups, host metrics — over a REST API secured with an API key.

Intended as the remote backend for [minecraft-bot](https://github.com/LetsGaming/minecraft-bot) (one wrapper per host, any number of instances), but usable from any HTTP client. The full API is specified in [`openapi.yaml`](./openapi.yaml).

---

## Prerequisites

- **Node.js 20+**
- **PM2** (production): `npm install -g pm2`
- **`sudo` configured** — see [docs/sudoers-setup.md](./docs/sudoers-setup.md)
- **GNU `screen`** — for the screen-based command fallback (RCON-less instances)

---

## Deployment

### Standalone

```bash
git clone <repo-url> mc-api-server
cd mc-api-server
npm ci
npm run build
```

Configure via `api-server-config.json` — see [Configuration](#configuration). Then:

```bash
# Start directly (the root index.js is a shim into dist/)
node index.js

# Or with PM2 (recommended for production)
pm2 start ecosystem.config.cjs --env production
pm2 save
pm2 startup   # run the printed command as root to enable autostart
```

> **Upgrading from 2.x:** the code is TypeScript now, so `npm ci && npm run build` is required after every pull. Everything else is unchanged — same config files, same `node index.js`, same PM2 ecosystem, same systemd units. The API is a superset of 2.x.

### Via minecraft-server-setup

When setting up a server with [minecraft-server-setup](https://github.com/your-org/minecraft-server-setup), enable the API server in `variables.json`:

```json
"API_SERVER": {
  "ENABLED": true,
  "PORT": 3000,
  "API_KEY": "replace-with-a-long-random-secret"
}
```

The setup script clones this repo, installs dependencies, builds, and creates a systemd service automatically.

---

## Configuration

Configuration is loaded in this priority order:

1. **`api-server-config.json`** — multi-instance mode, the preferred format
2. **`variables.txt`** — single-instance fallback for server-setup managed deployments
3. **Environment variables only** — single-instance, `SERVER_PATH` must be set

Environment variables override file values afterwards in every mode.

### api-server-config.json (preferred)

One wrapper process serves any number of instances. Copy [`api-server-config.example.json`](./api-server-config.example.json) and adjust:

```json
{
  "port": 3000,
  "apiKey": "replace-with-a-long-random-secret",
  "instances": {
    "survival": {
      "serverPath":   "/home/minecraft/minecraft-server/survival",
      "scriptsDir":   "/home/minecraft/minecraft-server/scripts/survival",
      "linuxUser":    "minecraft",
      "useRcon":      true,
      "rconHost":     "localhost",
      "rconPort":     25575,
      "rconPassword": "your-rcon-password",
      "backupsPath":  "/home/minecraft/backups/survival"
    }
  }
}
```

Per instance, only `serverPath` is required. `scriptsDir` defaults to the parent of the repo root (the server-setup layout); `linuxUser` defaults to `minecraft`.

The file is looked up at `./api-server-config.json` next to `index.js`, or wherever the `CONFIG_FILE` env var points.

### Environment variables

| Variable | Applies to | Description |
|---|---|---|
| `CONFIG_FILE` | both modes | Path to `api-server-config.json` |
| `MC_API_KEY` | both modes | Overrides the API key (Docker/K8s secret injection) |
| `MC_PORT` | both modes | Overrides the HTTP listen port |
| `RCON_PASSWORD_<ID>` | both modes | Per-instance RCON password override, e.g. `RCON_PASSWORD_SURVIVAL` |
| `MC_BIND_HOST` | both modes | Listen address (default `0.0.0.0`) |
| `MC_ALLOW_NO_AUTH` | both modes | `true` = keyless **loopback-only** dev mode; see [Security](#security) |
| `MC_DEBUG` | both modes | `true` = debug log lines |
| `SERVER_PATH` | fallback mode | **Required** — absolute path to the Minecraft server directory |
| `INSTANCE_NAME` | fallback mode | Instance id / screen session name (default `server`) |
| `API_SERVER_PORT` | fallback mode | Port (default `3000`) |
| `API_SERVER_KEY` | fallback mode | API key |
| `LINUX_USER` | fallback mode | Linux user owning the Minecraft process (default `minecraft`) |
| `USE_RCON` / `RCON_HOST` / `RCON_PORT` / `RCON_PASSWORD` | fallback mode | RCON settings |
| `BACKUPS_PATH` | fallback mode | Backups root for `/backups` |
| `SCRIPTS_DIR` | fallback mode | Management scripts directory |
| `VARIABLES_TXT_PATH` | fallback mode | Path to a `variables.txt` (default search: `../common/variables.txt`) |

> **Note:** `LINUX_USER` is the env var name; in `variables.txt` the same setting is written `USER="minecraft"` — using `LINUX_USER` as an env var avoids colliding with the shell's built-in `$USER`.

### variables.txt (single-instance fallback)

See [`variables.example.txt`](./variables.example.txt) for all keys. The file is found via `VARIABLES_TXT_PATH`, or at `../common/variables.txt` relative to the repo root (the server-setup layout).

---

## Security

- **The wrapper refuses to start without an API key** (it can start/stop servers and run arbitrary console commands — keyless would mean unauthenticated remote control). For a local dev instance, `MC_ALLOW_NO_AUTH=true` disables auth **and forces binding to 127.0.0.1**.
- API-key comparison is constant-time; failed authentications are limited to 20 per IP per 15 minutes on top of the global limit of 300 requests per 15 minutes.
- Request bodies are capped at 4 KB; script arguments and stats UUIDs go through strict allowlists; console commands are stripped of control characters before reaching `screen`.

---

## API Reference

All routes except `GET /health` require the `x-api-key` header. Error bodies are always `{ "error": "<message>" }`. Full schemas: [`openapi.yaml`](./openapi.yaml).

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness + wrapper version (public) |
| `GET` | `/instances` | Configured instance ids |
| `GET` | `/instances/:id/info` | **Wrapper version + host metrics** (server process RAM/CPU, disk usage) — the bot's startup handshake |
| `GET` | `/instances/:id/running` | Is the server process alive? |
| `GET` | `/instances/:id/list` | Online player count and names |
| `GET` | `/instances/:id/tps` | TPS data (requires RCON) |
| `GET` | `/instances/:id/level-name` | World name from `server.properties` |
| `GET` | `/instances/:id/whitelist` | Whitelist entries |
| `GET` | `/instances/:id/usercache` | **usercache.json** — every player the server has seen, filtered to `{name, uuid}` |
| `GET` | `/instances/:id/mods` | Mod slugs from `downloaded_versions.json` (404 without a manifest) |
| `GET` | `/instances/:id/backups` | Backup tier metadata |
| `GET` | `/instances/:id/capabilities` | Which setup-suite artifacts exist |
| `GET` | `/instances/:id/logs/tail?lines=N` | Last N lines of `latest.log` (1–500) |
| `GET` | `/instances/:id/logs/stream` | SSE stream of new log lines |
| `GET` | `/instances/:id/stats` | Player UUIDs with stats files |
| `GET` | `/instances/:id/stats/:uuid` | Stats JSON for one player |
| `DELETE` | `/instances/:id/stats/:uuid` | Delete a player's stats file (bot `/server prune-stats`) |
| `POST` | `/instances/:id/command` | Send a console command (RCON, screen fallback) |
| `POST` | `/instances/:id/scripts/run` | Run a management script (`start`, `stop`, `restart`, `backup`, `status`) |

### Compatibility with minecraft-bot

The bot expects wrapper ≥ 1.2.0 for `/info` (version handshake, remote host metrics, disk alerts) and uses `/usercache` when available — both ship here. Older bots keep working: every 2.x route is unchanged.

---

## Development

```bash
npm ci
npm run build       # tsc → dist/
npm run typecheck   # src + tests, no emit
npm run lint
npm test            # vitest
```

The test suite pins the security invariants (auth semantics, UUID/args allowlists, path-traversal guards, RCON packet validation, the screen-command sanitiser) and exercises every route against a scaffolded instance directory, including the SSE stream over a real socket.

---

## Troubleshooting

**`SERVER_PATH is required`** — no `api-server-config.json` was found and the fallback mode has no server path. Provide the JSON config, or set `SERVER_PATH`.

**`FATAL: no API key configured`** — set `apiKey` in the config file, or `MC_API_KEY`. For a loopback-only dev instance: `MC_ALLOW_NO_AUTH=true`.

**`RCON auth failed`** — check that the password matches `rcon.password` in `server.properties` and that `enable-rcon=true`.

**`Script not found`** — set `scriptsDir` for the instance (default: parent of the repo root).

**`Sudo not configured`** — see [docs/sudoers-setup.md](./docs/sudoers-setup.md).

**Log stream disconnects** — heartbeats go out every 20 s. If a proxy sits in between, allow SSE pass-through and idle timeouts above 20 s.
