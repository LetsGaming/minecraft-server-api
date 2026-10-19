import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { tailNoFollow } from "../../src/platform/safeFs.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tail-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("tailNoFollow", () => {
  it("returns the last lines", async () => {
    const file = path.join(dir, "a.log");
    fs.writeFileSync(file, "1\n2\n3\n4\n");
    expect(await tailNoFollow(file, 2, 1024)).toBe("3\n4\n");
  });

  it("drops the partial first line when the window starts mid-file", async () => {
    const file = path.join(dir, "b.log");
    fs.writeFileSync(file, "aaaa\nbbbb\ncccc\n");
    expect(await tailNoFollow(file, 10, 8)).toBe("cccc\n");
  });
});
