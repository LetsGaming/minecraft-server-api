import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { parseVarsFile } from "../src/parseVars.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vars-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(content: string): string {
  const p = path.join(tmp, `${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(p, content);
  return p;
}

describe("parseVarsFile", () => {
  it("parses quoted values", () => {
    expect(parseVarsFile(write('SERVER_PATH="/opt/mc/survival"'))).toEqual({
      SERVER_PATH: "/opt/mc/survival",
    });
  });

  it("parses unquoted values", () => {
    expect(parseVarsFile(write("RCON_PORT=25575"))).toEqual({
      RCON_PORT: "25575",
    });
  });

  it("keeps mid-string quotes intact (the pre-F-007 truncation case)", () => {
    // KEY="foo"bar is malformed shell, but the quoted branch must not
    // silently truncate at the inner quote — the unquoted branch takes
    // it whole.
    expect(parseVarsFile(write('KEY="foo"bar'))).toEqual({ KEY: '"foo"bar' });
  });

  it("skips comments and blank lines", () => {
    const vars = parseVarsFile(write('# comment\n\nUSER="minecraft"\n'));
    expect(vars).toEqual({ USER: "minecraft" });
  });

  it("takes everything after the first = for unquoted values", () => {
    expect(parseVarsFile(write("JAVA_ARGS=-Xmx4G -Xms4G"))).toEqual({
      JAVA_ARGS: "-Xmx4G -Xms4G",
    });
  });

  it("preserves an empty quoted value", () => {
    expect(parseVarsFile(write('API_SERVER_KEY=""'))).toEqual({
      API_SERVER_KEY: "",
    });
  });
});
