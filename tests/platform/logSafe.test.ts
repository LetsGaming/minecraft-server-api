import { describe, it, expect, vi, afterEach } from "vitest";

import { log, logFields, logSafe } from "../../src/platform/logger.js";
import { classifyResult, createModCompat } from "../../src/instances/modCompat.js";

const c = (...codes: number[]) => String.fromCharCode(...codes);

/** One hostile string per character class the logger must neutralise. */
const CLASSES: Record<string, string> = {
  LF: c(10),
  CR: c(13),
  "CRLF": c(13, 10),
  VT: c(11),
  FF: c(12),
  NUL: c(0),
  BEL: c(7),
  ESC: c(27),
  DEL: c(0x7f),
  NEL: c(0x85),
  "other C1": c(0x9b),
  LS: c(0x2028),
  PS: c(0x2029),
  "bidi override": c(0x202e),
  "bidi isolate": c(0x2066),
  "zero width": c(0x200b),
  "ANSI CSI": c(27) + "[31mred" + c(27) + "[0m",
  OSC: c(27) + "]0;title" + c(7),
};

const FORGED = " [INFO] [x] forged line key=forged";

function physicalLines(line: string): string[] {
  const breaks = new Set([10, 13, 11, 12, 133, 8232, 8233]);
  const lines: string[] = [""];
  for (const ch of line) {
    if (breaks.has(ch.charCodeAt(0))) lines.push("");
    else lines[lines.length - 1] += ch;
  }
  return lines;
}

afterEach(() => vi.restoreAllMocks());

describe("logSafe", () => {
  it.each(Object.entries(CLASSES))("neutralises %s", (_name, ch) => {
    const out = logSafe("a" + ch + "b" + FORGED);
    expect(physicalLines(out)).toHaveLength(1);
    expect(out).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(out).not.toContain(c(0x2028));
    expect(out).not.toContain(c(0x202e));
    expect(out.startsWith("a")).toBe(true);
  });

  it("keeps ordinary text, spaces and unicode readable", () => {
    expect(logSafe("Sodium 0.5.8 für 1.21.5, ok")).toBe("Sodium 0.5.8 für 1.21.5, ok");
  });

  it("caps the length", () => {
    expect(logSafe("a".repeat(2000)).length).toBeLessThan(600);
  });

  it("serialises non-strings without a raw newline", () => {
    const value = { a: ["x", "y"].join(c(10)) };
    const out = logSafe(value);
    expect(out).toBe(JSON.stringify(value));
    expect(out).not.toContain(c(10));
  });
});

describe("logFields", () => {
  it("leaves plain values unquoted", () => {
    expect(logFields({ slug: "fabric-api", mcVersion: "1.21.5" })).toBe(
      "slug=fabric-api mcVersion=1.21.5",
    );
  });

  it("quotes values with spaces, equals signs or quotes so no extra pair appears", () => {
    const out = logFields({ slug: 'a b" detail=forged', mcVersion: "1.21" });
    expect(out).toBe('slug="a b\\" detail=forged" mcVersion=1.21');
    const pairs = [...out.matchAll(/(\w+)=("(?:[^"\\]|\\.)*"|\S*)/g)].map((m) => m[1]);
    expect(pairs).toEqual(["slug", "mcVersion"]);
  });

  it.each(Object.entries(CLASSES))("keeps %s in a value on one line in one pair", (_n, ch) => {
    const out = logFields({ slug: "a" + ch + FORGED, mcVersion: "1.21" });
    expect(physicalLines(out)).toHaveLength(1);
    expect(out.match(/(?:^| )[A-Za-z]+=(?=")/g)).toHaveLength(1);
    expect(out.endsWith(" mcVersion=1.21")).toBe(true);
  });
});

describe("log lines stay single lines", () => {
  it.each(Object.entries(CLASSES))("for %s in the logger message", (_n, ch) => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    log.error("t", "boom" + ch + FORGED);
    const line = spy.mock.calls[0]![0] as string;
    expect(physicalLines(line)).toHaveLength(1);
    expect(line).toMatch(/^\[[\d: -]+\] \[ERROR\] \[t\] boom/);
  });

  it("for hostile slugs and script text in compat results", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const hostile = "x" + c(10) + "[INFO] forged" + c(27) + "[31m" + c(0x2028);
    classifyResult(hostile, null, { status: "error", error: hostile });
    classifyResult(hostile, null, { status: hostile });

    const compat = createModCompat({
      readInstalled: async () => ({
        modLoader: "fabric",
        mods: [{ slug: hostile, versionId: null }],
      }),
      checkOne: async () => {
        throw new Error(hostile);
      },
    });
    const { jobId } = await compat.start("1.21.5");
    for (let i = 0; i < 100 && compat.get(jobId)!.state === "running"; i++) {
      await new Promise((r) => setTimeout(r, 1));
    }

    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const [line] of spy.mock.calls) {
      expect(physicalLines(String(line))).toHaveLength(1);
      expect(String(line)).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    }
  });
});
