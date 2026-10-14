/**
 * Mod config files on the wrapper: index, read, write, revert, containment.
 *
 * The security property under test is the same as for backups — no route
 * accepts a path — but the surface is wider here, because config files are
 * spread across four roots inside a directory that also holds the world, the
 * jar and ops.json. The allow-list and the realpath check are what keep an
 * "editor" from being a remote shell with extra steps.
 */
import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { buildApp } from "../../src/http/app.js";
import { createConfigFiles, guessModId, MAX_FILES } from "../../src/instances/configFiles.js";
import type { AppConfig, InstanceConfig } from "../../src/config/types.js";
import type { FastifyInstance } from "fastify";

const KEY = "test-key-0123456789";
const auth = { "x-api-key": KEY };

// Each test starts later than the last so the wrapper's cached index and its
// rate-limit windows from earlier tests have expired.
const clockBase = Date.now();
let clock = 0;

let root: string;
let serverPath: string;
let app: FastifyInstance;
let dispose: () => void;
let instanceCfg: InstanceConfig;

function write(rel: string, text: string): void {
  const file = path.join(serverPath, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function scaffold(): void {
  clock += 120_000;
  vi.setSystemTime(clockBase + clock);
  fs.rmSync(serverPath, { recursive: true, force: true });
  write("server.properties", "motd=Hello\nmax-players=20\n");
  write("config/jei-client.toml", '[general]\n\tenabled = true\n');
  write("config/sodium.json", '{ "quality": "high" }\n');
  write("defaultconfigs/pack.toml", "[a]\n\tb = 1\n");
  write("world/serverconfig/mymod-server.toml", "[server]\n\trate = 2\n");
  write("plugins/EssentialsX/config.properties", "locale=en\n");
  // Present but not editable: not an allow-listed root, not an editable type.
  write("ops.json", '[{"uuid":"x","name":"dom","level":4}]');
  write("world/level.dat", "binary-ish");
  write("config/notes.txt", "should not be listed");
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: clockBase + clock });
  if (!root) {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "configfiles-"));
    serverPath = path.join(root, "server");
    instanceCfg = {
      id: "smp",
      serverPath,
      scriptsDir: path.join(root, "scripts"),
      backupsPath: path.join(root, "backups"),
      linuxUser: "mc",
      useRcon: false,
      rconHost: "127.0.0.1",
      rconPort: 25575,
      rconPassword: "pw",
    };
    const config: AppConfig = { PORT: 8144, API_KEY: KEY, instances: { smp: instanceCfg } };
    const built = await buildApp({ config, allowNoAuth: false });
    app = built.app;
    dispose = () => built.logStreamAPI.dispose();
    await app.ready();
  }
  scaffold();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  dispose?.();
  await app?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

interface Row {
  id: string;
  relPath: string;
  modId: string;
  format: string;
  editable: boolean;
  tooLarge: boolean;
}

