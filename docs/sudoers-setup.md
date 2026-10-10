# Sudoers setup

Script actions (`POST /instances/:id/scripts/run`) and the screen-based
command fallback run as the instance's `linuxUser` via `sudo -n`
(non-interactive, passwordless). Without matching sudoers entries those
calls fail with `Sudo not configured`.

## What the wrapper executes

For an instance with `linuxUser: "minecraft"` and
`scriptsDir: "/opt/minecraft/scripts/survival"`, the wrapper runs
exactly these command shapes:

```
sudo -n -u minecraft screen -S <instanceId> -X stuff '<command>\r'
sudo -n -u minecraft screen -list
sudo -n -u minecraft bash /opt/minecraft/scripts/survival/start.sh [args…]
sudo -n -u minecraft bash /opt/minecraft/scripts/survival/shutdown.sh [args…]
sudo -n -u minecraft bash /opt/minecraft/scripts/survival/smart_restart.sh [args…]
sudo -n -u minecraft bash /opt/minecraft/scripts/survival/rollback.sh [args…]
sudo -n -u minecraft bash /opt/minecraft/scripts/survival/backup/backup.sh [args…]
sudo -n -u minecraft bash /opt/minecraft/scripts/survival/misc/status.sh [args…]
sudo -n -u minecraft bash /opt/minecraft/scripts/survival/backup/restore.sh --file <archive> --y
```

The last line is the backup restore route. It is not a `scripts/run`
action: the archive path is one the wrapper resolved from its own backup
listing, never one a client sent.

Mod operations (the `/mods` routes) run the setup suite's Node scripts as
the same user:

```
sudo -n -u minecraft node /opt/minecraft/scripts/survival/update/add-mod.js [flags] --json -- <slug>
sudo -n -u minecraft node /opt/minecraft/scripts/survival/update/remove-mod.js --json -- <slug>
sudo -n -u minecraft node /opt/minecraft/scripts/survival/update/update-mod.js --json -- <slug>
sudo -n -u minecraft node /opt/minecraft/scripts/survival/update/update-mods.js [flags] --json --
sudo -n -u minecraft node /opt/minecraft/scripts/survival/update/check-updates.js [flags] --json --
sudo -n -u minecraft node /opt/minecraft/scripts/survival/update/toggle-mod.js --disable|--enable --json -- <slug>
```

Nothing else goes through sudo. Host metrics (`/info`) use plain `ps`
and `df`, which need no privileges.

## Entries

Create a drop-in as root — always through `visudo` so a syntax error
cannot lock you out:

```bash
sudo visudo -f /etc/sudoers.d/mc-api-server
```

With the API server running as `apiuser` and Minecraft as `minecraft`:

```
# mc-api-server → minecraft: screen control + management scripts
apiuser ALL=(minecraft) NOPASSWD: /usr/bin/screen
apiuser ALL=(minecraft) NOPASSWD: /usr/bin/bash /opt/minecraft/scripts/survival/start.sh *
apiuser ALL=(minecraft) NOPASSWD: /usr/bin/bash /opt/minecraft/scripts/survival/shutdown.sh *
apiuser ALL=(minecraft) NOPASSWD: /usr/bin/bash /opt/minecraft/scripts/survival/smart_restart.sh *
apiuser ALL=(minecraft) NOPASSWD: /usr/bin/bash /opt/minecraft/scripts/survival/rollback.sh *
apiuser ALL=(minecraft) NOPASSWD: /usr/bin/bash /opt/minecraft/scripts/survival/backup/backup.sh *
apiuser ALL=(minecraft) NOPASSWD: /usr/bin/bash /opt/minecraft/scripts/survival/backup/restore.sh *
apiuser ALL=(minecraft) NOPASSWD: /usr/bin/bash /opt/minecraft/scripts/survival/misc/status.sh *
```

Mod operations need a separate `node` grant. Without it install, remove,
update, enable and disable all fail with a generic `sudo` error:

```
apiuser ALL=(minecraft) NOPASSWD: /usr/bin/node /opt/minecraft/scripts/survival/update/add-mod.js *
apiuser ALL=(minecraft) NOPASSWD: /usr/bin/node /opt/minecraft/scripts/survival/update/remove-mod.js *
apiuser ALL=(minecraft) NOPASSWD: /usr/bin/node /opt/minecraft/scripts/survival/update/update-mod.js *
apiuser ALL=(minecraft) NOPASSWD: /usr/bin/node /opt/minecraft/scripts/survival/update/update-mods.js *
apiuser ALL=(minecraft) NOPASSWD: /usr/bin/node /opt/minecraft/scripts/survival/update/check-updates.js *
apiuser ALL=(minecraft) NOPASSWD: /usr/bin/node /opt/minecraft/scripts/survival/update/toggle-mod.js *
```

### Absolute interpreter paths

The wrapper starts `bash` and `node` by name unless told otherwise, and
`sudo` resolves the name through its `secure_path`. A node installed per
user (nvm, volta) is not on that path, and a name that resolves to a
different binary than the one in your rule is a denied command. Set
`MC_BASH_PATH` and `MC_NODE_PATH` in the wrapper's environment to the
absolute paths (`command -v bash node`) and use those same paths in the
rules above. A value that is not an absolute path stops startup.

Adjust the script paths per instance (one block per `scriptsDir`), and
check `which bash` / `which screen` on your distro — the paths in
sudoers must be absolute and exact.

The trailing `*` permits arguments. The wrapper already allowlists them
hard (at most 5 strings of `[\w.@-]{1,128}`, no slashes), so the
sudo-side wildcard does not reopen what the API layer closed. The restore
rule is the exception: its `--file` argument is an absolute path the wrapper
chose, so keep that rule on the exact `restore.sh` path. If you
prefer defence in depth over convenience, enumerate exact argument
lists instead.

## Verifying

As the API user:

```bash
sudo -n -u minecraft screen -list && echo OK
sudo -n -u minecraft bash /opt/minecraft/scripts/survival/misc/status.sh && echo OK
sudo -n -u minecraft node /opt/minecraft/scripts/survival/update/check-updates.js --json -- && echo OK
```

`sudo: a password is required` means the entry doesn't match — compare
the exact path sudo prints against your sudoers line.

## server-setup deployments

[minecraft-server-setup](https://github.com/LetsGaming/minecraft-server-setup)
writes these entries automatically during provisioning; this document
matters for standalone installations and for auditing what was set up.
