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

The version upgrade, chunk prune and health routes add three more shapes:

```
sudo -n -u minecraft bash /opt/minecraft/scripts/survival/update/upgrade.sh <mcVersion> [--prune-plan=<id>] [--expect-unavailable=<slugs>] [--countdown=<seconds>]
sudo -n -u minecraft bash /opt/minecraft/scripts/survival/update/upgrade.sh --prune-only --prune-plan=<id> [--countdown=<seconds>]
sudo -n -u minecraft node /opt/minecraft/scripts/survival/world/prune-chunks.js <--scan | --settings=get|set | --dimensions | --status | --inspect … | --tile …>
sudo -n systemctl show <instanceId>.service -p NRestarts,ActiveState --value
sudo -n systemctl show <instanceId>.service -p MainPID --value
```

The two `systemctl show` lines run as root (no `-u`), are read-only, and are
best effort: without the grant the wrapper simply reports no restart count
and falls back to the other liveness probes.

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

Those are all of the wrapper's sudo calls. Host metrics (`/info`) use plain
`ps` and `df`, which need no privileges.

A job started with a time limit (upgrade, prune, restore, scripts) is stopped
at the limit by signalling the process group of the `sudo` process the
wrapper started. `sudo` passes signals on to the command it runs, but whether
a script running as another user receives them depends on the `sudo` version
and its `use_pty` setting; this has not been verified against every
configuration. The wrapper logs a warning when the group is still alive after
SIGKILL, and releases the instance's busy slot after a short grace period
either way, so an operator should check for a leftover process in that case.

## Entries

Create a drop-in as root — always through `visudo` so a syntax error
cannot lock you out:

```bash
sudo visudo -f /etc/sudoers.d/mc-api-server
```

With the API server running as `apiuser` and Minecraft as `minecraft`:

```
# mc-api-server → minecraft: screen control + management scripts
apiuser ALL=(minecraft) NOPASSWD: /usr/bin/screen -S survival -X stuff *
apiuser ALL=(minecraft) NOPASSWD: /usr/bin/screen -list
apiuser ALL=(minecraft) NOPASSWD: /usr/bin/bash /opt/minecraft/scripts/survival/start.sh *
apiuser ALL=(minecraft) NOPASSWD: /usr/bin/bash /opt/minecraft/scripts/survival/shutdown.sh *
apiuser ALL=(minecraft) NOPASSWD: /usr/bin/bash /opt/minecraft/scripts/survival/smart_restart.sh *
apiuser ALL=(minecraft) NOPASSWD: /usr/bin/bash /opt/minecraft/scripts/survival/rollback.sh *
apiuser ALL=(minecraft) NOPASSWD: /usr/bin/bash /opt/minecraft/scripts/survival/backup/backup.sh *
apiuser ALL=(minecraft) NOPASSWD: /usr/bin/bash /opt/minecraft/scripts/survival/misc/status.sh *
# Restore: exactly the arguments the wrapper passes, with the archive under the backups folder.
apiuser ALL=(minecraft) NOPASSWD: /usr/bin/bash /opt/minecraft/scripts/survival/backup/restore.sh --file /opt/minecraft/backups/survival/* --y
# Version upgrade and chunk prune (only for the routes that start them).
apiuser ALL=(minecraft) NOPASSWD: /usr/bin/bash /opt/minecraft/scripts/survival/update/upgrade.sh *
apiuser ALL=(minecraft) NOPASSWD: /usr/bin/node /opt/minecraft/scripts/survival/world/prune-chunks.js *
# Read-only unit state for the health probe, as root, for this instance's unit only.
apiuser ALL=(root) NOPASSWD: /usr/bin/systemctl show survival.service *
```

The two `screen` rules are deliberately narrow. A bare `/usr/bin/screen`
grant lets the API user run `screen -dm bash -c …`, which is a full shell as
`minecraft`. Name the session literally, one `stuff` line per instance id: a
sudoers `*` also matches spaces, so `screen -S * -X stuff *` would still
match `screen -S x -dm bash -c … -X stuff y`.

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
chose, so the rule above names `--file` and `--y` literally and confines the
archive to the backups folder. A sudoers `*` in arguments still matches `/`
and spaces, so the rule alone does not stop `..`; the restore script refuses
an archive outside the backups folder, and the rule keeps every other flag
out. If you prefer defence in depth over convenience, enumerate exact argument
lists instead.

## Verifying

As the API user:

```bash
sudo -n -u minecraft screen -list && echo OK
sudo -n -u minecraft bash /opt/minecraft/scripts/survival/misc/status.sh && echo OK
sudo -n -u minecraft node /opt/minecraft/scripts/survival/update/check-updates.js --json -- && echo OK
sudo -n systemctl show survival.service -p ActiveState --value
```

`sudo: a password is required` means the entry doesn't match — compare
the exact path sudo prints against your sudoers line.

## server-setup deployments

[minecraft-server-setup](https://github.com/LetsGaming/minecraft-server-setup)
does not write these entries for you. Its own `docs/sudoers-setup.md` has the
sudoers file for a setup-suite install (systemctl rules plus the script and
`node` grants); this document explains what the wrapper itself executes and
matters for standalone installations and for auditing what was set up.
