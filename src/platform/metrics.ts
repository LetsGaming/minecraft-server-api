/**
 * In-process counters for GET /metrics.
 *
 * There was no way to answer "what was happening right before the wrapper
 * went unreachable" — no request log, no in-flight count, nothing. This is
 * deliberately plain (a few Maps, no dependency): the point is a cheap,
 * always-on signal, not a full metrics stack for a single-process wrapper.
 *
 * Percentiles are computed from a bounded ring buffer per route rather than
 * kept exactly, since an unbounded per-route array would itself become a
 * memory-growth bug in the thing meant to diagnose memory growth.
 */
import { monitorEventLoopDelay } from "perf_hooks";

const SAMPLE_SIZE = 200;

interface RouteMetric {
  count: number;
  errorCount: number;
  timeoutCount: number;
  samples: number[];
  /** Ring buffer write cursor. */
  next: number;
}

const routes = new Map<string, RouteMetric>();

let inFlight = 0;
let peakInFlight = 0;
let rateLimitRejections = 0;
let rconReconnects = 0;

const eventLoopMonitor = monitorEventLoopDelay({ resolution: 20 });
eventLoopMonitor.enable();

function routeKey(method: string, routePath: string): string {
  return `${method} ${routePath}`;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

/** Requests holding an in-flight slot, keyed by their raw request object. */
const holding = new WeakSet<object>();

/**
 * Take an in-flight slot. With a `handle` (the raw request), the slot is
 * released at most once however many paths call endRequest for it.
 */
export function beginRequest(handle?: object): void {
  if (handle) {
    if (holding.has(handle)) return;
    holding.add(handle);
  }
  inFlight++;
  if (inFlight > peakInFlight) peakInFlight = inFlight;
}

/**
 * Give the slot back. W-002: a request can end three ways (a sent reply, a
 * client that hung up first, a hijacked stream) and each one calls this, so
 * it must be idempotent per request or the count drifts.
 */
export function endRequest(handle?: object): void {
  if (handle && !holding.delete(handle)) return;
  inFlight = Math.max(0, inFlight - 1);
}

export function getInFlight(): number {
  return inFlight;
}

/** Timed out at the HTTP layer specifically (a script/script-runner timeout), not just a 5xx. */
export function recordRequest(
  method: string,
  routePath: string,
  status: number,
  durationMs: number,
  timedOut = false,
): void {
  const key = routeKey(method, routePath);
  let m = routes.get(key);
  if (!m) {
    m = { count: 0, errorCount: 0, timeoutCount: 0, samples: [], next: 0 };
    routes.set(key, m);
  }
  m.count++;
  if (status >= 500) m.errorCount++;
  if (timedOut) m.timeoutCount++;
  if (m.samples.length < SAMPLE_SIZE) m.samples.push(durationMs);
  else m.samples[m.next] = durationMs;
  m.next = (m.next + 1) % SAMPLE_SIZE;
}

export function recordRateLimitRejection(): void {
  rateLimitRejections++;
}

export function recordRconReconnect(): void {
  rconReconnects++;
}

export interface MetricsSnapshot {
  uptimeSeconds: number;
  memory: NodeJS.MemoryUsage;
  inFlight: number;
  peakInFlight: number;
  rateLimitRejections: number;
  rconReconnects: number;
  eventLoopDelayMs: { mean: number; p95: number; max: number };
  cache: Record<string, { hits: number; misses: number; hitRate: number }>;
  routes: Record<
    string,
    { count: number; errorCount: number; timeoutCount: number; p50Ms: number; p95Ms: number }
  >;
}

export function getSnapshot(): MetricsSnapshot {
  const routeSnapshot: MetricsSnapshot["routes"] = {};
  for (const [key, m] of routes) {
    const sorted = [...m.samples].sort((a, b) => a - b);
    routeSnapshot[key] = {
      count: m.count,
      errorCount: m.errorCount,
      timeoutCount: m.timeoutCount,
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
    };
  }

  const hist = eventLoopMonitor;
  return {
    uptimeSeconds: Math.round(process.uptime()),
    memory: process.memoryUsage(),
    inFlight,
    peakInFlight,
    rateLimitRejections,
    rconReconnects,
    eventLoopDelayMs: {
      mean: hist.mean / 1e6,
      p95: hist.percentile(95) / 1e6,
      max: hist.max / 1e6,
    },
    cache: {},
    routes: routeSnapshot,
  };
}

/** Test-only: drop all accumulated counters. */
export function resetMetricsForTesting(): void {
  routes.clear();
  inFlight = 0;
  peakInFlight = 0;
  rateLimitRejections = 0;
  rconReconnects = 0;
  eventLoopMonitor.reset();
}
