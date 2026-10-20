import { describe, it, expect } from "vitest";
import { isPublicPath, isUnthrottledPath } from "../../src/http/publicPaths.js";

describe("isPublicPath", () => {
  it("matches /health with or without a query string", () => {
    expect(isPublicPath("/health")).toBe(true);
    expect(isPublicPath("/health?probe=1")).toBe(true);
    expect(isPublicPath("/health?")).toBe(true);
  });

  it("does not widen to other paths", () => {
    for (const url of ["/health/x", "/healthz", "/health/", "/metrics", "/instances/a/health", "/x?/health"]) {
      expect(isPublicPath(url), url).toBe(false);
    }
  });
});

describe("isUnthrottledPath", () => {
  it("matches /health and /metrics ignoring the query string", () => {
    for (const url of ["/health", "/health?a=1", "/metrics", "/metrics?a=1"]) {
      expect(isUnthrottledPath(url), url).toBe(true);
    }
  });

  it("does not widen to other paths", () => {
    for (const url of ["/metrics/x", "/health/x", "/manifest", "/instances"]) {
      expect(isUnthrottledPath(url), url).toBe(false);
    }
  });
});
