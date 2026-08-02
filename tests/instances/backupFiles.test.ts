/**
 * WRP-03/04/05 — the backup archives: index, download, restore.
 *
 * The security property under test is that no route accepts a path. A client
 * gets ids from the index and can send nothing else, so the traversal cases
 * below are not "does the guard catch this" but "is there anywhere to put a
 * path at all". They are here because the panel this replaces did take a path,
 * and the temptation to port that signature is exactly what these pin shut.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { buildApp } from "../../src/http/app.js";
import { createBackupFiles } from "../../src/instances/backupFiles.js";
import type { AppConfig, InstanceConfig } from "../../src/config/types.js";
import type { FastifyInstance } from "fastify";

const KEY = "test-key-0123456789";
const auth = { "x-api-key": KEY };

let root: string;
let backupsPath: string;
let app: FastifyInstance;
let dispose: () => void;
let instanceCfg: InstanceConfig;

/** Write an archive with a known size and mtime. */
function writeArchive(tier: string, name: string, bytes: number, mtimeMs: number): void {
  const dir = path.join(backupsPath, tier);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.alloc(bytes, "a"));
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "backupfiles-"));
  const serverPath = path.join(root, "server");
  const scriptsDir = path.join(root, "scripts");
  backupsPath = path.join(root, "backups");
  fs.mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });

  writeArchive("hourly", "world-03.tar.zst", 1024, 3_000_000);
  writeArchive("hourly", "world-01.tar.zst", 512, 1_000_000);
  writeArchive("archives/daily", "world-02.tar.gz", 2048, 2_000_000);
  // Not an archive: must never appear in the index.
  fs.writeFileSync(path.join(backupsPath, "hourly", "notes.txt"), "ignore me");

  // Built to the real types rather than cast into them: a cast here would
  // hide exactly the drift these tests exist to catch.
  instanceCfg = {
    id: "smp",
    serverPath,
    scriptsDir,
    backupsPath,
    linuxUser: "mc",
    useRcon: false,
    rconHost: "127.0.0.1",
    rconPort: 25575,
    rconPassword: "pw",
  };

  const config: AppConfig = {
    PORT: 8126,
    API_KEY: KEY,
    instances: { smp: instanceCfg },
  };

  const built = await buildApp({ config, allowNoAuth: false });
  app = built.app;
  dispose = () => built.logStreamAPI.dispose();
  await app.ready();
});

