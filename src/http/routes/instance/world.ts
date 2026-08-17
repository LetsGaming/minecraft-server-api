/**
 * What is deployed on disk for this instance: the world's name and its backup
 * inventory. The mod manifest moved to its own group (routes/instance/mods.ts)
 * when mod management grew past a single read-only route.
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
