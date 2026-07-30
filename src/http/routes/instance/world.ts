/**
 * What is deployed on disk for this instance: the world's name, its mod
 * manifest and its backup inventory.
 */
import type { FastifyInstance } from "fastify";

import { internalError } from "../../errors.js";
import {
  INSTANCE_PREFIX as P,
  type InstanceParams,
  type ResolveInstance,
} from "./shared.js";

export function registerWorldRoutes(
  app: FastifyInstance,
  resolve: ResolveInstance,
): void {
  app.get<{ Params: InstanceParams }>(`${P}/level-name`, async (req, reply) => {
    const entry = resolve(req.params.id, reply);
    if (!entry) return;
    try {
      return { levelName: await entry.getLevelName() };
    } catch (err) {
      return internalError(reply, `level-name ${req.params.id}`, err);
    }
  });

  app.get<{ Params: InstanceParams }>(`${P}/mods`, async (req, reply) => {
    const entry = resolve(req.params.id, reply);
    if (!entry) return;
    // F-008: null means file not found → 404
    try {
      const result = await entry.getModSlugs();
      if (result === null) {
        return reply.status(404).send({ error: "Mod list not found" });
      }
      return result;
    } catch (err) {
      return internalError(reply, `mods ${req.params.id}`, err);
    }
  });

  app.get<{ Params: InstanceParams }>(`${P}/backups`, async (req, reply) => {
    const entry = resolve(req.params.id, reply);
    if (!entry) return;
    try {
      return await entry.getBackups();
    } catch (err) {
      return internalError(reply, `backups ${req.params.id}`, err);
    }
  });
}
