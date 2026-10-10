/**
 * Player stat files. Every :uuid passes the F-001 allowlist here; the
 * operations layer additionally guards the resolved path (A-11).
 */
import type { FastifyInstance } from "fastify";

import {
  StatsUuids,
  StatsBulk,
  StatsOne,
  StatsDeleted,
} from "../../../contracts/schemas.js";
import {
  errors,
  instanceParams,
} from "../../../contracts/routeSchema.js";
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
  app.get<{ Params: InstanceParams }>(
    `${P}/stats`,
    {
      schema: {
        summary: "Uuids that have a stats file",
        tags: ["stats"],
        params: instanceParams(),
        response: { 200: StatsUuids, ...errors(404, 500) },
      },
    },
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;
      try {
        return { uuids: await entry.listStatsUuids() };
      } catch (err) {
        return internalError(reply, `stats ${req.params.id}`, err);
      }
    },
  );

  // Every player's stats in one response, bounded server-side, so a
  // leaderboard build costs one request instead of one per lifetime player.
  app.get<{ Params: InstanceParams }>(
    `${P}/stats/bulk`,
    {
      schema: {
        summary: "Every player's stats in one response",
        tags: ["stats"],
        params: instanceParams(),
        response: { 200: StatsBulk, ...errors(404, 500) },
      },
    },
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;
      try {
        return { stats: await entry.getAllStats() };
      } catch (err) {
        return internalError(reply, `stats/bulk ${req.params.id}`, err);
      }
    },
  );

  app.get<{ Params: InstanceParams & { uuid: string } }>(
    `${P}/stats/:uuid`,
    {
      schema: {
        summary: "One player's stats file",
        tags: ["stats"],
        params: instanceParams({ uuid: "Player uuid, with dashes." }),
        response: { 200: StatsOne, ...errors(400, 404, 500) },
      },
    },
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
    {
      schema: {
        summary: "Delete one player's stats file",
        description: "`deleted` is false when there was no such file.",
        tags: ["stats"],
        params: instanceParams({ uuid: "Player uuid, with dashes." }),
        response: { 200: StatsDeleted, ...errors(400, 404, 500) },
      },
    },
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
