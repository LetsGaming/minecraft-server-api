/**
 * The backup archives: listing them, downloading one, restoring one, deleting one.
 *
 * `GET /backups` next door stays as it was — per-tier counts and the newest
 * archive, cheap enough to poll. These three are the operator-facing half and
 * every one of them addresses a file by the opaque id from the index. No route
 * here takes a path, a filename, or anything else a client could shape into
 * one; see instances/backupFiles.ts for why that is structural rather than a
 * validation rule.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ReadStream, Stats } from "fs";
import type { FileHandle } from "fs/promises";

import type { ServerState } from "../../../contracts/wire.js";
import {
  BackupFileDeleted,
  BackupFileIndex,
  ScriptResult,
} from "../../../contracts/schemas.js";
import {
  errors,
  instanceParams,
  queryParams,
} from "../../../contracts/routeSchema.js";
import { internalError } from "../../errors.js";
import { endRequest } from "../../../platform/metrics.js";
import { openNoFollow } from "../../../platform/safeFs.js";
import { enterDownload } from "../../routeCaps.js";
import {
  INSTANCE_PREFIX as P,
  type InstanceParams,
  type ResolveInstance,
} from "./shared.js";

/** Ids are 22 base64url chars from backupFiles.fileId. */
const FILE_ID_RE = /^[A-Za-z0-9_-]{22}$/;

const DEFAULT_PAGE = 50;

/** Parse a Range header of the form `bytes=start-[end]`. */
/** The restore was refused before it ran; carries the reply to send. */
class RestoreRefused extends Error {
  constructor(
    readonly status: 409 | 503,
    readonly body: { error: string; state?: ServerState },
  ) {
    super(body.error);
  }
}

