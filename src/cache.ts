/**
 * Single-flight, short-TTL memo for one async read.
 *
 * Every expensive read this wrapper serves is an RCON round-trip against a
 * server that is slow *because* it is loaded — chunk generation, a full
 * player list, mob AI. Each caller used to start its own round-trip, so a
 * status poll, a `/list`, and a TPS check arriving together queued three
 * requests behind the same stalled game thread and each waited for the ones
 * in front of it. The wrapper looked down even though it was perfectly
 * healthy; only the thing it was asking was slow.
 *
 * Two rules fix that:
 *   - one load at a time (`inFlight`), shared by every concurrent caller;
 *   - while a load is running, a recent-enough previous value is served
 *     immediately instead of joining the queue.
 *
 * The second rule is the one that matters under load, and it is a deliberate
 * trade: callers can get an answer a few seconds old. For liveness, player
 * counts and TPS that is the right trade — a two-second-old "online" is true,
 * and a request that times out is not.
 */

export interface CacheEntry<T> {
  value: T;
  /** When `value` was produced (epoch ms). */
  at: number;
}

export interface Cached<T> {
  /**
   * The current value: fresh if one is, otherwise a stale-but-recent one
   * while a refresh runs, otherwise the result of a new load.
   */
  get(): Promise<CacheEntry<T>>;
  /** The last value without triggering any work. Null before the first load. */
  peek(): CacheEntry<T> | null;
  /** Force the next `get()` to load. For tests and config reloads. */
  invalidate(): void;
}

export interface CacheOptions {
  /** Below this age a cached value is served without any load. */
  freshMs: number;
  /**
   * Below this age a cached value may be served *while a load is running*.
   * Above it, callers wait for the load — a very old answer is worse than a
   * slow one. Must be >= freshMs.
   */
  staleMs: number;
}

/**
 * Wrap `load` in the policy above. `load` must not reject: a cache whose
 * refresh throws would leave callers with no answer at all, which is the
 * failure mode this exists to prevent. Callers that can fail should encode
 * the failure in `T` instead.
 */
export function cached<T>(
  load: () => Promise<T>,
  { freshMs, staleMs }: CacheOptions,
): Cached<T> {
  let entry: CacheEntry<T> | null = null;
  let inFlight: Promise<CacheEntry<T>> | null = null;

  function refresh(): Promise<CacheEntry<T>> {
    inFlight ??= load()
      .then((value) => {
        entry = { value, at: Date.now() };
        return entry;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  return {
    async get(): Promise<CacheEntry<T>> {
      const now = Date.now();
      if (entry && now - entry.at < freshMs) return entry;
      // A refresh is already running and we have something recent enough:
      // answer now. Waiting would only make this caller as slow as the
      // server it is asking about.
      if (inFlight && entry && now - entry.at < staleMs) return entry;
      return refresh();
    },
    peek: () => entry,
    invalidate: () => {
      entry = null;
    },
  };
}
