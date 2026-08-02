/**
 * Mod config files: index, read, write, snapshots, revert.
 *
 * Every route addresses a file by the opaque id from the index — no path, no
 * filename, nothing a client could shape into one. See instances/configFiles.ts
 * for why that is structural rather than a validation rule.
 *
 * The wrapper does not know what a TOML file means. It serves bytes and takes
 * bytes; parsing, schema derivation and the splicing writer all live upstream
 * in the bot's `configfmt`. That split is deliberate: a wrapper release is a
 * deploy on every Minecraft host, so format quirks — and there are many — must
 * be fixable without touching game servers.
 */
import type { FastifyInstance } from "fastify";

import { internalError } from "../../errors.js";
import {
  INSTANCE_PREFIX as P,
  type InstanceParams,
  type ResolveInstance,
} from "./shared.js";

const FILE_ID_RE = /^[A-Za-z0-9_-]{22}$/;

export function registerConfigFileRoutes(
  app: FastifyInstance,
  resolve: ResolveInstance,
): void {
  app.get<{ Params: InstanceParams }>(
    `${P}/configs`,
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;
      try {
        return { files: await entry.indexConfigFiles() };
      } catch (err) {
        return internalError(reply, `configs ${req.params.id}`, err);
      }
    },
  );

  app.get<{ Params: InstanceParams & { fileId: string } }>(
    `${P}/configs/:fileId`,
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;
      if (!FILE_ID_RE.test(req.params.fileId)) {
        return reply.status(400).send({ error: "Invalid config id" });
      }
      try {
        const found = await entry.readConfigFile(req.params.fileId);
        if (!found) return reply.status(404).send({ error: "Config not found" });
        return {
          text: found.text,
          etag: found.etag,
          file: found.info,
          snapshots: await entry.listConfigSnapshots(req.params.fileId),
        };
      } catch (err) {
        return internalError(reply, `configs/read ${req.params.id}`, err);
      }
    },
  );

  app.put<{
    Params: InstanceParams & { fileId: string };
    Body: { text?: unknown };
  }>(`${P}/configs/:fileId`, async (req, reply) => {
    const entry = resolve(req.params.id, reply);
    if (!entry) return;
    if (!FILE_ID_RE.test(req.params.fileId)) {
      return reply.status(400).send({ error: "Invalid config id" });
    }
    if (typeof req.body?.text !== "string") {
      return reply.status(400).send({ error: "Body must be { text: string }" });
    }

    // Required, not optional: without it two open editors silently overwrite
    // each other, and an edit made while the server was running lands on top
    // of a file the game rewrote at shutdown.
    const ifMatch = req.headers["if-match"];
    if (typeof ifMatch !== "string" || ifMatch === "") {
      return reply.status(428).send({ error: "If-Match header is required" });
    }

    try {
      const result = await entry.writeConfigFile(
        req.params.fileId,
        req.body.text,
        ifMatch,
      );
      if (!result.ok) {
        if (result.reason === "not-found") {
          return reply.status(404).send({ error: "Config not found" });
        }
        if (result.reason === "too-large") {
          return reply.status(413).send({ error: "Config file is too large" });
        }
        return reply
          .status(412)
          .send({ error: "The file changed since you loaded it" });
      }
      return { etag: result.etag, snapshot: result.snapshot };
    } catch (err) {
      return internalError(reply, `configs/write ${req.params.id}`, err);
    }
  });

  app.post<{
    Params: InstanceParams & { fileId: string };
    Body: { snapshot?: unknown };
  }>(`${P}/configs/:fileId/revert`, async (req, reply) => {
    const entry = resolve(req.params.id, reply);
    if (!entry) return;
    if (!FILE_ID_RE.test(req.params.fileId)) {
      return reply.status(400).send({ error: "Invalid config id" });
    }
    if (typeof req.body?.snapshot !== "string") {
      return reply.status(400).send({ error: "Body must be { snapshot: string }" });
    }

    try {
      const result = await entry.revertConfigFile(
        req.params.fileId,
        req.body.snapshot,
      );
      if (!result.ok) {
        return reply.status(404).send({ error: `Cannot revert: ${result.reason}` });
      }
      return { etag: result.etag };
    } catch (err) {
      return internalError(reply, `configs/revert ${req.params.id}`, err);
    }
  });
}
