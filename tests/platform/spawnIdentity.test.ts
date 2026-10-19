import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import { parseProcStartTime, procIdentity, sweepOrphanedJobFiles } from "../../src/platform/spawn.js";

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-id-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const STAT_TAIL = "S 1 4242 4242 0 -1 4194560 1000 0 0 0 5 3 0 0 20 0 1 0 987654 12345678 900 18446744073709551615";

describe("parseProcStartTime", () => {
  it("reads field 22", () => {
    expect(parseProcStartTime(`4242 (java) ${STAT_TAIL}`)).toBe("987654");
  });

  it("counts from the last parenthesis when the name has spaces and brackets", () => {
    expect(parseProcStartTime(`4242 (my (odd) name) ${STAT_TAIL}`)).toBe("987654");
  });

  it("returns null for a truncated or malformed line", () => {
    expect(parseProcStartTime("4242 (java) S 1 2")).toBeNull();
    expect(parseProcStartTime("garbage")).toBeNull();
  });
});

describe("procIdentity", () => {
  it("reads the boot id and a process's start time from a proc tree", () => {
    const proc = tmp();
    fs.mkdirSync(path.join(proc, "sys", "kernel", "random"), { recursive: true });
    fs.writeFileSync(path.join(proc, "sys", "kernel", "random", "boot_id"), "abc-123\n");
    fs.mkdirSync(path.join(proc, "4242"));
    fs.writeFileSync(path.join(proc, "4242", "stat"), `4242 (java) ${STAT_TAIL}\n`);
    const id = procIdentity(proc);
    expect(id.bootId()).toBe("abc-123");
    expect(id.startTime(4242)).toBe("987654");
    expect(id.startTime(1)).toBeNull();
  });

  it("is null where there is no /proc", () => {
    const id = procIdentity(path.join(tmp(), "missing"));
    expect(id.bootId()).toBeNull();
    expect(id.startTime(1)).toBeNull();
  });
});

describe("sweepOrphanedJobFiles", () => {
  it("removes job output no record names and keeps the rest", () => {
    const dir = tmp();
    const kept = path.join(dir, "upgrade-1.out");
    const keptErr = path.join(dir, "upgrade-1.err");
    const orphanOut = path.join(dir, "prune-scan-1.out");
    const orphanErr = path.join(dir, "prune-scan-1.err");
    const other = path.join(dir, "notes.txt");
    for (const f of [kept, keptErr, orphanOut, orphanErr, other]) fs.writeFileSync(f, "x");
    fs.writeFileSync(path.join(dir, "smp.upgrade.json"), JSON.stringify({ files: [kept, keptErr] }));

    expect(sweepOrphanedJobFiles(dir, { minAgeMs: 0 })).toBe(2);
    expect(fs.existsSync(kept)).toBe(true);
    expect(fs.existsSync(keptErr)).toBe(true);
    expect(fs.existsSync(orphanOut)).toBe(false);
    expect(fs.existsSync(orphanErr)).toBe(false);
    expect(fs.existsSync(other)).toBe(true);
  });

  it("leaves files younger than the minimum age", () => {
    const dir = tmp();
    const young = path.join(dir, "prune-scan-2.out");
    fs.writeFileSync(young, "x");
    expect(sweepOrphanedJobFiles(dir)).toBe(0);
    expect(fs.existsSync(young)).toBe(true);
  });

  it("copes with an unreadable record and a missing directory", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "smp.upgrade.json"), "{not json");
    fs.writeFileSync(path.join(dir, "a.out"), "x");
    expect(sweepOrphanedJobFiles(dir, { minAgeMs: 0 })).toBe(1);
    expect(sweepOrphanedJobFiles(path.join(dir, "nope"))).toBe(0);
  });
});