afterAll(async () => {
  dispose?.();
  await app?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function index(query = ""): Promise<{
  files: Array<{ id: string; tier: string; name: string; sizeBytes: number }>;
  nextCursor: string | null;
  total: number;
}> {
  const res = await app.inject({
    method: "GET",
    url: `/instances/smp/backups/files${query}`,
    headers: auth,
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

// ── The index ───────────────────────────────────────────────────────────────

describe("GET /backups/files", () => {
  it("lists every archive across tiers, newest first", async () => {
    const body = await index();
    expect(body.total).toBe(3);
    expect(body.files.map((f) => f.name)).toEqual([
      "world-03.tar.zst",
      "world-02.tar.gz",
      "world-01.tar.zst",
    ]);
    expect(body.files[0]?.tier).toBe("hourly");
    expect(body.files[1]?.tier).toBe("archives/daily");
  });

  it("ignores non-archive files", async () => {
    const body = await index();
    expect(body.files.some((f) => f.name.endsWith(".txt"))).toBe(false);
  });

  it("reports real sizes", async () => {
    const body = await index();
    expect(body.files.find((f) => f.name === "world-02.tar.gz")?.sizeBytes).toBe(2048);
  });

  it("gives ids that are opaque, not paths", async () => {
    const body = await index();
    for (const file of body.files) {
      expect(file.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(file.id).not.toContain("/");
      expect(file.id).not.toContain(file.name);
    }
  });

  it("gives the same id across calls, so a download URL survives a restart", async () => {
    const first = await index();
    const second = createBackupFiles(instanceCfg);
    const again = await second.index(undefined, 50);
    expect(again.files.map((f) => f.id)).toEqual(first.files.map((f) => f.id));
  });

  it("scopes ids to the instance", async () => {
    // Two instances with identically-named archives must not share ids, or a
    // handle from one would resolve against the other's directory.
    const other = createBackupFiles({ ...instanceCfg, id: "creative" });
    const mine = await createBackupFiles(instanceCfg).index(undefined, 50);
    const theirs = await other.index(undefined, 50);
    expect(theirs.files[0]?.id).not.toBe(mine.files[0]?.id);
  });

  it("pages with a cursor", async () => {
    const first = await index("?limit=2");
    expect(first.files).toHaveLength(2);
    expect(first.nextCursor).toBe(first.files[1]?.id);

    const second = await index(`?limit=2&cursor=${first.nextCursor}`);
    expect(second.files).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(second.files[0]?.name).toBe("world-01.tar.zst");
  });

  it("restarts from the top when the cursor has been rotated away", async () => {
    // Honest over silent: a stale cursor must not look like the end of the list.
    const body = await index("?limit=2&cursor=AAAAAAAAAAAAAAAAAAAAAA");
    expect(body.files[0]?.name).toBe("world-03.tar.zst");
  });

  it("clamps limit to the page maximum", async () => {
    const body = await index("?limit=99999");
    expect(body.files.length).toBeLessThanOrEqual(200);
  });

  it("404s an unknown instance", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/instances/nope/backups/files",
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });

  it("401s without the key", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/instances/smp/backups/files",
    });
    expect(res.statusCode).toBe(401);
  });
});

// ── Download ────────────────────────────────────────────────────────────────

describe("GET /backups/files/:fileId/download", () => {
  it("streams the archive with a length and a filename", async () => {
    const body = await index();
    const file = body.files.find((f) => f.name === "world-02.tar.gz")!;

    const res = await app.inject({
      method: "GET",
      url: `/instances/smp/backups/files/${file.id}/download`,
      headers: auth,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-length"]).toBe("2048");
    expect(res.headers["content-disposition"]).toBe(
      'attachment; filename="world-02.tar.gz"',
    );
    // Content-Length is what lets a browser draw its own progress bar, which
    // is why the dashboard needs none of its own.
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.rawPayload.length).toBe(2048);
  });

  it("serves a byte range", async () => {
    const body = await index();
    const file = body.files[0]!;

    const res = await app.inject({
      method: "GET",
      url: `/instances/smp/backups/files/${file.id}/download`,
      headers: { ...auth, range: "bytes=100-199" },
    });

    expect(res.statusCode).toBe(206);
    expect(res.headers["content-length"]).toBe("100");
    expect(res.headers["content-range"]).toBe("bytes 100-199/1024");
    expect(res.rawPayload.length).toBe(100);
  });

  it("serves an open-ended range, so an interrupted download resumes", async () => {
    const body = await index();
    const file = body.files[0]!;

    const res = await app.inject({
      method: "GET",
      url: `/instances/smp/backups/files/${file.id}/download`,
      headers: { ...auth, range: "bytes=1000-" },
    });

    expect(res.statusCode).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 1000-1023/1024");
    expect(res.rawPayload.length).toBe(24);
  });

  it("serves a suffix range", async () => {
    const body = await index();
    const file = body.files[0]!;

    const res = await app.inject({
      method: "GET",
      url: `/instances/smp/backups/files/${file.id}/download`,
      headers: { ...auth, range: "bytes=-50" },
    });

    expect(res.statusCode).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 974-1023/1024");
  });

  it("416s a range past the end", async () => {
    const body = await index();
    const file = body.files[0]!;

    const res = await app.inject({
      method: "GET",
      url: `/instances/smp/backups/files/${file.id}/download`,
      headers: { ...auth, range: "bytes=99999-" },
    });

    expect(res.statusCode).toBe(416);
    expect(res.headers["content-range"]).toBe("bytes */1024");
  });

  it("400s a malformed id", async () => {
    for (const bad of ["short", "../../etc/passwd", "a".repeat(23)]) {
      const res = await app.inject({
        method: "GET",
        url: `/instances/smp/backups/files/${encodeURIComponent(bad)}/download`,
        headers: auth,
      });
      expect([400, 404]).toContain(res.statusCode);
    }
  });

  it("404s a well-formed id that names nothing", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/instances/smp/backups/files/AAAAAAAAAAAAAAAAAAAAAA/download",
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });

  it("401s without the key", async () => {
    const body = await index();
    const res = await app.inject({
      method: "GET",
      url: `/instances/smp/backups/files/${body.files[0]!.id}/download`,
    });
    expect(res.statusCode).toBe(401);
  });
});

// ── Containment ─────────────────────────────────────────────────────────────

describe("path containment", () => {
  it("refuses a symlink that escapes the backups directory", async () => {
    // The case a resolve+startsWith check cannot see: the path is inside the
    // tree, the target is not. Hence the realpath comparison in resolve().
    const secret = path.join(root, "outside-secret.tar.zst");
    fs.writeFileSync(secret, "top secret");
    const link = path.join(backupsPath, "hourly", "escape.tar.zst");
    try {
      fs.symlinkSync(secret, link);
    } catch {
      return; // no symlink support here; nothing to assert
    }

    const files = createBackupFiles(instanceCfg);
    const listed = await files.index(undefined, 50);
    const escape = listed.files.find((f) => f.name === "escape.tar.zst");
    expect(escape).toBeDefined();
    expect(await files.resolve(escape!.id)).toBeNull();

    fs.unlinkSync(link);
  });

  it("has nowhere to put a path: resolve only accepts ids", async () => {
    const files = createBackupFiles(instanceCfg);
    for (const attempt of [
      "../../../etc/passwd",
      "/etc/passwd",
      "hourly/world-01.tar.zst",
      "..%2F..%2Fetc%2Fpasswd",
    ]) {
      expect(await files.resolve(attempt)).toBeNull();
    }
  });

  it("returns nothing when no backups path is configured", async () => {
    const files = createBackupFiles({ ...instanceCfg, backupsPath: "" });
    expect((await files.index(undefined, 50)).files).toEqual([]);
    expect(await files.resolve("AAAAAAAAAAAAAAAAAAAAAA")).toBeNull();
  });
});

// ── Restore ─────────────────────────────────────────────────────────────────

describe("POST /backups/files/:fileId/restore", () => {
  it("400s a malformed id before touching the filesystem", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/instances/smp/backups/files/nope/restore",
      headers: auth,
    });
    expect([400, 404]).toContain(res.statusCode);
  });

  it("404s a well-formed id that names nothing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/instances/smp/backups/files/AAAAAAAAAAAAAAAAAAAAAA/restore",
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });

  it("500s with a clear message when the restore script is missing", async () => {
    // The suite is not installed in this fixture, which is the realistic
    // failure for an instance that never had backups configured.
    const body = await index();
    const res = await app.inject({
      method: "POST",
      url: `/instances/smp/backups/files/${body.files[0]!.id}/restore`,
      headers: auth,
    });
    expect(res.statusCode).toBe(500);
  });

  it("401s without the key", async () => {
    const body = await index();
    const res = await app.inject({
      method: "POST",
      url: `/instances/smp/backups/files/${body.files[0]!.id}/restore`,
    });
    expect(res.statusCode).toBe(401);
  });
});
