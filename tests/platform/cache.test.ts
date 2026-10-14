import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cached } from "../../src/platform/cache.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("cached()", () => {
  it("misses once, then hits without calling load again", async () => {
    const load = vi.fn().mockResolvedValue("v1");
    const c = cached(load, { freshMs: 1_000, staleMs: 5_000 });

    expect(c.peek()).toBeNull();
    const first = await c.get();
    expect(first.value).toBe("v1");
    expect(load).toHaveBeenCalledTimes(1);

    const second = await c.get();
    expect(second.value).toBe("v1");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("reloads once freshMs has elapsed", async () => {
    const load = vi.fn().mockResolvedValueOnce("v1").mockResolvedValueOnce("v2");
    const c = cached(load, { freshMs: 1_000, staleMs: 5_000 });
    await c.get();
    await vi.advanceTimersByTimeAsync(1_001);
    const res = await c.get();
    expect(res.value).toBe("v2");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("single-flights concurrent callers into one load", async () => {
    let resolveLoad!: (v: string) => void;
    const load = vi.fn(
      () => new Promise<string>((resolve) => { resolveLoad = resolve; }),
    );
    const c = cached(load, { freshMs: 1_000, staleMs: 5_000 });

    const a = c.get();
    const b = c.get();
    const cc = c.get();
    expect(load).toHaveBeenCalledTimes(1);
    resolveLoad("v1");
    const [ra, rb, rc] = await Promise.all([a, b, cc]);
    expect(ra.value).toBe("v1");
    expect(rb.value).toBe("v1");
    expect(rc.value).toBe("v1");
  });

  it("serves stale data to a caller arriving while a refresh is already in flight", async () => {
    let resolveSecond!: (v: string) => void;
    const load = vi
      .fn()
      .mockResolvedValueOnce("v1")
      .mockImplementationOnce(() => new Promise<string>((resolve) => { resolveSecond = resolve; }));
    const c = cached(load, { freshMs: 1_000, staleMs: 5_000 });

    await c.get();
    await vi.advanceTimersByTimeAsync(1_001); // past fresh, inside stale

    // The triggering caller waits for the fresh value; a caller arriving
    // while that refresh is already running gets the stale one instantly
    // instead of joining the same wait.
    const triggering = c.get();
    const concurrent = await c.get();
    expect(concurrent.value).toBe("v1");
    expect(load).toHaveBeenCalledTimes(2);

    resolveSecond("v2");
    expect((await triggering).value).toBe("v2");
  });

  it("waits for a fresh load once the stale window has also elapsed", async () => {
    const load = vi.fn().mockResolvedValueOnce("v1").mockResolvedValueOnce("v2");
    const c = cached(load, { freshMs: 1_000, staleMs: 2_000 });
    await c.get();
    await vi.advanceTimersByTimeAsync(2_001);
    const res = await c.get();
    expect(res.value).toBe("v2");
  });

  it("invalidate() forces the next get() to reload", async () => {
    const load = vi.fn().mockResolvedValueOnce("v1").mockResolvedValueOnce("v2");
    const c = cached(load, { freshMs: 60_000, staleMs: 120_000 });
    await c.get();
    c.invalidate();
    expect(c.peek()).toBeNull();
    const res = await c.get();
    expect(res.value).toBe("v2");
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("invalidate during a load (W-017)", () => {
  it("does not cache or serve a load that started before the invalidate", async () => {
    let n = 0;
    const releases: Array<() => void> = [];
    const c = cached(
      () => new Promise<number>((resolve) => {
        const v = ++n;
        releases.push(() => resolve(v));
      }),
      { freshMs: 60_000, staleMs: 60_000 },
    );
    const before = c.get();
    c.invalidate();
    const after = c.get();
    releases[0]!();
    releases[1]!();
    expect((await before).value).toBe(1);
    expect((await after).value).toBe(2);
    expect((await c.get()).value).toBe(2);
  });
});
