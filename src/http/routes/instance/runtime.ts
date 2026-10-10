/**
 * Liveness and performance: what the server is doing right now.
 */
import type { FastifyInstance } from "fastify";

import {
  InstanceHealth,
  Running,
  TpsResponse,
} from "../../../contracts/schemas.js";
import {
  errors,
  instanceParams,
} from "../../../contracts/routeSchema.js";
import { internalError } from "../../errors.js";
import {
  INSTANCE_PREFIX as P,
  type InstanceParams,
  type ResolveInstance,
} from "./shared.js";

export function registerRuntimeRoutes(
  app: FastifyInstance,
  resolve: ResolveInstance,
): void {
  // The distinction /running cannot make. A server pinned by chunk loading
  // is `unresponsive`, not `offline`, and a client that treats those the
  // same alerts on the wrong thing (see instances/health.ts).
  app.get<{ Params: InstanceParams }>(
    `${P}/health`,
    {
      schema: {
        summary: "Three-state server health",
        description:
          "Process liveness and RCON responsiveness reported separately, plus systemd restart-loop detection.",
        tags: ["server"],
        params: instanceParams(),
        response: { 200: InstanceHealth, ...errors(404, 500) },
      },
    },
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;
      try {
        return await entry.getHealth();
      } catch (err) {
        return internalError(reply, `health ${req.params.id}`, err);
      }
    },
  );

  app.get<{ Params: InstanceParams }>(
    `${P}/running`,
    {
      schema: {
        summary: "Whether the server process is up",
        description:
          "Legacy boolean. True for `online` and `unresponsive`; read /health to tell them apart.",
        tags: ["server"],
        params: instanceParams(),
        response: { 200: Running, ...errors(404, 500) },
      },
    },
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;
      try {
        return { running: await entry.isRunning() };
      } catch (err) {
        return internalError(reply, `running ${req.params.id}`, err);
      }
    },
  );

  app.get<{ Params: InstanceParams }>(
    `${P}/tps`,
    {
      schema: {
        summary: "Ticks per second",
        description: "`tps` is null when the server did not report one.",
        tags: ["server"],
        params: instanceParams(),
        response: { 200: TpsResponse, ...errors(404, 500) },
      },
    },
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;
      try {
        return { tps: await entry.getTps() };
      } catch (err) {
        return internalError(reply, `tps ${req.params.id}`, err);
      }
    },
  );
}
