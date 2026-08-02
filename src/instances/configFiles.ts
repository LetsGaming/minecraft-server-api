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

const EDITABLE_EXTENSIONS = [".toml", ".json", ".json5", ".properties"] as const;

/** Refuse anything larger. A mod config is kilobytes; megabytes means data. */
export const MAX_CONFIG_BYTES = 1024 * 1024;

/** How deep to walk inside a root. Enough for `plugins/<Mod>/config.toml`. */
const MAX_DEPTH = 3;

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
  sizeBytes: number;
  mtimeMs: number;
}

function fileId(instanceId: string, relPath: string): string {
  return createHash("sha256")
    .update(`cfg\0${instanceId}\0${relPath}`)
    .digest("base64url")
    .slice(0, 22);
}

function extensionOf(name: string): string {
  const lower = name.toLowerCase();
  const match = EDITABLE_EXTENSIONS.find((e) => lower.endsWith(e));
  return match ?? "";
}

/**
 * Which mod a file belongs to, as well as a filename can say.
 *
 * `config/jei-client.toml` → jei. `plugins/EssentialsX/config.yml` →
 * EssentialsX. It is a grouping hint for the UI, not an identity — nothing
 * depends on it being right.
 */
function guessModId(relPath: string): string {
  const parts = relPath.split("/");
  if (parts.length >= 3 && parts[0] === "plugins") return parts[1]!;
  const base = parts[parts.length - 1]!.replace(/\.[^.]+$/, "");
  return base.split(/[-.]/)[0] || base;
}

export function createConfigFiles(cfg: InstanceConfig) {
  const serverPath = cfg.serverPath;

  async function walk(rel: string, depth: number): Promise<string[]> {
    if (depth > MAX_DEPTH) return [];
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(path.join(serverPath, rel), {
        withFileTypes: true,
      });
    } catch {
      return []; // root not present on this instance
    }

    const found: string[] = [];
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        found.push(...(await walk(childRel, depth + 1)));
      } else if (entry.isFile() && extensionOf(entry.name)) {
        found.push(childRel);
      }
      // Symlinks are neither followed nor listed: isDirectory()/isFile() are
      // false for them with withFileTypes, so they simply never appear.
    }
    return found;
  }

  /** Every editable config file, sorted by mod then path. */
  async function index(): Promise<ConfigFileInfo[]> {
    const perRoot = await Promise.all(CONFIG_ROOTS.map((r) => walk(r, 1)));
    const rootFiles: string[] = [];
    for (const name of ROOT_FILES) {
      try {
        const stat = await fsp.stat(path.join(serverPath, name));
        if (stat.isFile()) rootFiles.push(name);
      } catch {
        /* not present */
      }
    }

    const all = [...rootFiles, ...perRoot.flat()];
    const infos = await Promise.all(
      all.map(async (relPath): Promise<ConfigFileInfo | null> => {
        try {
          const stat = await fsp.stat(path.join(serverPath, relPath));
          if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return null;
          return {
            id: fileId(cfg.id, relPath),
            relPath,
            modId: guessModId(relPath),
            format: extensionOf(relPath).slice(1),
            sizeBytes: stat.size,
            mtimeMs: stat.mtimeMs,
          };
        } catch {
          return null; // vanished between walk and stat
        }
      }),
    );

    return infos
      .filter((f): f is ConfigFileInfo => f !== null)
      .sort((a, b) => a.modId.localeCompare(b.modId) || a.relPath.localeCompare(b.relPath));
  }

  /**
   * Resolve an id to an absolute path, or null.
   *
   * Two independent walls: the id must appear in an index this module just
   * built (so the path is one we chose), and the realpath must still be inside
   * the server directory (so a symlink planted in `config/` cannot point at
   * `/etc` or at the world).
   */
  async function resolve(
    id: string,
  ): Promise<{ absPath: string; info: ConfigFileInfo } | null> {
    const info = (await index()).find((f) => f.id === id);
    if (!info) return null;

    const absPath = path.join(serverPath, info.relPath);
    try {
      const [realFile, realRoot] = await Promise.all([
        fsp.realpath(absPath),
        fsp.realpath(serverPath),
      ]);
      if (!realFile.startsWith(realRoot + path.sep)) return null;
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
  ): Promise<{ text: string; etag: string; info: ConfigFileInfo } | null> {
    const found = await resolve(id);
    if (!found) return null;
    const text = await fsp.readFile(found.absPath, "utf-8");
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
   * otherwise silently overwrite each other, and — more likely in practice —
   * many mods rewrite their own config at shutdown, so an edit made while the
   * server was running can land on top of a file the game has since replaced.
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

    const current = await fsp.readFile(found.absPath, "utf-8");
    if (etagOf(current) !== ifMatch) return { ok: false, reason: "conflict" };

    const stamp = await snapshot(id, current);
    await fsp.writeFile(found.absPath, text, "utf-8");
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
    return { ok: true, etag: etagOf(text) };
  }

  return { index, resolve, read, write, listSnapshots, revert };
}
