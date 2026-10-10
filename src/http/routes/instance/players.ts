/**
 * Who is online and who is allowed on: the live list, whitelist.json and
 * usercache.json.
 */
import type { FastifyInstance } from "fastify";

import {
  PlayerList,
  WhitelistResponse,
  UserCacheResponse,
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

export function registerPlayerRoutes(
  app: FastifyInstance,
  resolve: ResolveInstance,
): void {
  app.get<{ Params: InstanceParams }>(
    `${P}/list`,
    {
      schema: {
        summary: "Online players",
        tags: ["players"],
        params: instanceParams(),
        response: { 200: PlayerList, ...errors(404, 500) },
      },
    },
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;
      try {
        return await entry.getList();
      } catch (err) {
        return internalError(reply, `list ${req.params.id}`, err);
      }
    },
  );

  app.get<{ Params: InstanceParams }>(
    `${P}/whitelist`,
    {
      schema: {
        summary: "whitelist.json entries",
        tags: ["players"],
        params: instanceParams(),
        response: { 200: WhitelistResponse, ...errors(404, 500) },
      },
    },
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;
      try {
        return { whitelist: await entry.getWhitelist() };
      } catch (err) {
        return internalError(reply, `whitelist ${req.params.id}`, err);
      }
    },
  );

  // usercache.json — every player the server has ever seen. The bot uses
  // this as a best-effort name source on top of the whitelist
  // (serverAccess.readUserCache; older wrappers without the route → []).
  app.get<{ Params: InstanceParams }>(
    `${P}/usercache`,
    {
      schema: {
        summary: "usercache.json entries",
        tags: ["players"],
        params: instanceParams(),
        response: { 200: UserCacheResponse, ...errors(404, 500) },
      },
    },
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;
      try {
        return { usercache: await entry.getUserCache() };
      } catch (err) {
        return internalError(reply, `usercache ${req.params.id}`, err);
      }
    },
  );
}
