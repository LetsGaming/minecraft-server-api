/**
 * The config editor's safety rules: secrets redacted (W-006), protected
 * server.properties keys (W-006), files of the instance user never followed
 * out of the server directory (W-007), writes serialized and reverts
 * concurrency-checked (W-011).
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createConfigFiles } from "../../src/instances/configFiles.js";
import {
  REDACTED,
  changedProtectedKeys,
  redactSecrets,
  restoreSecrets,
} from "../../src/instances/configSecrets.js";
import type { InstanceConfig } from "../../src/config/types.js";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "configsafety-"));
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

let serverPath: string;
let cfg: InstanceConfig;
let n = 0;

function put(rel: string, text: string): void {
  const file = path.join(serverPath, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

beforeEach(() => {
  serverPath = path.join(base, `s${++n}`, "server");
  put(
    "server.properties",
    "motd=Hello\nrcon.password=hunter2\nonline-mode=true\nmax-players=20\n",
  );
  put("plugins/DiscordSRV/config.yml", "BotToken: \"abc.def\"\nChannels: {}\n");
  put("config/mod.toml", "[a]\n\tb = 1\n");
  cfg = {
    id: "smp",
    serverPath,
    scriptsDir: "",
    backupsPath: "",
    linuxUser: "mc",
    useRcon: false,
    rconHost: "127.0.0.1",
    rconPort: 25575,
    rconPassword: "",
  };
});

async function open(rel: string) {
  const files = createConfigFiles(cfg);
  const info = (await files.index()).files.find((f) => f.relPath === rel)!;
  const read = await files.read(info.id);
  if (!read || "tooLarge" in read) throw new Error("unreadable");
  return { files, id: info.id, ...read };
}

const disk = (rel: string) => fs.readFileSync(path.join(serverPath, rel), "utf-8");

describe("secret redaction (W-006)", () => {
  it("never shows a credential", async () => {
    const props = await open("server.properties");
    expect(props.text).not.toContain("hunter2");
    expect(props.text).toContain(`rcon.password=${REDACTED}`);
    const plugin = await open("plugins/DiscordSRV/config.yml");
    expect(plugin.text).toBe(`BotToken: "${REDACTED}"\nChannels: {}\n`);
  });

  it("keeps the real value when the redacted line comes back unchanged", async () => {
    const { files, id, text, etag } = await open("server.properties");
    const res = await files.write(id, text.replace("motd=Hello", "motd=Hi"), etag);
    expect(res.ok).toBe(true);
    expect(disk("server.properties")).toContain("rcon.password=hunter2");
    expect(disk("server.properties")).toContain("motd=Hi");
  });

  it("refuses a placeholder that would land on disk", async () => {
    const { files, id, etag } = await open("plugins/DiscordSRV/config.yml");
    const res = await files.write(id, `Other: "${REDACTED}"\n`, etag);
    expect(res).toEqual({ ok: false, reason: "redacted" });
    expect(disk("plugins/DiscordSRV/config.yml")).toContain("abc.def");
  });

  it("round-trips JSON members and repeated keys", () => {
    const json = '{\n  "token": "t1",\n  "x": 1,\n  "token": "t2"\n}';
    const shown = redactSecrets(json);
    expect(shown).not.toMatch(/t1|t2/);
    expect(restoreSecrets(shown, json)).toBe(json);
  });
});

describe("protected server.properties keys (W-006)", () => {
  it("refuses a change without allowProtected", async () => {
    const { files, id, text, etag } = await open("server.properties");
    const res = await files.write(id, text.replace("online-mode=true", "online-mode=false"), etag);
    expect(res).toEqual({ ok: false, reason: "protected", keys: ["online-mode"] });
    expect(disk("server.properties")).toContain("online-mode=true");
  });

  it("allows it with allowProtected, and a new secret value replaces the old", async () => {
    const { files, id, text, etag } = await open("server.properties");
    const next = text
      .replace("online-mode=true", "online-mode=false")
      .replace(`rcon.password=${REDACTED}`, "rcon.password=new");
    expect((await files.write(id, next, etag, { allowProtected: true })).ok).toBe(true);
    expect(disk("server.properties")).toContain("rcon.password=new");
  });

  it("names every protected key that changed", () => {
    expect(
      changedProtectedKeys("a=1\nlevel-name=world\n", "a=2\nlevel-name=x\nmanagement-server-secret=s\n"),
    ).toEqual(["level-name", "management-server-secret"]);
  });

  it("does not let a revert bring back a protected value", async () => {
    const { files, id, text, etag } = await open("server.properties");
    const w = await files.write(id, text.replace("online-mode=true", "online-mode=false"), etag, {
      allowProtected: true,
    });
    if (!w.ok) throw new Error("write failed");
    const res = await files.revert(id, w.snapshot, w.etag);
    expect(res).toEqual({ ok: false, reason: "protected", keys: ["online-mode"] });
  });
});

describe("files of the instance user (W-007)", () => {
  it("does not list a root that links out of the server directory", async () => {
    const outside = path.join(base, `out${n}`);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "api-server-config.json"), '{"apiKey":"k"}');
    fs.rmSync(path.join(serverPath, "plugins"), { recursive: true });
    fs.symlinkSync(outside, path.join(serverPath, "plugins"));
    const listed = (await createConfigFiles(cfg).index()).files.map((f) => f.relPath);
    expect(listed.some((p) => p.startsWith("plugins/"))).toBe(false);
  });

  it("refuses a snapshot directory planted as a link", async () => {
    const elsewhere = path.join(base, `planted${n}`);
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, "keep-me"), "x");
    const { files, id, text, etag } = await open("config/mod.toml");
    fs.mkdirSync(path.join(serverPath, ".mcbot-config-snapshots"));
    fs.symlinkSync(elsewhere, path.join(serverPath, ".mcbot-config-snapshots", id));
    await expect(files.write(id, text, etag)).rejects.toThrow(/plain directory/);
    expect(fs.existsSync(path.join(elsewhere, "keep-me"))).toBe(true);
    expect(disk("config/mod.toml")).toBe("[a]\n\tb = 1\n");
  });
});

describe("write concurrency (W-011)", () => {
  it("lets only one of two writes with the same etag through", async () => {
    const { files, id, etag } = await open("config/mod.toml");
    const results = await Promise.all([
      files.write(id, "[a]\n\tb = 2\n", etag),
      files.write(id, "[a]\n\tb = 3\n", etag),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === "conflict")).toHaveLength(1);
  });

  it("refuses a revert over a file that changed since it was read", async () => {
    const { files, id, etag } = await open("config/mod.toml");
    const w = await files.write(id, "[a]\n\tb = 2\n", etag);
    if (!w.ok) throw new Error("write failed");
    expect(await files.revert(id, w.snapshot, etag)).toEqual({ ok: false, reason: "conflict" });
  });
});

describe("format-aware reads", () => {
  it("redacts a whitespace-separated rcon password and refuses an override spelled that way", async () => {
    put("server.properties", "rcon.password hunter2\nonline-mode=true\n");
    const { files, id, text, etag } = await open("server.properties");
    expect(text).not.toContain("hunter2");
    const res = await files.write(id, `${text}online-mode false\n`, etag);
    expect(res).toEqual({ ok: false, reason: "protected", keys: ["online-mode"] });
    expect(disk("server.properties")).toBe("rcon.password hunter2\nonline-mode=true\n");
  });

  it("redacts nested secrets in minified JSON and restores them on write", async () => {
    put("config/app.json", '{"db":{"password":"hunter2"},"n":1}');
    const { files, id, text, etag } = await open("config/app.json");
    expect(text).not.toContain("hunter2");
    const res = await files.write(id, text.replace('"n":1', '"n":2'), etag);
    expect(res.ok).toBe(true);
    expect(disk("config/app.json")).toBe('{"db":{"password":"hunter2"},"n":2}');
  });
});

describe("snapshots and size limits", () => {
  it.skipIf(process.platform === "win32")("creates snapshots private to the wrapper user", async () => {
    const { files, id, etag } = await open("config/mod.toml");
    const w = await files.write(id, "[a]\n\tb = 2\n", etag);
    if (!w.ok) throw new Error("write failed");
    const root = path.join(serverPath, ".mcbot-config-snapshots");
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(root, id)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(root, id, w.snapshot)).mode & 0o777).toBe(0o600);
  });

  it("refuses to write over a file that grew past the limit after it was indexed", async () => {
    const { files, id, etag } = await open("config/mod.toml");
    put("config/mod.toml", "x".repeat(2 * 1024 * 1024));
    const res = await files.write(id, "[a]\n", etag);
    expect(res).toEqual({ ok: false, reason: "too-large" });
  });
});
