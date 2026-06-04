"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const { SERVER_PATH, INSTANCE_NAME } = require("./config");

const LOG_FILE = path.join(SERVER_PATH, "logs", "latest.log");

// A-05: cap how many bytes we read per polling cycle. If the server was
// offline while the bot restarted (logLastSize = 0) and the log file is
// hundreds of MB, reading it all at once would spike memory and stall the
// event loop. Missed content is caught up on the next cycle(s).
const MAX_DELTA_BYTES = 1 * 1024 * 1024; // 1 MB per cycle

const sseClients = new Set();
let logLastSize = 0;
let logReading = false;

async function processLogChanges(event) {
  if (logReading) return;
  logReading = true;
  try {
    if (event === "rename") {
      try {
        fs.accessSync(LOG_FILE);
        logLastSize = 0;
      } catch {
        return;
      }
    }

    let stat;
    try {
      stat = fs.statSync(LOG_FILE);
    } catch {
      return;
    }

    if (stat.size < logLastSize) logLastSize = 0;
    if (stat.size === logLastSize) return;

    // A-05: clamp the read window to MAX_DELTA_BYTES per cycle
    const readEnd = Math.min(stat.size - 1, logLastSize + MAX_DELTA_BYTES - 1);

    const stream = fs.createReadStream(LOG_FILE, {
      start: logLastSize,
      end: readEnd,
    });
    const rl = readline.createInterface({ input: stream });

    for await (const line of rl) {
      const payload = `data: ${JSON.stringify({ line, serverId: INSTANCE_NAME })}\n\n`;
      for (const res of [...sseClients]) {
        try {
          res.write(payload);
        } catch {
          sseClients.delete(res);
        }
      }
    }

    // Advance only as far as we actually read
    logLastSize = readEnd + 1;
  } catch {
    /* swallow */
  } finally {
    logReading = false;
  }
}

function addClient(res) {
  sseClients.add(res);
}

function removeClient(res) {
  sseClients.delete(res);
}

// A-10: init() returns the watcher and poller handles so the caller can
// perform a clean shutdown (close watcher, clear interval) on SIGTERM.
function init() {
  // Seed offset so we don't replay the whole log on first connect
  try {
    logLastSize = fs.statSync(LOG_FILE).size;
  } catch {
    logLastSize = 0;
  }

  // fs.watch with polling fallback
  let watcher = null;
  try {
    watcher = fs.watch(path.dirname(LOG_FILE), (event, filename) => {
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

  return { watcher, poller };
}

module.exports = { init, addClient, removeClient };
