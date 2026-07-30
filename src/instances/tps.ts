/**
 * Tick-rate reads, Paper first with a vanilla `tick query` fallback.
 */
import { cached } from "../platform/cache.js";
import type { RconClient } from "../platform/rcon/client.js";
import type { Tps } from "../contracts/wire.js";

// TPS moves slowly and costs an RCON round-trip against the very thread that
// is struggling when anyone bothers to ask. Two callers a second apart share
// one measurement; a loaded server serves the last one rather than queueing.
const TPS_FRESH_MS = 5_000;
const TPS_STALE_MS = 30_000;

export function createTps(rcon: RconClient | null) {
async function loadTps(): Promise<Tps> {
  if (!rcon) return null;

  // Try Paper-style /tps first
  try {
    const r = await rcon.send("tps");
    if (!r.toLowerCase().includes("unknown")) {
      const m =
        /:\s*\*?([\d.]+),\s*\*?([\d.]+),\s*\*?([\d.]+)/.exec(r) ??
        /^\s*\*?([\d.]+),\s*\*?([\d.]+),\s*\*?([\d.]+)/m.exec(r);
      if (m) {
        return {
          type: "paper",
          tps1m: parseFloat(m[1]!),
          tps5m: parseFloat(m[2]!),
          tps15m: parseFloat(m[3]!),
          raw: r,
        };
      }
    }
  } catch {
    /* try vanilla */
  }

  // Vanilla /tick query fallback
  try {
    const r = await rcon.send("tick query");
    if (r.toLowerCase().includes("unknown")) return null;
    const msptMatch = /Average time per tick:\s*([\d.]+)\s*ms/i.exec(r);
    if (!msptMatch) return null;
    const mspt = parseFloat(msptMatch[1]!);
    const result: Tps = {
      type: "vanilla",
      tps1m: Math.min(20, 1000 / mspt),
      mspt,
      raw: r,
    };
    const p50 = /P50:\s*([\d.]+)\s*ms/i.exec(r);
    const p95 = /P95:\s*([\d.]+)\s*ms/i.exec(r);
    const p99 = /P99:\s*([\d.]+)\s*ms/i.exec(r);
    if (p50?.[1]) result.p50 = parseFloat(p50[1]);
    if (p95?.[1]) result.p95 = parseFloat(p95[1]);
    if (p99?.[1]) result.p99 = parseFloat(p99[1]);
    return result;
  } catch {
    return null;
  }
}

  const tpsCache = cached(loadTps, {
    freshMs: TPS_FRESH_MS,
    staleMs: TPS_STALE_MS,
  });

async function getTps(): Promise<Tps> {
  return (await tpsCache.get()).value;
}

  return { getTps };
}