function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null | "unsatisfiable" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  let start: number;
  let end: number;

  if (rawStart === "") {
    // Suffix form: the last N bytes.
    const suffix = parseInt(rawEnd ?? "", 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = parseInt(rawStart ?? "", 10);
    end = rawEnd === "" ? size - 1 : parseInt(rawEnd ?? "", 10);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return "unsatisfiable";
  return { start, end: Math.min(end, size - 1) };
}

export function registerBackupFileRoutes(
  app: FastifyInstance,
  resolve: ResolveInstance,
): void {
  app.get<{
    Params: InstanceParams;
    Querystring: { cursor?: string; limit?: string };
  }>(`${P}/backups/files`,
    { schema: {
      summary: "List backup archives, newest first",
      tags: ["backups"],
      params: instanceParams(),
      querystring: queryParams({
        cursor: "`nextCursor` from the previous page.",
        limit: "Page size, at most 200. Default 50.",
      }),
      response: { 200: BackupFileIndex, ...errors(404, 500) },
    } }, async (req, reply) => {
    const entry = resolve(req.params.id, reply);
    if (!entry) return;

    const limit = parseInt(req.query.limit ?? String(DEFAULT_PAGE), 10);
    try {
      return await entry.indexBackupFiles(
        req.query.cursor,
        Number.isNaN(limit) ? DEFAULT_PAGE : limit,
      );
    } catch (err) {
      return internalError(reply, `backups/files ${req.params.id}`, err);
    }
  });

  app.get<{ Params: InstanceParams & { fileId: string } }>(
    `${P}/backups/files/:fileId/download`,
    { schema: {
      summary: "Download one archive",
      description:
        "Streamed, never buffered. Supports a single `Range: bytes=start-end` " +
        "so an interrupted download can resume.",
      tags: ["backups"],
      params: instanceParams({ fileId: "Opaque id from the backup index." }),
      requestHeaders: {
        range: { description: "`bytes=start-[end]` or `bytes=-suffix`.", required: false },
        "if-range": {
          description:
            "The ETag of the partial download being resumed. A Range is honoured " +
            "only while it still names the same file; otherwise the whole file is sent.",
          required: false,
        },
      },
      produces: { 200: "application/octet-stream", 206: "application/octet-stream" },
      response: {
        200: { type: "string" },
        206: { type: "string" },
        ...errors(400, 404, 416, 429),
      },
    } },
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;

      // Shape-check first so a malformed id is a 400 rather than a directory
      // walk that then finds nothing.
      if (!FILE_ID_RE.test(req.params.fileId)) {
        return reply.status(400).send({ error: "Invalid backup id" });
      }

      const found = await entry.resolveBackupFile(req.params.fileId);
      if (!found) return reply.status(404).send({ error: "Backup not found" });

      const { absPath, info } = found;
      // W-007/W-018: open once, without following a link planted after the
      // check, and take the size from the open file rather than the index,
      // which can be minutes old (a replaced or still-growing archive would
      // otherwise go out silently truncated).
      const release = enterDownload(req.params.id, reply);
      if (!release) return reply;
      let fh: FileHandle;
      try {
        fh = await openNoFollow(absPath);
      } catch {
        release();
        return reply.status(404).send({ error: "Backup not found" });
      }
      let stat: Stats;
      try {
        stat = await fh.stat();
      } catch (err) {
        await fh.close();
        release();
        throw err;
      }
      const size = stat.size;
      const etag = `"${size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
      // A resume against a different file would splice two archives together.
      const ifRange = req.headers["if-range"];
      const rangeHeader =
        typeof ifRange === "string" && ifRange !== etag ? undefined : req.headers.range;
      const range = parseRange(rangeHeader, size);

      if (range === "unsatisfiable") {
        await fh.close();
        release();
        return reply
          .status(416)
          .header("content-range", `bytes */${size}`)
          .header("etag", etag)
          .send({ error: "Requested range not satisfiable" });
      }

      // A download is a long transfer, not work in progress: it gives back the
      // global in-flight slot once it starts, and holds a download slot until
      // the connection is done.
      const sendStream = (stream: ReadStream): FastifyReply => {
        endRequest(req.raw);
        reply.raw.once("close", release);
        return reply.send(stream);
      };

      // Content-Disposition carries only the basename the index produced, and
      // that name came from readdir — but quote it anyway so a filename with a
      // space or a quote cannot break out of the header value.
      const safeName = info.name.replace(/["\\]/g, "_");
      void reply
        .header("content-type", "application/octet-stream")
        .header("content-disposition", `attachment; filename="${safeName}"`)
        // Range support is not a nicety here: these archives run to gigabytes
        // and get pulled over links that drop. Without it an interrupted
        // download restarts from zero.
        .header("accept-ranges", "bytes")
        .header("etag", etag);

      if (range) {
        void reply
          .status(206)
          .header("content-length", String(range.end - range.start + 1))
          .header(
            "content-range",
            `bytes ${range.start}-${range.end}/${size}`,
          );
        return sendStream(fh.createReadStream({ start: range.start, end: range.end }));
      }

      // Content-Length lets the browser draw its own progress bar, which is
      // why this route does not need one of its own.
      void reply.header("content-length", String(size));
      // Streamed, never buffered: reading a multi-gigabyte archive into memory
      // to hand it over would take the wrapper down on the first big world.
      return sendStream(fh.createReadStream());
    },
  );

  app.delete<{ Params: InstanceParams & { fileId: string } }>(
    `${P}/backups/files/:fileId`,
    { schema: {
      summary: "Delete one archive",
      tags: ["backups"],
      params: instanceParams({ fileId: "Opaque id from the backup index." }),
      response: { 200: BackupFileDeleted, ...errors(400, 404, 423, 500) },
    } },
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;

      if (!FILE_ID_RE.test(req.params.fileId)) {
        return reply.status(400).send({ error: "Invalid backup id" });
      }

      try {
        const deleted = await entry.deleteBackupFile(req.params.fileId);
        if (!deleted) return reply.status(404).send({ error: "Backup not found" });
        return { ok: true, name: deleted.name, tier: deleted.tier, sizeBytes: deleted.sizeBytes };
      } catch (err) {
        return internalError(reply, `backups/delete ${req.params.id}`, err);
      }
    },
  );

  app.post<{ Params: InstanceParams & { fileId: string } }>(
    `${P}/backups/files/:fileId/restore`,
    { schema: {
      summary: "Restore the world from one archive",
      description:
        "Refused unless the server is offline, judged by a probe made now. " +
        "The path handed to the restore script is the one the wrapper " +
        "resolved from the id. A script that ran returns 200 with its output " +
        "and exit code.",
      tags: ["backups"],
      params: instanceParams({ fileId: "Opaque id from the backup index." }),
      response: { 200: ScriptResult, ...errors(400, 404, 409, 423, 500, 503) },
    } },
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;

      if (!FILE_ID_RE.test(req.params.fileId)) {
        return reply.status(400).send({ error: "Invalid backup id" });
      }

      const found = await entry.resolveBackupFile(req.params.fileId);
      if (!found) return reply.status(404).send({ error: "Backup not found" });

      try {
        // Replacing the world under a running server corrupts it. "offline" is
        // the only state that proves no JVM holds the files; an unresponsive
        // server is still a running one.
        // The cached health answer can be seconds stale, so this asks for a
        // probe made now, and refuses when none can be completed. It runs
        // holding the slot (W-008), so nothing can start the server between
        // the probe and the restore.
        const ensureOffline = async (): Promise<void> => {
          let state: ServerState;
          try {
            ({ state } = await entry.getFreshHealth());
          } catch {
            throw new RestoreRefused(503, {
              error: "Could not verify that the server is offline. Try again shortly.",
            });
          }
          if (state !== "offline") {
            throw new RestoreRefused(409, {
              error: "Server must be offline to restore a backup. Stop it first.",
              state,
            });
          }
        };

        // The path handed to the script is the one the wrapper resolved, never
        // one the client described. That is the whole reason restore is not a
        // /scripts/run action (see instances/restore.ts).
        return await entry.restore(found.absPath, ensureOffline);
      } catch (err) {
        if (err instanceof RestoreRefused) return reply.status(err.status).send(err.body);
        return internalError(reply, `backups/restore ${req.params.id}`, err);
      }
    },
  );
}
