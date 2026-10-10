import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import type { ServerResponse } from "http";

import { initLogStream, type LogStreamAPI } from "../../src/platform/logStream.js";
import { makeFixture, type Fixture } from "../helpers/instanceFixture.js";

let fx: Fixture;
let logFile: string;
let api: LogStreamAPI;

class FakeRes {
  chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  once(): this {
    return this;
  }
  lines(): string[] {
    return this.chunks.map((c) => {
      const m = /^data: (.*)\n\n$/s.exec(c);
      return (JSON.parse(m![1]!) as { line: string }).line;
    });
  }
}

function connect(): FakeRes {
  const res = new FakeRes();
  expect(api.addClient("fx", res as unknown as ServerResponse)).toBe(true);
  return res;
}

async function until(cond: () => boolean, ms = 4_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeEach(() => {
  fx = makeFixture();
  logFile = path.join(fx.cfg.serverPath, "logs", "latest.log");
  fs.writeFileSync(logFile, "old line\n");
  api = initLogStream({ fx: fx.cfg });
});

afterEach(() => {
  api.dispose();
  vi.restoreAllMocks();
  fx.cleanup();
});

describe("log stream tailing", () => {
  it("does not replay what was in the file before the client connected", async () => {
    const res = connect();
    fs.appendFileSync(logFile, "new line\n");
    await until(() => res.chunks.length > 0);
    expect(res.lines()).toEqual(["new line"]);
  });

  it("emits every complete appended line, tagged with the server id", async () => {
    const res = connect();
    fs.appendFileSync(logFile, "a\nb\nc\n");
    await until(() => res.chunks.length >= 3);
    expect(res.lines()).toEqual(["a", "b", "c"]);
    expect(JSON.parse(/^data: (.*)\n\n$/s.exec(res.chunks[0]!)![1]!)).toEqual({
      line: "a",
      serverId: "fx",
    });
  });

  it("restarts from the beginning after the file is truncated", async () => {
    const res = connect();
    fs.appendFileSync(logFile, "before\n");
    await until(() => res.chunks.length >= 1);
    fs.writeFileSync(logFile, "x\n");
    await until(() => res.chunks.length >= 2);
    expect(res.lines()).toEqual(["before", "x"]);
  });

  it("holds back a trailing partial line until its newline arrives", async () => {
    const res = connect();
    fs.appendFileSync(logFile, "first\nsecond-par");
    await until(() => res.chunks.length >= 1);
    await new Promise((r) => setTimeout(r, 1_200));
    expect(res.lines()).toEqual(["first"]);
    fs.appendFileSync(logFile, "tial\nthird\n");
    await until(() => res.chunks.length >= 3);
    expect(res.lines()).toEqual(["first", "second-partial", "third"]);
  });

  it("does not split a multi-byte character across reads", async () => {
    const res = connect();
    const bytes = Buffer.from("grüße\n");
    fs.appendFileSync(logFile, bytes.subarray(0, 4));
    await new Promise((r) => setTimeout(r, 1_200));
    fs.appendFileSync(logFile, bytes.subarray(4));
    await until(() => res.chunks.length >= 1);
    expect(res.lines()).toEqual(["grüße"]);
  });

  it("strips the carriage return of CRLF lines", async () => {
    const res = connect();
    fs.appendFileSync(logFile, "win\r\n");
    await until(() => res.chunks.length >= 1);
    expect(res.lines()).toEqual(["win"]);
  });

  it("keeps lines intact when the 1 MB read window ends mid-line", async () => {
    const res = connect();
    const total = 11_000;
    const lines = Array.from({ length: total }, (_, i) =>
      `${String(i).padStart(6, "0")} ${"x".repeat(93)}`,
    );
    fs.appendFileSync(logFile, lines.join("\n") + "\n");
    await until(() => res.chunks.length >= total, 8_000);
    expect(res.lines()).toEqual(lines);
  });

  it("refuses unknown instances and clients beyond the cap", () => {
    expect(api.addClient("nope", new FakeRes() as unknown as ServerResponse)).toBe(false);
    vi.stubEnv("MC_SSE_MAX_CLIENTS", "1");
    connect();
    expect(api.addClient("fx", new FakeRes() as unknown as ServerResponse)).toBe(false);
    vi.unstubAllEnvs();
  });

  it("stops delivering to a removed client", async () => {
    const res = connect();
    api.removeClient("fx", res as unknown as ServerResponse);
    fs.appendFileSync(logFile, "late\n");
    await new Promise((r) => setTimeout(r, 1_300));
    expect(res.chunks).toEqual([]);
  });
});
