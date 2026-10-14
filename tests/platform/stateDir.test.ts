/**
 * Where job files go when MC_STATE_DIR is unset and ./state cannot be
 * written: a per-user directory under the temp dir, used only when nobody
 * else can reach it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import { jobStateDir, privateTempDir } from "../../src/platform/spawn.js";

let tmp: string;
const savedTmp = process.env.TMPDIR;
const savedState = process.env.MC_STATE_DIR;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "statedir-"));
  process.env.TMPDIR = tmp;
});
afterEach(() => {
  if (savedTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmp;
  if (savedState === undefined) delete process.env.MC_STATE_DIR;
  else process.env.MC_STATE_DIR = savedState;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const uid = process.getuid?.() ?? 0;

describe("jobStateDir", () => {
  it("uses MC_STATE_DIR when set", () => {
    process.env.MC_STATE_DIR = "/srv/state";
    expect(jobStateDir()).toBe(path.join("/srv/state", "jobs"));
  });
});

describe("privateTempDir", () => {
  it("creates a 0700 directory per user", () => {
    const dir = privateTempDir();
    expect(dir).toBe(path.join(tmp, `mc-api-server-${uid}`));
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(privateTempDir()).toBe(dir);
  });

  it("refuses a directory others can write", () => {
    const dir = path.join(tmp, `mc-api-server-${uid}`);
    fs.mkdirSync(dir);
    fs.chmodSync(dir, 0o777);
    expect(() => privateTempDir()).toThrow(/MC_STATE_DIR/);
  });

  it("refuses a symlink planted in its place", () => {
    const target = fs.mkdtempSync(path.join(tmp, "elsewhere-"));
    fs.chmodSync(target, 0o700);
    fs.symlinkSync(target, path.join(tmp, `mc-api-server-${uid}`));
    expect(() => privateTempDir()).toThrow(/MC_STATE_DIR/);
  });
});
