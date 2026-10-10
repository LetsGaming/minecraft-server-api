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
 * — take a relative path, `resolve` it, check `startsWith` — is a guard that
 * has to be written correctly every time and still cannot see a symlink planted
 * inside `config/`. Both walls are here: the id must resolve against a listing
 * this module just built, and the realpath must still be inside a root.
 *
 * Snapshots exist because a config file is the only copy of a decision someone
 * made. Every write copies the previous contents aside first, so a bad edit is
 * one click away from being undone rather than a restore from backup.
 */
import { createHash } from "crypto";
import type { Dirent } from "fs";
import fsp from "fs/promises";
import path from "path";

import type { InstanceConfig } from "../config/types.js";

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
      if (root === "") {
        const realServer = await fsp.realpath(serverPath);
        if (realFile !== path.join(realServer, info.relPath)) return null;
      } else {
        const realRoot = await fsp.realpath(path.join(serverPath, root));
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
    const { text } = stripBom(await fsp.readFile(found.absPath, "utf-8"));
    return { text, etag: etagOf(text), info: found.info };
  }

  function snapshotDir(id: string): string {
    return path.join(cfg.serverPath, ".mcbot-config-snapshots", id);
  }

  async function snapshot(id: string, text: string): Promise<string> {
    const dir = snapshotDir(id);
    await fsp.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await fsp.writeFile(path.join(dir, stamp), text, "utf-8");

    // Keep the last N, oldest pruned. Timestamps sort lexically.
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
  async function write(
    id: string,
    text: string,
    ifMatch: string,
  ): Promise<
    | { ok: true; etag: string; snapshot: string }
    | { ok: false; reason: "not-found" | "conflict" | "too-large" }
  > {
    if (Buffer.byteLength(text, "utf-8") > MAX_CONFIG_BYTES) {
      return { ok: false, reason: "too-large" };
    }
    const found = await resolve(id);
    if (!found) return { ok: false, reason: "not-found" };
    if (found.info.tooLarge) return { ok: false, reason: "too-large" };

    const raw = await fsp.readFile(found.absPath, "utf-8");
    const current = stripBom(raw);
    if (etagOf(current.text) !== ifMatch) return { ok: false, reason: "conflict" };

    const stamp = await snapshot(id, raw);
    await fsp.writeFile(
      found.absPath,
      current.bom ? UTF8_BOM + text : text,
      "utf-8",
    );
    invalidate();
    return { ok: true, etag: etagOf(text), snapshot: stamp };
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
  ): Promise<{ ok: true; etag: string } | { ok: false; reason: string }> {
    // The stamp comes from a client, so it is validated rather than trusted —
    // it is the one string here that is not an opaque handle.
    if (!/^[\dTZ-]{1,40}$/.test(stamp)) return { ok: false, reason: "bad-snapshot" };
    const found = await resolve(id);
    if (!found) return { ok: false, reason: "not-found" };

    const file = path.join(snapshotDir(id), stamp);
    let text: string;
    try {
      text = await fsp.readFile(file, "utf-8");
    } catch {
      return { ok: false, reason: "no-such-snapshot" };
    }

    // Reverting is itself a change worth being able to undo.
    await snapshot(id, await fsp.readFile(found.absPath, "utf-8"));
    await fsp.writeFile(found.absPath, text, "utf-8");
    invalidate();
    return { ok: true, etag: etagOf(stripBom(text).text) };
  }

  return { index, resolve, read, write, listSnapshots, revert };
}
