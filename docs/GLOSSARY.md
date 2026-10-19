# Glossary

Terms specific to this project that are easy to misread.

**Anchor (process anchor).** The process an instance's server hangs under: the `screen -S <instance id>` session, or the unit's systemd main pid. Used to match a java process to its instance when its working directory cannot be read.

**Boot id.** The kernel's identifier for the current boot (`/proc/sys/kernel/random/boot_id`). A job record from another boot names a process that no longer exists, whatever now holds its pid.

**Job record.** The small JSON file `<instance>.upgrade.json` under the job state directory, written when an upgrade or prune job starts. It lets a restarted wrapper recognise the job, keep the instance busy for it and report it as running. It holds the process group id, the boot id, the process start time and the job's output files.

**Process start time.** Field 22 of `/proc/<pid>/stat`, in clock ticks since boot. Together with the boot id it tells the recorded process from an unrelated one that was given the same pid.

**Protected key.** A `server.properties` key (`online-mode`, `enable-rcon`, `level-name` and others) that the config editor changes only when the request carries `allowProtected`.

**Redaction site.** The span of one secret value in a config file (the value of a `password`, `token` or similar key, or the password part of a URL). Redaction replaces each site with a placeholder, and a write restores the original at the same key.

**Slot (operation slot).** The per-instance lock that keeps stop, start, backup, restore, upgrade and prune from overlapping. Held by a running job, including a recovered one.

**Terminator packet.** The empty command the RCON client sends behind a reply packet that is exactly full-size. The server answers in order, so its reply marks the end of a multi-packet reply.
