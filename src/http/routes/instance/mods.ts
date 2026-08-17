/**
 * Mod management routes: the installed manifest and the add/remove/update
 * operations. Two features, split so a grant can gate reads and writes apart:
 *
 *   mods            GET /mods                the bot's slug-only manifest,
 *                                            unchanged — its v1 contract.
 *   mod-management  GET  /mods/installed     the richer installed list,
 *                   POST /mods               add,
 *                   DELETE /mods/:slug       remove,
 *                   GET  /mods/updates       check,
 *                   POST /mods/updates       apply.
 *
 * The mutating routes run the suite's scripts as the instance user and follow
 * the same convention as /scripts/run and restore: a script that *ran* returns
 * its structured outcome at 200 (including its own handled `{ok:false}`), and
 * only a failure to run at all becomes a 500. Modrinth browsing is not here —
 * that is the dashboard's job; the wrapper only reads and writes this host.
 */
import type { FastifyInstance } from "fastify";

import { internalError } from "../../errors.js";
import { MOD_VALIDATION } from "../../../instances/mods.js";
import {
  INSTANCE_PREFIX as P,
  type InstanceParams,
  type ResolveInstance,
} from "./shared.js";

const { SLUG_RE, MC_VERSION_RE, LOADER_RE } = MOD_VALIDATION;

export function registerModRoutes(
  app: FastifyInstance,
  resolve: ResolveInstance,
): void {
  // ── mods (v1): the bot's slug-only manifest, relocated here unchanged ─────
  app.get<{ Params: InstanceParams }>(`${P}/mods`, async (req, reply) => {
    const entry = resolve(req.params.id, reply);
    if (!entry) return;
    // F-008: null means the manifest file is absent → 404.
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

  // ── mod-management ────────────────────────────────────────────────────────
  app.get<{ Params: InstanceParams }>(
    `${P}/mods/installed`,
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;
      try {
        const result = await entry.listInstalled();
        if (result === null) {
          return reply.status(404).send({ error: "Mod list not found" });
        }
        return result;
      } catch (err) {
        return internalError(reply, `mods/installed ${req.params.id}`, err);
      }
    },
  );

  app.post<{
    Params: InstanceParams;
    Body: { slug?: unknown; mcVersion?: unknown; modLoader?: unknown };
  }>(`${P}/mods`, async (req, reply) => {
    const entry = resolve(req.params.id, reply);
    if (!entry) return;

    const slug = req.body?.slug;
    if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
      return reply.status(400).send({ error: "Invalid or missing mod slug" });
    }
    const mcVersion = req.body?.mcVersion;
    if (mcVersion !== undefined && (typeof mcVersion !== "string" || !MC_VERSION_RE.test(mcVersion))) {
      return reply.status(400).send({ error: "Invalid mcVersion" });
    }
    const modLoader = req.body?.modLoader;
    if (modLoader !== undefined && (typeof modLoader !== "string" || !LOADER_RE.test(modLoader))) {
      return reply.status(400).send({ error: "Invalid modLoader" });
    }

    try {
      return await entry.addMod(
        slug,
        mcVersion as string | undefined,
        modLoader as string | undefined,
      );
    } catch (err) {
      return internalError(reply, `mods/add ${req.params.id}`, err);
    }
  });

  app.delete<{ Params: InstanceParams & { slug: string } }>(
    `${P}/mods/:slug`,
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;
      if (!SLUG_RE.test(req.params.slug)) {
        return reply.status(400).send({ error: "Invalid mod slug" });
      }
      try {
        return await entry.removeMod(req.params.slug);
      } catch (err) {
        return internalError(reply, `mods/remove ${req.params.id}`, err);
      }
    },
  );

  app.get<{ Params: InstanceParams; Querystring: { mcVersion?: string } }>(
    `${P}/mods/updates`,
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;
      const mcVersion = req.query.mcVersion;
      if (mcVersion !== undefined && !MC_VERSION_RE.test(mcVersion)) {
        return reply.status(400).send({ error: "Invalid mcVersion" });
      }
      try {
        return await entry.checkUpdates(mcVersion);
      } catch (err) {
        return internalError(reply, `mods/updates ${req.params.id}`, err);
      }
    },
  );

  app.post<{ Params: InstanceParams & { slug: string } }>(
    `${P}/mods/:slug/update`,
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;
      if (!SLUG_RE.test(req.params.slug)) {
        return reply.status(400).send({ error: "Invalid mod slug" });
      }
      try {
        return await entry.updateMod(req.params.slug);
      } catch (err) {
        return internalError(reply, `mods/update ${req.params.id}`, err);
      }
    },
  );

  app.post<{ Params: InstanceParams; Body: { mcVersion?: unknown } }>(
    `${P}/mods/updates`,
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;
      const mcVersion = req.body?.mcVersion;
      if (mcVersion !== undefined && (typeof mcVersion !== "string" || !MC_VERSION_RE.test(mcVersion))) {
        return reply.status(400).send({ error: "Invalid mcVersion" });
      }
      try {
        return await entry.applyUpdates(mcVersion as string | undefined);
      } catch (err) {
        return internalError(reply, `mods/updates/apply ${req.params.id}`, err);
      }
    },
  );
}
