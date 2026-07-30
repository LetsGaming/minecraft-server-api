/**
 * Player stat files. Every :uuid passes the F-001 allowlist here; the
 * operations layer additionally guards the resolved path (A-11).
 */
import type { FastifyInstance } from "fastify";

import { internalError } from "../../errors.js";
import { UUID_RE } from "../../validation.js";
import {
  INSTANCE_PREFIX as P,
  type InstanceParams,
  type ResolveInstance,
} from "./shared.js";

export function registerStatsRoutes(
  app: FastifyInstance,
  resolve: ResolveInstance,
): void {
  app.get<{ Params: InstanceParams }>(`${P}/stats`, async (req, reply) => {
    const entry = resolve(req.params.id, reply);
    if (!entry) return;
    try {
      return { uuids: await entry.listStatsUuids() };
    } catch (err) {
      return internalError(reply, `stats ${req.params.id}`, err);
    }
  });

  app.get<{ Params: InstanceParams & { uuid: string } }>(
    `${P}/stats/:uuid`,
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;
      if (!UUID_RE.test(req.params.uuid)) {
        return reply.status(400).send({ error: "Invalid UUID" });
      }
      try {
        const stats = await entry.getStats(req.params.uuid);
        if (stats === null) {
          return reply.status(404).send({ error: "Stats not found" });
        }
        return { stats };
      } catch (err) {
        return internalError(reply, `stats/:uuid get ${req.params.id}`, err);
      }
    },
  );

  // H-05 companion: explicit stats deletion for the bot's admin-gated
  // `/server prune-stats`.
  app.delete<{ Params: InstanceParams & { uuid: string } }>(
    `${P}/stats/:uuid`,
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;
      if (!UUID_RE.test(req.params.uuid)) {
        return reply.status(400).send({ error: "Invalid UUID" });
      }
      try {
        return { deleted: await entry.deleteStats(req.params.uuid) };
      } catch (err) {
        return internalError(reply, `stats/:uuid delete ${req.params.id}`, err);
      }
    },
  );
}
