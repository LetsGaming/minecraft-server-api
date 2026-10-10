import { describe, it, expect, vi, afterEach } from "vitest";

import { AuthFailTracker } from "../../src/http/auth.js";

afterEach(() => vi.useRealTimers());

describe("AuthFailTracker memory", () => {
  it("does not create an entry when an unknown IP is checked", () => {
    const tracker = new AuthFailTracker();
    for (let i = 0; i < 100; i++) tracker.isBlocked(`10.1.0.${i}`);
    expect(tracker.size()).toBe(0);
  });

  it("drops aged-out entries on a schedule, without a large map", () => {
    vi.useFakeTimers();
    const tracker = new AuthFailTracker();
    for (let i = 0; i < 5; i++) tracker.recordFailure(`10.2.0.${i}`);
    expect(tracker.size()).toBe(5);
    vi.advanceTimersByTime(16 * 60 * 1000);
    tracker.isBlocked("10.9.9.9");
    expect(tracker.size()).toBe(0);
  });

  it("forgets an IP whose failures have all aged out", () => {
    vi.useFakeTimers();
    const tracker = new AuthFailTracker();
    tracker.recordFailure("10.3.0.1");
    vi.advanceTimersByTime(14 * 60 * 1000);
    expect(tracker.isBlocked("10.3.0.1")).toBe(false);
    expect(tracker.size()).toBe(1);
    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(tracker.isBlocked("10.3.0.1")).toBe(false);
    expect(tracker.size()).toBe(0);
  });
});
