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
sudo -n -u minecraft bash /opt/minecraft/scripts/survival/backup/backup.sh [args…]
sudo -n -u minecraft bash /opt/minecraft/scripts/survival/misc/status.sh [args…]
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
apiuser ALL=(minecraft) NOPASSWD: /usr/bin/bash /opt/minecraft/scripts/survival/backup/backup.sh *
apiuser ALL=(minecraft) NOPASSWD: /usr/bin/bash /opt/minecraft/scripts/survival/misc/status.sh *
```

Adjust the script paths per instance (one block per `scriptsDir`), and
check `which bash` / `which screen` on your distro — the paths in
sudoers must be absolute and exact.

The trailing `*` permits arguments. The wrapper already allowlists them
hard (≤ 5 strings of `[\w.@-]{1,128}`, no slashes — F-001), so the
sudo-side wildcard does not reopen what the API layer closed. If you
prefer defence in depth over convenience, enumerate exact argument
lists instead.

## Verifying

As the API user:

```bash
sudo -n -u minecraft screen -list && echo OK
sudo -n -u minecraft bash /opt/minecraft/scripts/survival/misc/status.sh && echo OK
```

`sudo: a password is required` means the entry doesn't match — compare
the exact path sudo prints against your sudoers line.

## server-setup deployments

[minecraft-server-setup](https://github.com/your-org/minecraft-server-setup)
writes these entries automatically during provisioning; this document
matters for standalone installations and for auditing what was set up.
