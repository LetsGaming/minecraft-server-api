"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");

// A-05: cap how many bytes we read per polling cycle. If the server was
// offline while the api-server restarted (lastSize = 0) and the log is
// hundreds of MB, reading it all at once would spike memory and stall the
// event loop. Missed content is caught up across subsequent cycles.
const MAX_DELTA_BYTES = 1 * 1024 * 1024; // 1 MB per cycle

/**
 * Initialise log-stream watchers for all configured instances.
 *
 * @param {Record<string, { id: string, serverPath: string }>} instances
 * @returns {{
 *   addClient(instanceId: string, res: any): void,
 *   removeClient(instanceId: string, res: any): void,
 *   dispose(): void
 * }}
 */
function init(instances) {
  // Per-instance SSE client sets
  const clientsByInstance = new Map(); // instanceId → Set<res>

  // Per-instance read state
  const stateByInstance = new Map(); // instanceId → { lastSize, reading }

  // All watcher/poller handles for clean shutdown (A-10)
  const handles = [];

  for (const [id, cfg] of Object.entries(instances)) {
    const logFile = path.join(cfg.serverPath, "logs", "latest.log");
    const clients = new Set();
    const state   = { lastSize: 0, reading: false };

    clientsByInstance.set(id, clients);
    stateByInstance.set(id, state);

    // Seed the read offset so we don't replay the entire log on first connect
    try {
      state.lastSize = fs.statSync(logFile).size;
    } catch {
      /* log doesn't exist yet — start at 0 */
    }

    // Capture id and logFile by value for this iteration's closure
    const instanceId  = id;
    const logFilePath = logFile;

    async function processLogChanges(event) {
      if (state.reading) return;
      state.reading = true;
      try {
        if (event === "rename") {
          try {
            fs.accessSync(logFilePath);
            state.lastSize = 0;
          } catch {
            return;
          }
        }

        let stat;
        try {
          stat = fs.statSync(logFilePath);
        } catch {
          return;
        }

        if (stat.size < state.lastSize) state.lastSize = 0;
        if (stat.size === state.lastSize) return;

        // A-05: clamp the read window
        const readEnd = Math.min(stat.size - 1, state.lastSize + MAX_DELTA_BYTES - 1);

        const stream = fs.createReadStream(logFilePath, { start: state.lastSize, end: readEnd });
        const rl     = readline.createInterface({ input: stream });

        for await (const line of rl) {
          const payload = `data: ${JSON.stringify({ line, serverId: instanceId })}\n\n`;
          for (const res of [...clients]) {
            try {
              res.write(payload);
            } catch {
              clients.delete(res);
            }
          }
        }

        state.lastSize = readEnd + 1;
      } catch {
        /* swallow */
      } finally {
        state.reading = false;
      }
    }

    // fs.watch with polling fallback
    let watcher = null;
    try {
      watcher = fs.watch(path.dirname(logFilePath), (event, filename) => {
        if (filename === "latest.log") processLogChanges(event).catch(() => {});
      });
      watcher.on("error", () => {});
    } catch {
      /* polling only */
    }

    const poller = setInterval(
      () => processLogChanges("change").catch(() => {}),
      1000,
    );

    handles.push({ watcher, poller });
  }

  function addClient(instanceId, res) {
    clientsByInstance.get(instanceId)?.add(res);
  }

  function removeClient(instanceId, res) {
    clientsByInstance.get(instanceId)?.delete(res);
  }

  // A-10: release all watchers and pollers on SIGTERM
  function dispose() {
    for (const { watcher, poller } of handles) {
      clearInterval(poller);
      if (watcher) watcher.close();
    }
  }

  return { addClient, removeClient, dispose };
}

module.exports = { init };
