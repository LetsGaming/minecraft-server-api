/**
 * The backup archives themselves: an index, a resolver, and the guards that
 * keep both inside the configured backups directory.
 *
 * `backups.ts` next door answers "how big is each tier"; this answers "which
 * files are there, and where is one of them". The split matters because the
 * summary is cheap and polled, while the index walks the tiers and is only
 * asked for when someone opens the backup panel.
 *
 * ── Why files are addressed by an opaque id ──
 *
 * The obvious design is `GET /backups/files/hourly%2Fworld-2026-08-01.tar.zst`
 * and a `path.resolve` + `startsWith` check. That is what the old panel did,
 * and it is a traversal guard that has to be right every time it is written.
 * It is also not enough on its own: `startsWith` passes a symlink inside the
 * backups directory that points at /etc.
 *
 * So the client never names a path. It gets an id from the index, and the id
 * resolves against a listing this module built itself, from a directory it
 * chose. There is no caller-supplied string on the path-building side at all,
 * which makes traversal structurally impossible rather than defended against.
 * The realpath containment check below is then a second wall, for the symlink
 * case the first one cannot see.
 *
 * The id is derived (not random) so it survives a wrapper restart: a browser
 * holding a download URL from before a redeploy should still work.
 */
import { createHash } from "crypto";
import fsp from "fs/promises";
import path from "path";

import type { InstanceConfig } from "../config/types.js";

/** Tier directories the suite writes, in the order the panel shows them. */
const TIERS = [
  "hourly",
  "archives/daily",
  "archives/weekly",
  "archives/monthly",
  "archives/update",
] as const;

const ARCHIVE_SUFFIXES = [".tar.zst", ".tar.gz"] as const;

/** Cap on one index response, so a tier with 10k archives can't blow up. */
export const MAX_INDEX_PAGE = 200;

export interface BackupFileInfo {
  /** Opaque handle; the only thing a client may send back. */
  id: string;
  tier: string;
  name: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface BackupFileIndex {
  files: BackupFileInfo[];
  /** Pass as `cursor` to continue. Null when the listing is complete. */
  nextCursor: string | null;
  total: number;
}

function isArchive(name: string): boolean {
  return ARCHIVE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/**
 * The handle for one archive.
 *
 * Keyed on the instance id as well as the relative path so an id from one
 * instance cannot resolve against another's backups directory, even when two
 * instances happen to have identically-named archives.
 */
function fileId(instanceId: string, relPath: string): string {
  return createHash("sha256")
    .update(`${instanceId}\0${relPath}`)
    .digest("base64url")
    .slice(0, 22);
}

export function createBackupFiles(cfg: InstanceConfig) {
  /**
   * Every archive under the configured backups path, newest first.
   *
   * One readdir per tier, in parallel, and no recursion: the suite's layout is
   * flat inside each tier, and walking arbitrarily deep would be both slower
   * and an invitation to follow a symlinked directory out of the tree.
   */
  async function listAll(): Promise<BackupFileInfo[]> {
    if (!cfg.backupsPath) return [];
    const backupsPath = cfg.backupsPath;

    async function readTier(tier: string): Promise<BackupFileInfo[]> {
      const dir = path.join(backupsPath, tier);
      let entries: string[];
      try {
        entries = await fsp.readdir(dir);
      } catch {
        return []; // tier not present on this instance
      }

      const out = await Promise.all(
        entries.filter(isArchive).map(async (name) => {
          try {
            const stat = await fsp.stat(path.join(dir, name));
            if (!stat.isFile()) return null;
            const relPath = path.posix.join(tier, name);
            return {
              id: fileId(cfg.id, relPath),
              tier,
              name,
              sizeBytes: stat.size,
              mtimeMs: stat.mtimeMs,
            };
          } catch {
            // Rotation can delete a file between readdir and stat. Skip it
            // rather than failing the whole listing.
            return null;
          }
        }),
      );
      return out.filter((f): f is BackupFileInfo => f !== null);
    }

    const perTier = await Promise.all(TIERS.map(readTier));
    return perTier.flat().sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  /**
   * A page of the index.
   *
   * The cursor is the id of the last item returned, not an offset: archives
   * are created and rotated away while someone is paging, and an offset would
   * silently skip or repeat rows when the list shifts under it.
   */
  async function index(
    cursor: string | undefined,
    limit: number,
  ): Promise<BackupFileIndex> {
    const all = await listAll();
    const size = Math.min(Math.max(limit, 1), MAX_INDEX_PAGE);

    let start = 0;
    if (cursor) {
      const at = all.findIndex((f) => f.id === cursor);
      // An unknown cursor means the row it pointed at was rotated away.
      // Restarting from the top is honest; pretending the list ended is not.
      start = at >= 0 ? at + 1 : 0;
    }

    const files = all.slice(start, start + size);
    const last = files[files.length - 1];
    return {
      files,
      nextCursor: start + size < all.length && last ? last.id : null,
      total: all.length,
    };
  }

  /**
   * Resolve an opaque id to an absolute path, or null.
   *
   * Two independent guards, because they catch different things:
   *   1. The id must appear in an index this module just built, so the path
   *      is one we chose rather than one a client described.
   *   2. The realpath must still sit inside the backups directory, which is
   *      the only check that sees a symlink planted inside a tier.
   */
  async function resolve(
    id: string,
  ): Promise<{ absPath: string; info: BackupFileInfo } | null> {
    if (!cfg.backupsPath) return null;
    const info = (await listAll()).find((f) => f.id === id);
    if (!info) return null;

    const absPath = path.join(cfg.backupsPath, info.tier, info.name);
    try {
      const [realFile, realRoot] = await Promise.all([
        fsp.realpath(absPath),
        fsp.realpath(cfg.backupsPath),
      ]);
      if (realFile !== realRoot && !realFile.startsWith(realRoot + path.sep)) {
        return null;
      }
      return { absPath: realFile, info };
    } catch {
      return null; // vanished between listing and resolving
    }
  }

  return { index, resolve };
}
