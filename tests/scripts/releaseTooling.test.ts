import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import zlib from "zlib";

const scriptsDir = path.resolve(process.cwd(), "scripts");

interface Tooling {
  createTarGz(o: { parent: string; name: string; outFile: string; mtimeSeconds: number }): void;
  staleDistReason(root: string): string | null;
  countVulnerabilities(data: unknown): { direct: number; transitive: number };
  smokeScripts(pkg: unknown): string[];
}

async function load<K extends keyof Tooling>(rel: string, name: K): Promise<Tooling[K]> {
  const mod = (await import(pathToFileURL(path.join(scriptsDir, rel)).href)) as Tooling;
  return mod[name];
}

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "release-tool-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

interface TarEntry {
  name: string;
  type: string;
  mode: number;
  uid: number;
  mtime: number;
  data: Buffer;
}

function readTar(gz: Buffer): TarEntry[] {
  const tar = zlib.gunzipSync(gz);
  const entries: TarEntry[] = [];
  const field = (off: number, len: number): string =>
    tar.toString("utf8", off, off + len).replace(/\0[\s\S]*$/, "");
  for (let off = 0; off + 512 <= tar.length; ) {
    const block = tar.subarray(off, off + 512);
    if (block.every((b) => b === 0)) break;
    const stored = parseInt(field(off + 148, 8).trim(), 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i]!;
    expect(sum).toBe(stored);
    const size = parseInt(field(off + 124, 12), 8);
    const prefix = field(off + 345, 155);
    const name = prefix ? `${prefix}/${field(off, 100)}` : field(off, 100);
    entries.push({
      name,
      type: field(off + 156, 1),
      mode: parseInt(field(off + 100, 8), 8),
      uid: parseInt(field(off + 108, 8), 8),
      mtime: parseInt(field(off + 136, 12), 8),
      data: tar.subarray(off + 512, off + 512 + size),
    });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

describe("createTarGz", () => {
  function stage(): string {
    const parent = tmp();
    const root = path.join(parent, "pkg-1.0.0");
    fs.mkdirSync(path.join(root, "dist", "deep"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), '{"version":"1.0.0"}');
    fs.writeFileSync(path.join(root, "dist", "index.js"), "console.log(1);\n");
    fs.writeFileSync(path.join(root, "dist", "deep", "x".repeat(90) + ".js"), "x");
    fs.writeFileSync(path.join(root, "empty.txt"), "");
    return parent;
  }

  it("writes a gzip ustar archive rooted at the package directory, owned by root", async () => {
    const createTarGz = await load("lib/tar.mjs", "createTarGz");
    const parent = stage();
    const out = path.join(parent, "pkg.tar.gz");
    createTarGz({ parent, name: "pkg-1.0.0", outFile: out, mtimeSeconds: 1_700_000_000 });

    const entries = readTar(fs.readFileSync(out));
    const names = entries.map((e) => e.name);
    expect(names[0]).toBe("pkg-1.0.0/");
    expect(names).toContain("pkg-1.0.0/dist/");
    expect(names).toContain("pkg-1.0.0/dist/index.js");
    expect(names).toContain("pkg-1.0.0/empty.txt");
    expect(names).toContain(`pkg-1.0.0/dist/deep/${"x".repeat(90)}.js`);
    for (const e of entries) {
      expect(e.uid).toBe(0);
      expect(e.mtime).toBe(1_700_000_000);
    }
    const index = entries.find((e) => e.name === "pkg-1.0.0/dist/index.js")!;
    expect(index.type).toBe("0");
    expect(index.mode).toBe(0o644);
    expect(index.data.toString()).toBe("console.log(1);\n");
    expect(entries.find((e) => e.name === "pkg-1.0.0/dist/")!.mode).toBe(0o755);
  });

  it("is byte-for-byte reproducible", async () => {
    const createTarGz = await load("lib/tar.mjs", "createTarGz");
    const parent = stage();
    const a = path.join(parent, "a.tar.gz");
    const b = path.join(parent, "b.tar.gz");
    createTarGz({ parent, name: "pkg-1.0.0", mtimeSeconds: 5, outFile: a });
    createTarGz({ parent, name: "pkg-1.0.0", mtimeSeconds: 5, outFile: b });
    expect(fs.readFileSync(a).equals(fs.readFileSync(b))).toBe(true);
  });

  it("is readable by the system tar when there is one", async () => {
    try {
      execFileSync("tar", ["--version"], { stdio: "ignore" });
    } catch {
      return;
    }
    const createTarGz = await load("lib/tar.mjs", "createTarGz");
    const parent = stage();
    const out = path.join(parent, "pkg.tar.gz");
    createTarGz({ parent, name: "pkg-1.0.0", outFile: out, mtimeSeconds: 1_700_000_000 });
    const dest = path.join(parent, "x");
    fs.mkdirSync(dest);
    // Relative paths: GNU tar on Windows reads "C:" in an absolute path as a remote host.
    execFileSync("tar", ["-xzf", "pkg.tar.gz", "-C", "x", "--strip-components=1"], { cwd: parent, stdio: "ignore" });
    expect(fs.readFileSync(path.join(dest, "dist", "index.js"), "utf8")).toBe("console.log(1);\n");
  });

  it("refuses a symbolic link", async () => {
    const createTarGz = await load("lib/tar.mjs", "createTarGz");
    const parent = stage();
    try {
      fs.symlinkSync(path.join(parent, "pkg-1.0.0", "package.json"), path.join(parent, "pkg-1.0.0", "link"));
    } catch {
      return; // no symlink privilege on this host
    }
    expect(() =>
      createTarGz({ parent, name: "pkg-1.0.0", outFile: path.join(parent, "o.tgz"), mtimeSeconds: 1 }),
    ).toThrow(/symbolic link/);
  });
});

describe("staleDistReason", () => {
  function project(): string {
    const root = tmp();
    fs.mkdirSync(path.join(root, "src", "nested"), { recursive: true });
    fs.mkdirSync(path.join(root, "dist"));
    fs.writeFileSync(path.join(root, "src", "nested", "a.ts"), "");
    fs.writeFileSync(path.join(root, "dist", "index.js"), "");
    return root;
  }
  const at = (file: string, seconds: number): void => fs.utimesSync(file, seconds, seconds);

  it("accepts a build newer than every source file", async () => {
    const staleDistReason = await load("lib/freshness.mjs", "staleDistReason");
    const root = project();
    at(path.join(root, "src", "nested", "a.ts"), 1000);
    at(path.join(root, "dist", "index.js"), 2000);
    expect(staleDistReason(root)).toBeNull();
  });

  it("refuses a build older than a source file", async () => {
    const staleDistReason = await load("lib/freshness.mjs", "staleDistReason");
    const root = project();
    at(path.join(root, "dist", "index.js"), 1000);
    at(path.join(root, "src", "nested", "a.ts"), 2000);
    expect(staleDistReason(root)).toMatch(/older than src/);
  });

  it("refuses a missing build", async () => {
    const staleDistReason = await load("lib/freshness.mjs", "staleDistReason");
    const root = project();
    fs.rmSync(path.join(root, "dist"), { recursive: true });
    expect(staleDistReason(root)).toMatch(/missing/);
  });
});

describe("update-deps", () => {
  it("reads the npm 7+ audit shape", async () => {
    const count = await load("update-deps.mjs", "countVulnerabilities");
    expect(
      count({
        auditReportVersion: 2,
        vulnerabilities: {
          fastify: { name: "fastify", isDirect: true, severity: "high", via: ["x"] },
          "find-my-way": { name: "find-my-way", isDirect: false, severity: "high", via: ["y"] },
          other: { name: "other", isDirect: false, severity: "low", via: ["z"] },
        },
        metadata: { vulnerabilities: { low: 1, moderate: 0, high: 2, critical: 0, total: 3 } },
      }),
    ).toEqual({ direct: 1, transitive: 2 });
    expect(count({ vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } })).toEqual({
      direct: 0,
      transitive: 0,
    });
  });

  it("still reads the advisories shape and the bare counts", async () => {
    const count = await load("update-deps.mjs", "countVulnerabilities");
    expect(
      count({ advisories: { 1: { findings: [{ paths: ["a"] }] }, 2: { findings: [{ paths: ["a>b"] }] } } }),
    ).toEqual({ direct: 1, transitive: 1 });
    expect(count({ metadata: { vulnerabilities: { low: 1, moderate: 2, high: 0, critical: 1 } } })).toEqual({
      direct: 0,
      transitive: 4,
    });
    expect(count({})).toEqual({ direct: 0, transitive: 0 });
  });

  it("smoke-tests build then test, never dev or start", async () => {
    const smokeScripts = await load("update-deps.mjs", "smokeScripts");
    expect(smokeScripts({ scripts: { dev: "tsc --watch", start: "node .", test: "vitest", build: "tsc" } })).toEqual([
      "build",
      "test",
    ]);
    expect(smokeScripts({ scripts: { dev: "x" } })).toEqual([]);
    expect(smokeScripts({})).toEqual([]);
  });
});
