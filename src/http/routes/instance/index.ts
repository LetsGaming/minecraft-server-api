/**
 * /instances/:id — resolution plus the per-resource route groups.
 *
 * Every group is thin: validate, dispatch into the instance's operations
 * bundle, map failures through errors.ts. Nothing decides anything here.
 */
import type { FastifyInstance } from "fastify";

import { registerBackupFileRoutes } from "./backups.js";
import { registerControlRoutes } from "./control.js";
import { registerInfoRoutes } from "./info.js";
import { registerLogRoutes } from "./logs.js";
import { registerPlayerRoutes } from "./players.js";
import { registerRuntimeRoutes } from "./runtime.js";
import { registerStatsRoutes } from "./stats.js";
import { registerWorldRoutes } from "./world.js";
import type { LogStreamAPI } from "../../../platform/logStream.js";
import type { InstanceEntry, ResolveInstance } from "./shared.js";

export function registerInstanceRoutes(
  app: FastifyInstance,
  opsRegistry: Map<string, InstanceEntry>,
  logStreamAPI: LogStreamAPI,
): void {
  // Configured instance IDs so clients can discover what is deployed
  // without out-of-band configuration.
  app.get("/instances", async () => ({
    instances: [...opsRegistry.keys()].map((id) => ({ id })),
  }));

  const resolve: ResolveInstance = (id, reply) => {
    const entry = opsRegistry.get(id);
    if (!entry) {
      void reply.status(404).send({ error: "Instance not found" });
      return null;
    }
    return entry;
  };

  registerInfoRoutes(app, resolve);
  registerLogRoutes(app, resolve, logStreamAPI);
  registerPlayerRoutes(app, resolve);
  registerRuntimeRoutes(app, resolve);
  registerStatsRoutes(app, resolve);
  registerWorldRoutes(app, resolve);
  registerControlRoutes(app, resolve);
  registerBackupFileRoutes(app, resolve);
}
