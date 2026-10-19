import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-log-"));
  process.env.MC_LOG_DIR = dir;
  vi.resetModules();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.MC_LOG_DIR;
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("log file", () => {
  it("receives every line next to the console output", async () => {
    const { log, flushLog } = await import("../../src/platform/logger.js");
    log.info("web", "hello");
    log.error("mods", "broke\nbadly");
    await flushLog();
    const text = fs.readFileSync(path.join(dir, "api-server.log"), "utf8");
    expect(text).toMatch(/\[INFO\] \[web\] hello\n/);
    expect(text).toMatch(/\[ERROR\] \[mods\] broke\\nbadly\n/);
  });

  it("is not written when MC_LOG_DIR is empty", async () => {
    process.env.MC_LOG_DIR = "";
    const { log, flushLog } = await import("../../src/platform/logger.js");
    log.info("web", "quiet");
    await flushLog();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("starts a new file once the current one is large", async () => {
    fs.writeFileSync(path.join(dir, "api-server.log"), "x".repeat(5 * 1024 * 1024 + 1));
    const { log, flushLog } = await import("../../src/platform/logger.js");
    log.info("web", "fresh");
    await flushLog();
    expect(fs.existsSync(path.join(dir, "api-server.log.1"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, "api-server.log"), "utf8")).toMatch(/fresh/);
  });
});

describe("throttled lines (W-020)", () => {
  it("logs once per interval and counts what it held back", async () => {
    const { logThrottled } = await import("../../src/platform/logger.js");
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) logThrottled("k", 60_000, (held) => seen.push(held));
    expect(seen).toEqual([0]);
  });
});

describe.skipIf(process.platform === "win32")("log file permissions", () => {
  it("creates the log readable by the wrapper user only", async () => {
    const sub = path.join(dir, "nested");
    process.env.MC_LOG_DIR = sub;
    const { log, flushLog } = await import("../../src/platform/logger.js");
    log.info("web", "private");
    await flushLog();
    expect(fs.statSync(sub).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(sub, "api-server.log")).mode & 0o777).toBe(0o600);
  });
});
