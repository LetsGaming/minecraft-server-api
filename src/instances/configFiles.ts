/**
 * Mod config files: finding them, reading them, writing them back.
 *
 * The addressing rule is the same one the backup routes use, for the same
 * reason: **no route accepts a path**. A client gets an opaque `id` from the
 * index and can send nothing else, so the path handed to `readFile` is one
 * this process chose from a directory it chose. Traversal is not defended
 * against here, it is unrepresentable.
 *
 * That matters more here than for backups. Backups live in one directory with
 * one extension; mod configs are spread across four roots, and the naive design
 *, take a relative path, `resolve` it, check `startsWith`, is a guard that
 * has to be written correctly every time and still cannot see a symlink planted
 * inside `config/`. Both walls are here: the id must resolve against a listing
 * this module just built, and the realpath must still be inside a root.
 *
 * Snapshots exist because a config file is the only copy of a decision someone
 * made. Every write copies the previous contents aside first, so a bad edit is
 * one click away from being undone rather than a restore from backup.
 */
import { createHash, randomBytes } from "crypto";
import { constants, type Dirent } from "fs";
import fsp from "fs/promises";
import path from "path";

import type { InstanceConfig } from "../config/types.js";
import { FileTooLargeError, isInside, readFileNoFollow } from "../platform/safeFs.js";
import {
  changedProtectedKeys,
  redactSecrets,
  restoreSecrets,
} from "./configSecrets.js";

/**
 * Directories a config file may live in, relative to the server directory.
 *
 * Deliberately a list of roots rather than "anything under serverPath": the
 * server directory also holds the world, the jar, and `ops.json`. An editor
 * that can reach those is a remote shell with extra steps.
 */
const CONFIG_ROOTS = [
  "config",
  "defaultconfigs",
  "world/serverconfig",
  "plugins",
] as const;

/** Files at the top of the server directory that are worth editing. */
const ROOT_FILES = ["server.properties"] as const;

/**
 * Text file types listed in the index, mapped to the `format` the client sees.
 * The wrapper never parses these; the format name only tells the client which
 * editor to offer. Anything not listed here is not a config file.
 */
const FORMAT_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".toml": "toml",
  ".json": "json",
  ".json5": "json5",
  ".properties": "properties",
  ".cfg": "cfg",
  ".conf": "conf",
  ".ini": "ini",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".txt": "text",
  ".snbt": "snbt",
};

/** Refuse anything larger. A mod config is kilobytes; megabytes means data. */
export const MAX_CONFIG_BYTES = 1024 * 1024;

/** How deep to walk inside a root (the root's own children are depth 1). */
const MAX_DEPTH = 8;

/** Entries in one index. Past this the listing is cut and flagged `truncated`. */
export const MAX_FILES = 2000;

/** Directory names never descended into: caches, backups, logs, VCS data. */
const IGNORED_DIRS: ReadonlySet<string> = new Set([
  "cache",
  ".cache",
  "backups",
  "backup",
  "logs",
  "log",
  ".git",
  "node_modules",
  "crash-reports",
  "tmp",
  "temp",
  ".mcbot-config-snapshots",
]);

/** How long an index is reused before the tree is walked again. */
const INDEX_TTL_MS = 5000;

const UTF8_BOM = "﻿";

/** Snapshots kept per file before a write. */
const MAX_SNAPSHOTS = 10;

export interface WriteOptions {
  /**
   * May protected `server.properties` keys change (W-006)? The bot sends
   * this for sysadmins only.
   */
  allowProtected?: boolean;
}

export interface ConfigFileInfo {
  /** Opaque handle; the only file reference a client may send back. */
  id: string;
  /** Display path relative to the server directory. */
  relPath: string;
  /** Best guess at the owning mod, from the filename or its directory. */
  modId: string;
  format: string;
  /** False when the file is listed but cannot be read or written (too large). */
  editable: boolean;
  tooLarge: boolean;
  sizeBytes: number;
  mtimeMs: number;
}

/**
 * Read a config file without following a final symlink (W-007, see
 * safeFs.ts). The cap leaves room for a BOM; a file grown past
 * {@link MAX_CONFIG_BYTES} since it was indexed throws FileTooLargeError.
 */
