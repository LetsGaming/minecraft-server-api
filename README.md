# mc-api-server

Lightweight HTTP wrapper for a Minecraft server instance. Exposes server operations — start/stop/restart, RCON commands, stats, logs, whitelist, backups — over a simple REST API secured with an API key.

Intended as the backend for [minecraft-bot](https://github.com/your-org/minecraft-bot), but usable from any HTTP client.

---

## Prerequisites

- **Node.js 18+**
- **PM2** (production): `npm install -g pm2`
- **`sudo` configured** — see [Sudoers Setup](#sudoers-setup) below
- **GNU `screen`** — for the screen-based command fallback

---

## Deployment

### Standalone (manual install)

```bash
git clone <repo-url> mc-api-server
cd mc-api-server
npm install --omit=dev
```

Configure via environment variables or a `variables.txt` file — see [Configuration](#configuration).

```bash
# Start directly
node index.js

# Start with PM2 (recommended for production)
pm2 start ecosystem.config.cjs --env production
pm2 save
pm2 startup   # run the printed command as root to enable autostart
```

### Via minecraft-server-setup

When setting up a Minecraft server with [minecraft-server-setup](https://github.com/your-org/minecraft-server-setup), enable the API server in `variables.json`:

```json
"API_SERVER": {
  "ENABLED": true,
  "PORT": 3000,
  "API_KEY": "replace-with-a-long-random-secret"
}
```

The setup script clones this repo, installs dependencies, and creates a systemd service automatically.

---

## Configuration

Configuration is loaded in this priority order:

1. **Environment variables** — recommended for standalone deployments
2. **`variables.txt`** — used by server-setup managed deployments

### Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `SERVER_PATH` | **Yes** | — | Absolute path to the Minecraft server directory |
| `INSTANCE_NAME` | **Yes** | `server` | Screen session name and PM2 process identifier |
| `API_SERVER_PORT` | No | `3000` | Port to listen on |
| `API_SERVER_KEY` | No | *(none)* | API key for authenticated routes. Empty = auth disabled |
| `LINUX_USER` | No | `minecraft` | Linux user that owns the Minecraft process |
| `USE_RCON` | No | `false` | Set to `true` to use RCON |
| `RCON_HOST` | No | `localhost` | RCON host |
| `RCON_PORT` | No | `25575` | RCON port |
| `RCON_PASSWORD` | No | *(none)* | RCON password |
| `BACKUPS_PATH` | No | *(none)* | Path to backups root (for `/backups` endpoint) |
| `SCRIPTS_DIR` | No | *parent of repo root* | Directory containing `start.sh`, `shutdown.sh`, etc. |
| `VARIABLES_TXT_PATH` | No | `../common/variables.txt` | Path to a `variables.txt` file (overrides the default search path) |

> **Note:** `LINUX_USER` is the env var name. In `variables.txt` the same setting is written as `USER="minecraft"` — using `LINUX_USER` as an env var avoids colliding with the shell's built-in `$USER`.

### variables.txt

As an alternative to env vars, put your config in `variables.txt`. See [`variables.example.txt`](./variables.example.txt) for all available keys.

The server finds this file by searching (in order):
1. `VARIABLES_TXT_PATH` env var, if set
2. `../common/variables.txt` relative to the repo root *(default, matches server-setup layout)*

For standalone deployments, the simplest option is setting env vars. If you prefer a file, copy `variables.example.txt` to `variables.txt` in the repo root and set `VARIABLES_TXT_PATH=./variables.txt`.

---

## Sudoers Setup

Script and screen commands run as `LINUX_USER` via `sudo -n` (passwordless sudo). Without this, `/instances/:id/scripts/run` and screen-based commands will fail.

Add a sudoers entry for the user running the API server. Example for a server setup where the API runs as `<your-user>` and MC runs as `minecraft`:

```
<your-user> ALL=(minecraft) NOPASSWD: /usr/bin/screen, /usr/bin/bash /opt/minecraft/survival/start.sh, ...
```

See your server-setup docs or `docs/sudoers-setup.md` for the full required configuration.

---

## Running Tests

```bash
npm test
```

Uses Node's built-in test runner — no extra dependencies.

---

## API Reference

All routes except `GET /health` require the `x-api-key` header matching `API_SERVER_KEY`.

### Health

#### `GET /health`
Returns `{ "ok": true }`. No authentication required.

### Instance Routes

All prefixed with `/instances/:id` where `:id` must match `INSTANCE_NAME`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/instances/:id/running` | Is the server process alive? |
| `GET` | `/instances/:id/list` | Online player count and names |
| `GET` | `/instances/:id/tps` | TPS data (requires RCON) |
| `GET` | `/instances/:id/level-name` | World name from `server.properties` |
| `GET` | `/instances/:id/whitelist` | Whitelist entries |
| `GET` | `/instances/:id/mods` | Mod slugs from `downloaded_versions.json` |
| `GET` | `/instances/:id/backups` | Backup metadata |
| `GET` | `/instances/:id/logs/tail?lines=N` | Last N lines of `latest.log` (1–500) |
| `GET` | `/instances/:id/logs/stream` | Server-Sent Events stream of new log lines |
| `GET` | `/instances/:id/stats` | Player UUIDs with stats files |
| `GET` | `/instances/:id/stats/:uuid` | Stats JSON for a specific player |
| `POST` | `/instances/:id/command` | Send a command via RCON or screen |
| `POST` | `/instances/:id/scripts/run` | Run a management script (`start`, `stop`, `restart`, `backup`, `status`) |

---

## Troubleshooting

**`SERVER_PATH is required`** — set the `SERVER_PATH` env var or provide a `variables.txt` file.

**`variables.txt not found`** — set `VARIABLES_TXT_PATH` to the correct path, or create `variables.txt` at `../common/variables.txt` relative to the repo root.

**`RCON auth failed`** — check that `RCON_PASSWORD` matches `rcon.password` in `server.properties` and that `enable-rcon=true` is set there.

**`Script not found`** — the default `SCRIPTS_DIR` is the parent of the repo root. Set the `SCRIPTS_DIR` env var to point to your management scripts.

**`Sudo not configured`** — follow the sudoers setup section above.

**Log stream disconnects** — heartbeats are sent every 20 seconds. If your proxy has a shorter idle timeout, configure it to pass SSE connections through.
