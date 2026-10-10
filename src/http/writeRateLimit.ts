/**
 * A stricter sliding-window budget for mutating requests, on top of the
 * general read limiter. Reads (status polling) are frequent and cheap;
 * writes (scripts, mod mutations, restore, console commands) are rare and
 * expensive, and deserve their own tighter ceiling rather than sharing the
 * read budget's headroom. Hand-rolled like AuthFailTracker in auth.ts for
 * the same reason: @fastify/rate-limit only expresses one global/per-route
 * budget cleanly, and this is one Map and 20 lines.
 */
const WINDOW_MS = 60_000;
const MAX_WRITES = 10;

/** Above this many tracked IPs, entries with no hit inside the window are dropped. */
const SWEEP_THRESHOLD = 10_000;

export class WriteRateLimiter {
  private readonly hits = new Map<string, number[]>();

  size(): number {
    return this.hits.size;
  }

  private sweep(now: number): void {
    for (const [ip, list] of this.hits) {
      if (list.every((t) => now - t >= WINDOW_MS)) this.hits.delete(ip);
    }
  }

  /** True and does not record when the IP is already at budget. */
  tryAcquire(ip: string): boolean {
    const now = Date.now();
    if (this.hits.size > SWEEP_THRESHOLD) this.sweep(now);
    const list = (this.hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
    if (list.length >= MAX_WRITES) {
      this.hits.set(ip, list);
      return false;
    }
    list.push(now);
    this.hits.set(ip, list);
    return true;
  }

  retryAfterSeconds(ip: string): number {
    const list = this.hits.get(ip) ?? [];
    const oldest = list[0];
    if (oldest === undefined) return Math.ceil(WINDOW_MS / 1000);
    return Math.max(1, Math.ceil((oldest + WINDOW_MS - Date.now()) / 1000));
  }
}

export const WRITE_LIMIT_WINDOW_MS = WINDOW_MS;
export const WRITE_LIMIT_MAX = MAX_WRITES;
