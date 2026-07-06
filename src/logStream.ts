/**
 * Per-instance latest.log tailing fanned out to SSE clients.
 *
 * fs.watch with a 1 s polling fallback (network filesystems, editors that
 * replace instead of append). New bytes are read incrementally from the
 * last offset; rotation (rename / truncation) resets the offset.
 */
import fs from "fs";
import path from "path";
import readline from "readline";
import type { ServerResponse } from "http";
import type { InstanceConfig } from "./types.js";

// A-05: cap how many bytes we read per polling cycle. If the server was
// offline while the api-server restarted (lastSize = 0) and the log is
// hundreds of MB, reading it all at once would spike memory and stall the
// event loop. Missed content is caught up across subsequent cycles.
const MAX_DELTA_BYTES = 1 * 1024 * 1024; // 1 MB per cycle

export interface LogStreamAPI {
  addClient(instanceId: string, res: ServerResponse): void;
  removeClient(instanceId: string, res: ServerResponse): void;
  dispose(): void;
}

export function initLogStream(
  instances: Record<string, InstanceConfig>,
): LogStreamAPI {
  const clientsByInstance = new Map<string, Set<ServerResponse>>();
  const handles: Array<{
    watcher: fs.FSWatcher | null;
    poller: ReturnType<typeof setInterval>;
  }> = [];

  for (const [id, cfg] of Object.entries(instances)) {
    const logFilePath = path.join(cfg.serverPath, "logs", "latest.log");
    const clients = new Set<ServerResponse>();
    const state = { lastSize: 0, reading: false };

    clientsByInstance.set(id, clients);

    // Seed the read offset so we don't replay the entire log on first connect
    try {
      state.lastSize = fs.statSync(logFilePath).size;
    } catch {
      /* log doesn't exist yet — start at 0 */
    }

    const instanceId = id;

    async function processLogChanges(event: string): Promise<void> {
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

        let stat: fs.Stats;
        try {
          stat = fs.statSync(logFilePath);
        } catch {
          return;
        }

        if (stat.size < state.lastSize) state.lastSize = 0;
        if (stat.size === state.lastSize) return;

        // A-05: clamp the read window
        const readEnd = Math.min(stat.size - 1, state.lastSize + MAX_DELTA_BYTES - 1);

        const stream = fs.createReadStream(logFilePath, {
          start: state.lastSize,
          end: readEnd,
        });
        const rl = readline.createInterface({ input: stream });

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
        /* swallow — the next cycle retries */
      } finally {
        state.reading = false;
      }
    }

    // fs.watch with polling fallback
    let watcher: fs.FSWatcher | null = null;
    try {
      watcher = fs.watch(path.dirname(logFilePath), (event, filename) => {
        if (filename === "latest.log") void processLogChanges(event);
      });
      watcher.on("error", () => {});
    } catch {
      /* polling only */
    }

    const poller = setInterval(() => void processLogChanges("change"), 1000);

    handles.push({ watcher, poller });
  }

  function addClient(instanceId: string, res: ServerResponse): void {
    clientsByInstance.get(instanceId)?.add(res);
  }

  function removeClient(instanceId: string, res: ServerResponse): void {
    clientsByInstance.get(instanceId)?.delete(res);
  }

  // A-10: release all watchers and pollers on SIGTERM so a long
  // processLogChanges() iteration doesn't prevent a clean exit.
  function dispose(): void {
    for (const { watcher, poller } of handles) {
      clearInterval(poller);
      if (watcher) watcher.close();
    }
  }

  return { addClient, removeClient, dispose };
}