async function readNoFollow(absPath: string): Promise<string> {
  return (await readFileNoFollow(absPath, MAX_CONFIG_BYTES + 3)).toString("utf-8");
}

/**
 * Replace a file's contents (W-011). When the file is ours, the new text goes
 * to a temp file that is synced and renamed over it, so a reader or a crash
 * sees the old file or the new one, never half of one. A file owned by the
 * instance user can't be replaced that way without handing it to `apiuser`
 * (the server could no longer save it), so it is overwritten in place: the
 * new text is written over the old before the length is cut, which never
 * leaves it empty, and synced.
 */
async function replaceContents(absPath: string, text: string): Promise<void> {
  const fh = await fsp.open(absPath, constants.O_RDWR | constants.O_NOFOLLOW);
  let replaced = false;
  try {
    const stat = await fh.stat();
    if (!stat.isFile()) throw new Error("not a regular file");
    if (typeof process.getuid === "function" && stat.uid === process.getuid()) {
      const tmp = path.join(
        path.dirname(absPath),
        `.${path.basename(absPath)}.${randomBytes(6).toString("hex")}.tmp`,
      );
      try {
        const out = await fsp.open(tmp, "wx", stat.mode & 0o7777);
        try {
          await out.writeFile(text, "utf-8");
          await out.sync();
        } finally {
          await out.close();
        }
        await fsp.rename(tmp, absPath);
        replaced = true;
      } catch {
        await fsp.rm(tmp, { force: true }).catch(() => {});
      }
    }
    if (!replaced) {
      const data = Buffer.from(text, "utf-8");
      await fh.write(data, 0, data.length, 0);
      await fh.truncate(data.length);
      await fh.sync();
    }
  } finally {
    await fh.close();
  }
}

export interface ConfigIndex {
  files: ConfigFileInfo[];
  /** The walk stopped at {@link MAX_FILES}; some files are not listed. */
  truncated: boolean;
}

function fileId(instanceId: string, relPath: string): string {
  return createHash("sha256")
    .update(`cfg\0${instanceId}\0${relPath}`)
    .digest("base64url")
    .slice(0, 22);
}

function extensionOf(name: string): string {
  const lower = name.toLowerCase();
  return Object.keys(FORMAT_BY_EXTENSION).find((e) => lower.endsWith(e)) ?? "";
}

/** Directories whose first level below the root names the owning mod. */
const NESTED_MOD_ROOTS: ReadonlySet<string> = new Set([
  "config",
  "defaultconfigs",
  "world",
]);

function stripBom(text: string): { text: string; bom: boolean } {
  return text.startsWith(UTF8_BOM)
    ? { text: text.slice(1), bom: true }
    : { text, bom: false };
}

/**
 * Which mod a file belongs to, as well as a path can say.
 *
 * `config/jei-client.toml` is jei; `config/xaero/minimap/settings.json` and
 * `plugins/EssentialsX/config.yml` are xaero and EssentialsX, because the first
 * directory below the root is the mod's own folder. Only flat files fall back to
 * the filename. It is a grouping hint for the UI, not an identity.
 */
export function guessModId(relPath: string): string {
  const parts = relPath.split("/");
  if (parts.length >= 3 && parts[0] === "plugins") return parts[1]!;
  if (parts.length >= 3 && NESTED_MOD_ROOTS.has(parts[0]!)) {
    const underRoot = parts[0] === "world" ? parts.slice(2) : parts.slice(1);
    if (underRoot.length >= 2) return underRoot[0]!;
  }
  const base = parts[parts.length - 1]!.replace(/\.[^.]+$/, "");
  return base.split(/[-.]/)[0] || base;
}

