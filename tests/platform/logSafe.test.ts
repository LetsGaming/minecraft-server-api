import { describe, it, expect, vi, afterEach } from "vitest";

import { log, logSafe } from "../../src/platform/logger.js";
import { classifyResult, createModCompat } from "../../src/instances/modCompat.js";

const HOSTILE = "boom\n[2026-01-01 00:00:00] [INFO] [x] forged line\r\u001b[31mred\u001b[0m\u0007";

afterEach(() => vi.restoreAllMocks());

describe("logSafe", () => {
  it("escapes newlines, carriage returns and ANSI escapes", () => {
    const out = logSafe(HOSTILE);
    expect(out).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(out).toContain("\\n[2026");
    expect(out).toContain("\\u001b[31m");
  });

  it("caps the length", () => {
    expect(logSafe("a".repeat(2000)).length).toBeLessThan(600);
  });

  it("serialises non-strings", () => {
    const value = { a: ["x", "y"].join(String.fromCharCode(10)) };
    const out = logSafe(value);
    expect(out).toBe(JSON.stringify(value));
    expect(out).not.toContain(String.fromCharCode(10));
  });
});

describe("log lines stay single lines", () => {
  it("for the logger itself", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    log.error("t", HOSTILE);
    const line = spy.mock.calls[0]![0] as string;
    expect(line.split("\n")).toHaveLength(1);
    expect(line).not.toContain("\u001b");
  });

  it("for hostile slugs and script text in compat results", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    classifyResult(HOSTILE, null, { status: "error", error: HOSTILE });
    classifyResult(HOSTILE, null, { status: HOSTILE });

    const compat = createModCompat({
      readInstalled: async () => ({
        modLoader: "fabric",
        mods: [{ slug: HOSTILE, versionId: null }],
      }),
      checkOne: async () => {
        throw new Error(HOSTILE);
      },
    });
    const { jobId } = await compat.start("1.21.5");
    for (let i = 0; i < 100 && compat.get(jobId)!.state === "running"; i++) {
      await new Promise((r) => setTimeout(r, 1));
    }

    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const [line] of spy.mock.calls) {
      expect(String(line).split("\n")).toHaveLength(1);
      expect(String(line)).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
    }
  });
});