async function indexBody(): Promise<{ files: Row[]; truncated: boolean }> {
  const res = await app.inject({ method: "GET", url: "/instances/smp/configs", headers: auth });
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function index(): Promise<Row[]> {
  return (await indexBody()).files;
}

// ── The index ────────────────────────────────────────────────────────────────

describe("GET /configs", () => {
  it("finds config files across every allow-listed root", async () => {
    const paths = (await index()).map((f) => f.relPath);
    expect(paths).toContain("server.properties");
    expect(paths).toContain("config/jei-client.toml");
    expect(paths).toContain("config/sodium.json");
    expect(paths).toContain("defaultconfigs/pack.toml");
    expect(paths).toContain("world/serverconfig/mymod-server.toml");
    expect(paths).toContain("plugins/EssentialsX/config.properties");
  });

  it("does not expose files outside the allow-listed roots", async () => {
    // ops.json is a config file by any reasonable definition and is exactly
    // what must not be reachable: editing it is granting yourself operator.
    const paths = (await index()).map((f) => f.relPath);
    expect(paths).not.toContain("ops.json");
    expect(paths).not.toContain("world/level.dat");
  });

  it("lists plain text files as text and ignores unknown types", async () => {
    write("config/binary.dat", "x");
    const files = await index();
    const notes = files.find((f) => f.relPath === "config/notes.txt");
    expect(notes).toMatchObject({ format: "text", editable: true, tooLarge: false });
    expect(files.map((f) => f.relPath)).not.toContain("config/binary.dat");
  });

  it("reports the format of each supported extension", async () => {
    write("config/a.cfg", "x");
    write("config/b.yml", "x");
    write("config/c.yaml", "x");
    write("config/d.conf", "x");
    write("config/e.ini", "x");
    const byPath = new Map((await index()).map((f) => [f.relPath, f.format]));
    expect(byPath.get("config/a.cfg")).toBe("cfg");
    expect(byPath.get("config/b.yml")).toBe("yaml");
    expect(byPath.get("config/c.yaml")).toBe("yaml");
    expect(byPath.get("config/d.conf")).toBe("conf");
    expect(byPath.get("config/e.ini")).toBe("ini");
  });

  it("walks nested directories down to depth 8", async () => {
    write("config/a/b/c/d/e/f/g/deep.json", "{}");
    write("config/a/b/c/d/e/f/g/h/too-deep.json", "{}");
    const paths = (await index()).map((f) => f.relPath);
    expect(paths).toContain("config/a/b/c/d/e/f/g/deep.json");
    expect(paths).not.toContain("config/a/b/c/d/e/f/g/h/too-deep.json");
  });

  it("skips ignored directories", async () => {
    write("config/mod/cache/x.json", "{}");
    write("config/mod/backups/x.json", "{}");
    write("config/mod/logs/x.json", "{}");
    write("config/mod/node_modules/x.json", "{}");
    write("config/mod/real.json", "{}");
    const paths = (await index()).map((f) => f.relPath);
    expect(paths).toContain("config/mod/real.json");
    expect(paths.filter((p) => p.startsWith("config/mod/") && p !== "config/mod/real.json")).toEqual([]);
  });

  it("flags truncation at the file limit", async () => {
    for (let i = 0; i < MAX_FILES + 5; i++) write(`config/bulk/f${i}.json`, "{}");
    const body = await indexBody();
    expect(body.truncated).toBe(true);
    expect(body.files.length).toBeLessThanOrEqual(MAX_FILES + 1);
  });

  it("does not flag truncation for a normal tree", async () => {
    expect((await indexBody()).truncated).toBe(false);
  });

  it("groups nested files under the first directory below the root", async () => {
    write("config/xaero/minimap/settings.json", "{}");
    write("config/xaero/worldmap/settings.json", "{}");
    write("config/othermod/config.json", "{}");
    write("world/serverconfig/deep/sub/server.toml", "x = 1");
    const files = await index();
    const mod = (rel: string) => files.find((f) => f.relPath === rel)?.modId;
    expect(mod("config/xaero/minimap/settings.json")).toBe("xaero");
    expect(mod("config/xaero/worldmap/settings.json")).toBe("xaero");
    expect(mod("config/othermod/config.json")).toBe("othermod");
    expect(mod("world/serverconfig/deep/sub/server.toml")).toBe("deep");
    expect(mod("config/sodium.json")).toBe("sodium");
    expect(mod("world/serverconfig/mymod-server.toml")).toBe("mymod");
  });

  it("guesses the owning mod for grouping", async () => {
    const files = await index();
    expect(files.find((f) => f.relPath === "config/jei-client.toml")?.modId).toBe("jei");
    expect(files.find((f) => f.relPath.startsWith("plugins/"))?.modId).toBe("EssentialsX");
  });

  it("hands out opaque ids, never paths", async () => {
    for (const file of await index()) {
      expect(file.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(file.id).not.toContain("/");
      expect(file.id).not.toContain(file.relPath);
    }
  });

  it("401s without the key", async () => {
    const res = await app.inject({ method: "GET", url: "/instances/smp/configs" });
    expect(res.statusCode).toBe(401);
  });
});

// ── Read and write ───────────────────────────────────────────────────────────

describe("read / write / revert", () => {
  const find = async (rel: string) => (await index()).find((f) => f.relPath === rel)!;

  it("returns the raw text and an ETag", async () => {
    const file = await find("config/jei-client.toml");
    const res = await app.inject({
      method: "GET", url: `/instances/smp/configs/${file.id}`, headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toBe('[general]\n\tenabled = true\n');
    expect(res.json().etag).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("refuses a write with no If-Match", async () => {
    // Without it, two open editors silently overwrite each other.
    const file = await find("config/jei-client.toml");
    const res = await app.inject({
      method: "PUT", url: `/instances/smp/configs/${file.id}`,
      headers: { ...auth, "content-type": "application/json" },
      payload: { text: "x" },
    });
    expect(res.statusCode).toBe(428);
  });

  it("writes when the ETag still matches", async () => {
    const file = await find("config/jei-client.toml");
    const read = await app.inject({
      method: "GET", url: `/instances/smp/configs/${file.id}`, headers: auth,
    });
    const res = await app.inject({
      method: "PUT", url: `/instances/smp/configs/${file.id}`,
      headers: { ...auth, "content-type": "application/json", "if-match": read.json().etag },
      payload: { text: '[general]\n\tenabled = false\n' },
    });
    expect(res.statusCode).toBe(200);
    expect(fs.readFileSync(path.join(serverPath, "config/jei-client.toml"), "utf-8"))
      .toContain("enabled = false");
  });

  it("412s when the file changed underneath", async () => {
    // The realistic case: a mod rewrote its own config at shutdown while the
    // editor was open.
    const file = await find("config/jei-client.toml");
    const res = await app.inject({
      method: "PUT", url: `/instances/smp/configs/${file.id}`,
      headers: { ...auth, "content-type": "application/json", "if-match": "stale-etag" },
      payload: { text: "x = 1" },
    });
    expect(res.statusCode).toBe(412);
  });

  it("snapshots before writing, and can revert", async () => {
    const file = await find("config/jei-client.toml");
    const original = fs.readFileSync(path.join(serverPath, "config/jei-client.toml"), "utf-8");

    const read = await app.inject({
      method: "GET", url: `/instances/smp/configs/${file.id}`, headers: auth,
    });
    const put = await app.inject({
      method: "PUT", url: `/instances/smp/configs/${file.id}`,
      headers: { ...auth, "content-type": "application/json", "if-match": read.json().etag },
      payload: { text: "[general]\n\tenabled = false\n" },
    });
    const stamp = put.json().snapshot;
    expect(stamp).toBeTruthy();

    const revert = await app.inject({
      method: "POST", url: `/instances/smp/configs/${file.id}/revert`,
      headers: { ...auth, "content-type": "application/json", "if-match": put.json().etag },
      payload: { snapshot: stamp },
    });
    expect(revert.statusCode).toBe(200);
    expect(fs.readFileSync(path.join(serverPath, "config/jei-client.toml"), "utf-8"))
      .toBe(original);
  });

  it("rejects a snapshot name that is not one", async () => {
    const file = await find("config/jei-client.toml");
    for (const bad of ["../../etc/passwd", "/etc/passwd", "..%2Fx"]) {
      const res = await app.inject({
        method: "POST", url: `/instances/smp/configs/${file.id}/revert`,
        headers: { ...auth, "content-type": "application/json", "if-match": "x" },
        payload: { snapshot: bad },
      });
      expect(res.statusCode).toBe(404);
    }
  });

  it("400s a malformed file id", async () => {
    const res = await app.inject({
      method: "GET", url: "/instances/smp/configs/short", headers: auth,
    });
    expect([400, 404]).toContain(res.statusCode);
  });

  it("404s a well-formed id that names nothing", async () => {
    const res = await app.inject({
      method: "GET", url: "/instances/smp/configs/AAAAAAAAAAAAAAAAAAAAAA", headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });
});

// ── Containment ──────────────────────────────────────────────────────────────

describe("containment", () => {
  it("has nowhere to put a path: resolve only accepts ids", async () => {
    const files = createConfigFiles(instanceCfg);
    for (const attempt of [
      "../../../etc/passwd",
      "/etc/passwd",
      "config/jei-client.toml",
      "..%2F..%2Fetc%2Fpasswd",
    ]) {
      expect(await files.resolve(attempt)).toBeNull();
    }
  });

  it("refuses a symlink that escapes the server directory", async () => {
    // The case a resolve+startsWith check cannot see: the path is inside the
    // tree, the target is not.
    const secret = path.join(root, "outside.toml");
    fs.writeFileSync(secret, "[secret]\n\tkey = 1\n");
    const link = path.join(serverPath, "config", "escape.toml");
    try {
      fs.symlinkSync(secret, link);
    } catch {
      return; // no symlink support here
    }

    const files = createConfigFiles(instanceCfg);
    const listed = await files.index();
    // Not even listed: withFileTypes reports a symlink as neither file nor dir.
    expect(listed.files.some((f) => f.relPath.endsWith("escape.toml"))).toBe(false);
    fs.unlinkSync(link);
  });

  it("lists files larger than the cap as too large and refuses them", async () => {
    write("config/huge.toml", "x".repeat(1024 * 1024 + 10));
    const files = createConfigFiles(instanceCfg);
    const row = (await files.index()).files.find((f) => f.relPath.endsWith("huge.toml"));
    expect(row).toMatchObject({ editable: false, tooLarge: true });
    const res = await app.inject({
      method: "GET", url: `/instances/smp/configs/${(await index()).find((f) => f.tooLarge)!.id}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(413);
  });

  it("follows a symlinked directory that stays inside its root", async () => {
    write("config/real/inner.json", "{}");
    try {
      fs.symlinkSync(path.join(serverPath, "config/real"), path.join(serverPath, "config/alias"), "junction");
    } catch {
      return;
    }
    const paths = (await index()).map((f) => f.relPath);
    expect(paths).toContain("config/alias/inner.json");
  });

  it("does not follow a symlinked directory that leaves its root", async () => {
    write("world/level-data/secret.json", "{}");
    try {
      fs.symlinkSync(path.join(serverPath, "world/level-data"), path.join(serverPath, "config/escape"), "junction");
    } catch {
      return;
    }
    const paths = (await index()).map((f) => f.relPath);
    expect(paths.some((p) => p.includes("secret.json"))).toBe(false);
  });

  it("survives a symlink cycle", async () => {
    write("config/loop/x.json", "{}");
    try {
      fs.symlinkSync(path.join(serverPath, "config"), path.join(serverPath, "config/loop/back"), "junction");
    } catch {
      return;
    }
    const paths = (await index()).map((f) => f.relPath);
    expect(paths).toContain("config/loop/x.json");
    expect(paths.filter((p) => p.endsWith("/x.json"))).toHaveLength(1);
  });
});

describe("save limits and BOM", () => {
  async function put(rel: string, text: string, etag?: string) {
    const file = (await index()).find((f) => f.relPath === rel)!;
    const read = await app.inject({
      method: "GET", url: `/instances/smp/configs/${file.id}`, headers: auth,
    });
    return {
      read: read.json(),
      res: await app.inject({
        method: "PUT", url: `/instances/smp/configs/${file.id}`,
        headers: { ...auth, "content-type": "application/json", "if-match": etag ?? read.json().etag },
        payload: { text },
      }),
    };
  }

  it("accepts a 100 KB body", async () => {
    const big = `# ${"x".repeat(100 * 1024)}\n[general]\n\tenabled = false\n`;
    const { res } = await put("config/jei-client.toml", big);
    expect(res.statusCode).toBe(200);
    expect(fs.readFileSync(path.join(serverPath, "config/jei-client.toml"), "utf-8")).toBe(big);
  });

  it("accepts a text near the cap whose JSON form is larger", async () => {
    const text = '"\n'.repeat(Math.floor((1024 * 1024) / 3));
    const { res } = await put("config/jei-client.toml", text);
    expect(res.statusCode).toBe(200);
  });

  it("413s a text over the cap", async () => {
    const { res } = await put("config/jei-client.toml", "x".repeat(1024 * 1024 + 1));
    expect(res.statusCode).toBe(413);
  });

  it("hides a BOM from the client and keeps it on disk", async () => {
    write("config/bom.json", "\uFEFF{ \"a\": 1 }");
    const { read, res } = await put("config/bom.json", '{ "a": 2 }');
    expect(read.text).toBe('{ "a": 1 }');
    expect(res.statusCode).toBe(200);
    expect(fs.readFileSync(path.join(serverPath, "config/bom.json"), "utf-8")).toBe(
      "\uFEFF" + '{ "a": 2 }',
    );
  });
});

describe("guessModId", () => {
  it("uses the filename only for flat files", () => {
    expect(guessModId("config/jei-client.toml")).toBe("jei");
    expect(guessModId("config/xaero/minimap/settings.json")).toBe("xaero");
    expect(guessModId("defaultconfigs/a/b.toml")).toBe("a");
    expect(guessModId("plugins/Essentials/config.yml")).toBe("Essentials");
    expect(guessModId("server.properties")).toBe("server");
  });
});
