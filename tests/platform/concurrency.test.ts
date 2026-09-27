import { describe, it, expect } from "vitest";
import { mapLimit } from "../../src/platform/concurrency.js";

describe("mapLimit()", () => {
  it("preserves order and results regardless of completion order", async () => {
    const delays = [30, 10, 20, 0, 15];
    const out = await mapLimit(delays, 3, (ms, i) => new Promise<number>((resolve) =>
      setTimeout(() => resolve(i), ms),
    ));
    expect(out).toEqual([0, 1, 2, 3, 4]);
  });

  it("never runs more than `limit` at once", async () => {
    let active = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await mapLimit(items, 4, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("handles an empty array", async () => {
    const out = await mapLimit([], 8, async (x: number) => x);
    expect(out).toEqual([]);
  });

  it("propagates a rejection", async () => {
    await expect(
      mapLimit([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });
});