export function createConfigFiles(cfg: InstanceConfig) {
  const serverPath = cfg.serverPath;

  /** One write or revert per file at a time (W-011). */
  const fileLocks = new Map<string, Promise<unknown>>();
  function withFileLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = fileLocks.get(id) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    fileLocks.set(id, tail);
    void tail.then(() => {
      if (fileLocks.get(id) === tail) fileLocks.delete(id);
    });
    return run;
  }

  /** The config root a listed path lives under, or "" for a top-level file. */
  function rootOf(relPath: string): string {
    return CONFIG_ROOTS.find((r) => relPath.startsWith(`${r}/`)) ?? "";
  }

  /**
   * Walks one root. A symlinked directory or file is followed only when its
   * realpath stays inside the root's own realpath; the visited set stops cycles.
   */
  async function walkRoot(
    root: string,
    budget: { left: number; truncated: boolean },
  ): Promise<string[]> {
    let realRoot: string;
    try {
      realRoot = await fsp.realpath(path.join(serverPath, root));
      // W-007: a root that is itself a link out of the server directory
      // (`plugins` -> the wrapper's own folder) is not a root at all.
      if (!isInside(realRoot, await fsp.realpath(serverPath))) return [];
    } catch {
      return []; // root not present on this instance
    }
    const visited = new Set<string>([realRoot]);
    const found: string[] = [];

    const inside = (real: string): boolean =>
      real === realRoot || real.startsWith(realRoot + path.sep);

    async function walk(rel: string, depth: number): Promise<void> {
      if (depth > MAX_DEPTH || budget.truncated) return;
      let entries: Dirent[];
      try {
        entries = await fsp.readdir(path.join(serverPath, rel), {
          withFileTypes: true,
        });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));

      for (const entry of entries) {
        if (budget.truncated) return;
        const childRel = `${rel}/${entry.name}`;
        let isDir = entry.isDirectory();
        let isFile = entry.isFile();

        if (entry.isSymbolicLink()) {
          try {
            const real = await fsp.realpath(path.join(serverPath, childRel));
            if (!inside(real)) continue;
            const stat = await fsp.stat(real);
            isDir = stat.isDirectory();
            isFile = stat.isFile();
            if (isDir) {
              if (visited.has(real)) continue;
              visited.add(real);
            }
          } catch {
            continue;
          }
        }

        if (isDir) {
          if (IGNORED_DIRS.has(entry.name.toLowerCase())) continue;
          await walk(childRel, depth + 1);
        } else if (isFile && extensionOf(entry.name)) {
          if (budget.left <= 0) {
            budget.truncated = true;
            return;
          }
          budget.left -= 1;
          found.push(childRel);
        }
      }
    }

    await walk(root, 1);
    return found;
  }

  async function describe(relPath: string): Promise<ConfigFileInfo | null> {
    try {
      const stat = await fsp.stat(path.join(serverPath, relPath));
      if (!stat.isFile()) return null;
      const tooLarge = stat.size > MAX_CONFIG_BYTES;
      return {
        id: fileId(cfg.id, relPath),
        relPath,
        modId: guessModId(relPath),
        format: FORMAT_BY_EXTENSION[extensionOf(relPath)] ?? "text",
        editable: !tooLarge,
        tooLarge,
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
      };
    } catch {
      return null; // vanished between walk and stat
    }
  }

  let cached: { at: number; value: ConfigIndex } | null = null;

  async function buildIndex(): Promise<ConfigIndex> {
    const budget = { left: MAX_FILES, truncated: false };
    const rootFiles: string[] = [];
    for (const name of ROOT_FILES) {
      try {
        const stat = await fsp.stat(path.join(serverPath, name));
        if (stat.isFile()) rootFiles.push(name);
      } catch {
        /* not present */
      }
    }

    const perRoot: string[][] = [];
    for (const root of CONFIG_ROOTS) {
      perRoot.push(await walkRoot(root, budget));
    }

    const all = [...rootFiles, ...perRoot.flat()];
    const infos = await Promise.all(all.map(describe));
    const files = infos
      .filter((f): f is ConfigFileInfo => f !== null)
      .sort(
        (a, b) =>
          a.modId.localeCompare(b.modId) || a.relPath.localeCompare(b.relPath),
      );
    return { files, truncated: budget.truncated };
  }

  /** Every config text file, sorted by mod then path. Reused for a few seconds. */
  async function index(): Promise<ConfigIndex> {
    if (cached && Date.now() - cached.at < INDEX_TTL_MS) return cached.value;
    const value = await buildIndex();
    cached = { at: Date.now(), value };
    return value;
  }

  function invalidate(): void {
    cached = null;
  }

  /**
   * Resolve an id to an absolute path, or null.
   *
   * Two independent walls: the id must appear in an index this module built (so
   * the path is one we chose), and the realpath must still be inside the same
   * root the walker accepted it from (so a symlink planted in `config/` cannot
   * point at `/etc` or at the world).
   */
  async function resolve(
    id: string,
  ): Promise<{ absPath: string; info: ConfigFileInfo } | null> {
    const info = (await index()).files.find((f) => f.id === id);
    if (!info) return null;

    const absPath = path.join(serverPath, info.relPath);
    const root = rootOf(info.relPath);
    try {
      const realFile = await fsp.realpath(absPath);
      const realServer = await fsp.realpath(serverPath);
      if (root === "") {
        if (realFile !== path.join(realServer, info.relPath)) return null;
      } else {
        const realRoot = await fsp.realpath(path.join(serverPath, root));
        if (!isInside(realRoot, realServer)) return null; // W-007
        if (!realFile.startsWith(realRoot + path.sep)) return null;
      }
      return { absPath: realFile, info };
    } catch {
      return null;
    }
  }

  /** Weak ETag over the contents, for optimistic concurrency on write. */
  function etagOf(text: string): string {
    return createHash("sha256").update(text).digest("base64url").slice(0, 27);
  }

  async function read(
    id: string,
  ): Promise<
    | { text: string; etag: string; info: ConfigFileInfo }
    | { tooLarge: true; info: ConfigFileInfo }
    | null
  > {
    const found = await resolve(id);
    if (!found) return null;
    if (found.info.tooLarge) return { tooLarge: true as const, info: found.info };
    let raw: string;
    try {
      raw = await readNoFollow(found.absPath);
    } catch (err) {
      if (err instanceof FileTooLargeError) return { tooLarge: true as const, info: found.info };
      throw err;
    }
    const { text } = stripBom(raw);
    // The etag is over the real contents; the client sees secrets redacted
    // (W-006) and gets them restored when it writes the text back.
    return { text: redactSecrets(text, found.info.format), etag: etagOf(text), info: found.info };
  }

  function snapshotDir(id: string): string {
    return path.join(cfg.serverPath, ".mcbot-config-snapshots", id);
  }

  /**
   * Create `dir` if missing and prove it is a real directory inside the
   * server directory, not a symlink planted to redirect our writes and the
   * pruning `rm` below somewhere `apiuser` can write (W-007).
   */
  async function ensureRealDir(dir: string): Promise<void> {
    try {
      await fsp.mkdir(dir, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const st = await fsp.lstat(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) {
      throw new Error(`snapshot directory is not a plain directory: ${dir}`);
    }
    const realServer = await fsp.realpath(serverPath);
    if (!isInside(await fsp.realpath(dir), realServer)) {
      throw new Error(`snapshot directory leaves the server directory: ${dir}`);
    }
  }

  async function snapshot(id: string, text: string): Promise<string> {
    const dir = snapshotDir(id);
    await ensureRealDir(path.dirname(dir));
    await ensureRealDir(dir);
    const base = new Date().toISOString().replace(/[:.]/g, "-");
    // `wx` refuses an existing name, so a planted link is never written
    // through. Two snapshots in one millisecond get a numeric suffix.
    let stamp = base;
    for (let i = 1; ; i++) {
      try {
        await fsp.writeFile(path.join(dir, stamp), text, {
          encoding: "utf-8",
          flag: "wx",
          mode: 0o600,
        });
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST" || i > 50) throw err;
        stamp = `${base}-${i}`;
      }
    }

    // Keep the last N, oldest pruned. Timestamps sort lexically. rm on a
    // link removes the link, never what it points at.
    const kept = (await fsp.readdir(dir)).sort();
    for (const old of kept.slice(0, Math.max(0, kept.length - MAX_SNAPSHOTS))) {
      await fsp.rm(path.join(dir, old), { force: true });
    }
    return stamp;
  }

  /**
   * Write, but only if the file still looks the way the caller last saw it.
   *
   * `ifMatch` is not optional. Two admins with the same page open would
   * otherwise silently overwrite each other, and more likely in practice,
   * many mods rewrite their own config at shutdown, so an edit made while the
   * server was running can land on top of a file the game has since replaced.
   * A UTF-8 BOM is hidden from the client and restored on write.
   */
  /**
   * W-006: a change to a protected `server.properties` key needs the
   * caller's explicit say-so. Returns the keys that block the write.
   */
  function blockedKeys(
    relPath: string,
    before: string,
    after: string,
    allowProtected: boolean,
  ): string[] {
    if (allowProtected || relPath !== "server.properties") return [];
    return changedProtectedKeys(before, after);
  }

  async function write(
    id: string,
    submitted: string,
    ifMatch: string,
    { allowProtected = false }: WriteOptions = {},
  ): Promise<
    | { ok: true; etag: string; snapshot: string }
    | { ok: false; reason: "not-found" | "conflict" | "too-large" | "redacted" }
    | { ok: false; reason: "protected"; keys: string[] }
  > {
    if (Buffer.byteLength(submitted, "utf-8") > MAX_CONFIG_BYTES) {
      return { ok: false, reason: "too-large" };
    }
    return withFileLock(id, async () => {
      const found = await resolve(id);
      if (!found) return { ok: false as const, reason: "not-found" as const };
      if (found.info.tooLarge) return { ok: false as const, reason: "too-large" as const };

      let raw: string;
      try {
        raw = await readNoFollow(found.absPath);
      } catch (err) {
        if (err instanceof FileTooLargeError) return { ok: false as const, reason: "too-large" as const };
        throw err;
      }
      const current = stripBom(raw);
      if (etagOf(current.text) !== ifMatch) {
        return { ok: false as const, reason: "conflict" as const };
      }
      const text = restoreSecrets(submitted, current.text, found.info.format);
      if (text === null) return { ok: false as const, reason: "redacted" as const };
      const keys = blockedKeys(found.info.relPath, current.text, text, allowProtected);
      if (keys.length > 0) return { ok: false as const, reason: "protected" as const, keys };

      const stamp = await snapshot(id, raw);
      await replaceContents(found.absPath, current.bom ? UTF8_BOM + text : text);
      invalidate();
      return { ok: true as const, etag: etagOf(text), snapshot: stamp };
    });
  }

  async function listSnapshots(id: string): Promise<string[]> {
    try {
      return (await fsp.readdir(snapshotDir(id))).sort().reverse();
    } catch {
      return [];
    }
  }

  async function revert(
    id: string,
    stamp: string,
    ifMatch: string,
    { allowProtected = false }: WriteOptions = {},
  ): Promise<
    | { ok: true; etag: string }
    | {
        ok: false;
        reason: "bad-snapshot" | "not-found" | "no-such-snapshot" | "conflict" | "too-large";
      }
    | { ok: false; reason: "protected"; keys: string[] }
  > {
    // The stamp comes from a client, so it is validated rather than trusted.
    // it is the one string here that is not an opaque handle.
    if (!/^[\dTZ-]{1,40}$/.test(stamp)) return { ok: false, reason: "bad-snapshot" };
    return withFileLock(id, async () => {
      const found = await resolve(id);
      if (!found) return { ok: false as const, reason: "not-found" as const };

      let text: string;
      try {
        text = await readNoFollow(path.join(snapshotDir(id), stamp));
      } catch {
        return { ok: false as const, reason: "no-such-snapshot" as const };
      }

      let raw: string;
      try {
        raw = await readNoFollow(found.absPath);
      } catch (err) {
        if (err instanceof FileTooLargeError) return { ok: false as const, reason: "too-large" as const };
        throw err;
      }
      const current = stripBom(raw).text;
      // W-011: a revert replaces the whole file, so it needs the same proof
      // as a write that the caller saw the version it is replacing.
      if (etagOf(current) !== ifMatch) return { ok: false as const, reason: "conflict" as const };
      const keys = blockedKeys(found.info.relPath, current, stripBom(text).text, allowProtected);
      if (keys.length > 0) return { ok: false as const, reason: "protected" as const, keys };

      // Reverting is itself a change worth being able to undo.
      await snapshot(id, raw);
      await replaceContents(found.absPath, text);
      invalidate();
      return { ok: true as const, etag: etagOf(stripBom(text).text) };
    });
  }

  return { index, resolve, read, write, listSnapshots, revert };
}
