/**
 * The backup archives: listing them, downloading one, restoring one.
 *
 * `GET /backups` next door stays as it was — per-tier counts and the newest
 * archive, cheap enough to poll. These three are the operator-facing half and
 * every one of them addresses a file by the opaque id from the index. No route
 * here takes a path, a filename, or anything else a client could shape into
 * one; see instances/backupFiles.ts for why that is structural rather than a
 * validation rule.
 */
import { createReadStream } from "fs";
import type { FastifyInstance } from "fastify";

import { internalError } from "../../errors.js";
import {
  INSTANCE_PREFIX as P,
  type InstanceParams,
  type ResolveInstance,
} from "./shared.js";

/** Ids are 22 base64url chars from backupFiles.fileId. */
const FILE_ID_RE = /^[A-Za-z0-9_-]{22}$/;

const DEFAULT_PAGE = 50;

/** Parse a Range header of the form `bytes=start-[end]`. */
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
  }>(`${P}/backups/files`, async (req, reply) => {
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
      const range = parseRange(req.headers.range, info.sizeBytes);

      if (range === "unsatisfiable") {
        return reply
          .status(416)
          .header("content-range", `bytes */${info.sizeBytes}`)
          .send({ error: "Requested range not satisfiable" });
      }

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
        .header("accept-ranges", "bytes");

      if (range) {
        void reply
          .status(206)
          .header("content-length", String(range.end - range.start + 1))
          .header(
            "content-range",
            `bytes ${range.start}-${range.end}/${info.sizeBytes}`,
          );
        return reply.send(
          createReadStream(absPath, { start: range.start, end: range.end }),
        );
      }

      // Content-Length lets the browser draw its own progress bar, which is
      // why this route does not need one of its own.
      void reply.header("content-length", String(info.sizeBytes));
      // Streamed, never buffered: reading a multi-gigabyte archive into memory
      // to hand it over would take the wrapper down on the first big world.
      return reply.send(createReadStream(absPath));
    },
  );

  app.post<{ Params: InstanceParams & { fileId: string } }>(
    `${P}/backups/files/:fileId/restore`,
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;

      if (!FILE_ID_RE.test(req.params.fileId)) {
        return reply.status(400).send({ error: "Invalid backup id" });
      }

      const found = await entry.resolveBackupFile(req.params.fileId);
      if (!found) return reply.status(404).send({ error: "Backup not found" });

      try {
        // The path handed to the script is the one the wrapper resolved, never
        // one the client described. That is the whole reason restore is not a
        // /scripts/run action (see instances/restore.ts).
        return await entry.restore(found.absPath);
      } catch (err) {
        return internalError(reply, `backups/restore ${req.params.id}`, err);
      }
    },
  );
}
