import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import { apiKeySettingHint } from "../../src/config/load.js";

const saved = process.env.CONFIG_FILE;
afterEach(() => {
  if (saved === undefined) delete process.env.CONFIG_FILE;
  else process.env.CONFIG_FILE = saved;
});

describe("apiKeySettingHint", () => {
  it("names apiKey in the JSON file when api-server-config.json is in use", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keyhint-"));
    const file = path.join(dir, "api-server-config.json");
    fs.writeFileSync(file, "{}");
    process.env.CONFIG_FILE = file;
    const hint = apiKeySettingHint();
    fs.rmSync(dir, { recursive: true, force: true });
    expect(hint).toContain('"apiKey"');
    expect(hint).toContain(file);
    expect(hint).not.toContain("API_SERVER_KEY");
  });

  it("names API_SERVER_KEY in the variables.txt and env-only modes", () => {
    process.env.CONFIG_FILE = path.join(os.tmpdir(), "does-not-exist-keyhint.json");
    expect(apiKeySettingHint()).toContain("API_SERVER_KEY");
  });
});
