/**
 * Boundary validation — every case here encodes an audit finding (F-001,
 * F-009) and must keep passing verbatim across refactors.
 */
import { describe, it, expect } from "vitest";

import {
  sanitizeLines,
  UUID_RE,
  validateArgs,
} from "../../src/http/validation.js";

// ── F-009: tail lines sanitisation ──────────────────────────────────────

describe("tailLog lines parameter validation (F-009)", () => {
  it("clamps to 500 for large integers", () => expect(sanitizeLines("9999")).toBe(500));
  it("blocks scientific notation bypass", () => expect(sanitizeLines("1e6")).toBe(1));
  it("falls back to 10 for NaN input", () => expect(sanitizeLines("abc")).toBe(10));
  it("passes through a normal value", () => expect(sanitizeLines("50")).toBe(50));
  it("clamps minimum to 1 (zero)", () => expect(sanitizeLines("0")).toBe(1));
  it("clamps minimum to 1 (negative)", () => expect(sanitizeLines("-5")).toBe(1));
  it("defaults to 10 when absent", () => expect(sanitizeLines(undefined)).toBe(10));
});

// ── F-001: UUID allowlist ───────────────────────────────────────────────

describe("UUID allowlist regex (F-001)", () => {
  const valid = [
    "069a79f4-44e9-4726-a5be-fca90e38aaf5",
    "853C80EF-3C37-49FD-AA49-938B674ADAE6",
  ];
  const invalid = [
    "../../../etc/passwd",
    "069a79f444e94726a5befca90e38aaf5", // no dashes
    "069a79f4-44e9-4726-a5be-fca90e38aaf5.json",
    "",
    "g69a79f4-44e9-4726-a5be-fca90e38aaf5",
  ];
  for (const u of valid) it(`accepts ${u}`, () => expect(UUID_RE.test(u)).toBe(true));
  for (const u of invalid) it(`rejects "${u}"`, () => expect(UUID_RE.test(u)).toBe(false));
});

// ── F-001: script args allowlist ────────────────────────────────────────

describe("script args validation (F-001)", () => {
  it("accepts undefined", () => expect(validateArgs(undefined)).toBe(true));
  it("accepts simple safe args", () => expect(validateArgs(["daily", "v1.2"])).toBe(true));
  it("rejects a path-traversal arg", () => expect(validateArgs(["../../evil.sh"])).toBe(false));
  it("rejects a forward slash", () => expect(validateArgs(["a/b"])).toBe(false));
  it("rejects more than 5 args", () =>
    expect(validateArgs(["a", "b", "c", "d", "e", "f"])).toBe(false));
  it("rejects non-string entries", () => expect(validateArgs([42])).toBe(false));
  it("rejects shell metacharacters", () => expect(validateArgs(["a;rm"])).toBe(false));
});
