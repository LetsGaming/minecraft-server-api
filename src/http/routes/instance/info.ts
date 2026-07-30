/**
 * Version handshake, host metrics and capability detection — what the bot
 * reads once at startup to decide what it may ask for.
 */
import type { FastifyInstance } from "fastify";

import { internalError } from "../../errors.js";
import { getHostInfo } from "../../../platform/host/index.js";
import { WRAPPER_VERSION } from "../../../contracts/version.js";
import {
  INSTANCE_PREFIX as P,
  type InstanceParams,
  type ResolveInstance,
} from "./shared.js";

export function registerInfoRoutes(
  app: FastifyInstance,
  resolve: ResolveInstance,
): void {
  // The wrapper half of the bot's "remote host metrics + version handshake"
  // feature (bot: serverAccess.getRemoteInfo, MIN_WRAPPER_VERSION).
  // `version` lets the bot verify compatibility at startup; `host` feeds
  // the status view and the disk-space alerts for remote instances.
  app.get<{ Params: InstanceParams }>(`${P}/info`, async (req, reply) => {
    const entry = resolve(req.params.id, reply);
    if (!entry) return;
    try {
      return { version: WRAPPER_VERSION, host: await getHostInfo(entry.cfg) };
    } catch (err) {
      return internalError(reply, `info ${req.params.id}`, err);
    }
  });

  // M-13: which setup-suite artifacts exist for this instance.
  app.get<{ Params: InstanceParams }>(
    `${P}/capabilities`,
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;
      try {
        return await entry.getCapabilities();
      } catch (err) {
        return internalError(reply, `capabilities ${req.params.id}`, err);
      }
    },
  );
}
