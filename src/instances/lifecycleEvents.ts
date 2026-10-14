/**
 * The server's lifecycle events: start.sh appends one JSON object per line to
 * `<server>/logs/lifecycle.ndjson` (JVM started, exited, restart scheduled,
 * crash loop gave up). This reads that file with a byte-offset cursor, so a
 * poller asks "anything since offset N?" and the answer stays correct across
 * wrapper restarts and while the wrapper cannot reach the server at all.
 */
import type { FileHandle } from "fs/promises";
import path from "path";

import type { InstanceConfig } from "../config/types.js";
import { openNoFollow } from "../platform/safeFs.js";
import type { LifecycleEvents } from "../contracts/wire.js";

export const EVENTS_FILE = path.join("logs", "lifecycle.ndjson");
/** At most this much of the file per request. */
export const EVENTS_READ_BYTES = 256 * 1024;
export const EVENTS_MAX_PER_REQUEST = 500;

export function createLifecycleEvents(cfg: InstanceConfig) {
  async function readEvents(since = 0): Promise<LifecycleEvents> {
    const file = path.join(cfg.serverPath, EVENTS_FILE);
    let handle: FileHandle;
    try {
      // The server's user owns this file; a link planted in its place is not followed (W-007).
      handle = await openNoFollow(file);
    } catch {
      return { events: [], next: 0, reset: since > 0 };
    }
    try {
      const { size } = await handle.stat();
      // The file shrank: it was rotated, so the old cursor means nothing.
      const reset = since > size;
      const start = reset ? 0 : since;
      if (start >= size) return { events: [], next: size, reset };

      const length = Math.min(size - start, EVENTS_READ_BYTES);
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, start);

      // Only whole lines count; a half-written last line waits for the next read.
      const lastNewline = buf.lastIndexOf(0x0a);
      if (lastNewline === -1) {
        // W-019: a full window with no newline is one line longer than any
        // event; waiting for its end would stall the cursor forever. Skip
        // past it; the rest of it parses as damaged and is skipped too.
        if (length === EVENTS_READ_BYTES) return { events: [], next: start + length, reset };
        return { events: [], next: start, reset };
      }
      const text = buf.subarray(0, lastNewline + 1).toString("utf8");
      const events: Record<string, unknown>[] = [];
      let consumed = 0;
      for (const line of text.split("\n")) {
        if (events.length >= EVENTS_MAX_PER_REQUEST) break;
        consumed += Buffer.byteLength(line, "utf8") + 1;
        if (!line.trim()) continue;
        try {
          const obj: unknown = JSON.parse(line);
          if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
            events.push(obj as Record<string, unknown>);
          }
        } catch {
          /* a damaged line is skipped, not fatal */
        }
      }
      return { events, next: start + Math.min(consumed, lastNewline + 1), reset };
    } finally {
      await handle.close();
    }
  }

  return { readLifecycleEvents: readEvents };
}
