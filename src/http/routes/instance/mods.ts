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
 *                   POST /mods/updates       apply,
 *                   POST /mods/:slug/disable disable without uninstalling,
 *                   POST /mods/:slug/enable  re-enable.
 *   mod-compat      POST /mods/compat        start a check against a target
 *                                            Minecraft version (a job),
 *                   GET  /mods/compat/:jobId poll its progress and result.
 *
 * The mutating routes run the suite's scripts as the instance user and follow
 * the same convention as /scripts/run and restore: a script that *ran* returns
 * its structured outcome at 200 (including its own handled `{ok:false}`), and
 * only a failure to run at all becomes a 500. Modrinth browsing is not here —
 * that is the dashboard's job; the wrapper only reads and writes this host.
 */
import type { FastifyInstance } from "fastify";

import {
  InstalledMods,
  ModAddRequest,
  ModAddResult,
  ModApplyResult,
  ModCompatJob,
  ModCompatRequest,
  ModCompatStarted,
  ModRemoveResult,
  ModSlugs,
  ModToggleResult,
  ModUpdateCheck,
  ModUpdatesRequest,
} from "../../../contracts/schemas.js";
import {
  errors,
  instanceParams,
  queryParams,
} from "../../../contracts/routeSchema.js";
import { internalError } from "../../errors.js";
import { withSpawnReadCap } from "../../routeCaps.js";
import { MOD_VALIDATION } from "../../../instances/mods.js";
import {
  CompatBusyError,
  CompatManifestMissingError,
} from "../../../instances/modCompat.js";
import {
  INSTANCE_PREFIX as P,
  type InstanceParams,
  type ResolveInstance,
} from "./shared.js";

const JOB_ID_RE = /^[a-f0-9-]{36}$/;
const { SLUG_RE, MC_VERSION_RE, LOADER_RE, VERSION_ID_RE } = MOD_VALIDATION;

export function registerModRoutes(
  app: FastifyInstance,
  resolve: ResolveInstance,
): void {
  // ── mods (v1): the bot's slug-only manifest, relocated here unchanged ─────
  app.get<{ Params: InstanceParams }>(`${P}/mods`,
    { schema: {
      summary: "Slugs of the active mods",
      description: "Disabled mods are left out: they are not on the running server.",
      tags: ["mods"],
      params: instanceParams(),
      response: { 200: ModSlugs, ...errors(404, 500) },
    } }, async (req, reply) => {
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
    { schema: {
      summary: "Installed mods with versions and enabled state",
      tags: ["mods"],
      params: instanceParams(),
      response: { 200: InstalledMods, ...errors(404, 500) },
    } },
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
    Body: {
      slug?: unknown;
      mcVersion?: unknown;
      modLoader?: unknown;
      versionId?: unknown;
    };
  }>(`${P}/mods`,
    { schema: {
      summary: "Install a mod",
      description:
        "Runs the suite's add-mod script. A handled failure is " +
        "`{ ok: false, error, code }` at 200.",
      tags: ["mods"],
      params: instanceParams(),
      requestBody: { required: true, schema: ModAddRequest },
      response: { 200: ModAddResult, ...errors(400, 404, 500) },
    } }, async (req, reply) => {
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
    const versionId = req.body?.versionId;
    if (versionId !== undefined && (typeof versionId !== "string" || !VERSION_ID_RE.test(versionId))) {
      return reply.status(400).send({ error: "Invalid versionId" });
    }

    try {
      return await entry.addMod(
        slug,
        mcVersion as string | undefined,
        modLoader as string | undefined,
        versionId as string | undefined,
      );
    } catch (err) {
      return internalError(reply, `mods/add ${req.params.id}`, err);
    }
  });

  app.delete<{ Params: InstanceParams & { slug: string } }>(
    `${P}/mods/:slug`,
    { schema: {
      summary: "Remove a mod",
      tags: ["mods"],
      params: instanceParams({ slug: "Mod slug or project id." }),
      response: { 200: ModRemoveResult, ...errors(400, 404, 500) },
    } },
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
    { schema: {
      summary: "Check installed mods for updates",
      tags: ["mods"],
      params: instanceParams(),
      querystring: queryParams({ mcVersion: "Check against this Minecraft version." }),
      response: { 200: ModUpdateCheck, ...errors(400, 404, 429, 500) },
    } },
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;
      const mcVersion = req.query.mcVersion;
      if (mcVersion !== undefined && !MC_VERSION_RE.test(mcVersion)) {
        return reply.status(400).send({ error: "Invalid mcVersion" });
      }
      return withSpawnReadCap(req.params.id, reply, async () => {
        try {
          return await entry.checkUpdates(mcVersion);
        } catch (err) {
          return internalError(reply, `mods/updates ${req.params.id}`, err);
        }
      });
    },
  );

  app.post<{ Params: InstanceParams & { slug: string } }>(
    `${P}/mods/:slug/update`,
    { schema: {
      summary: "Update one mod",
      tags: ["mods"],
      params: instanceParams({ slug: "Mod slug or project id." }),
      response: { 200: ModApplyResult, ...errors(400, 404, 500) },
    } },
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
    { schema: {
      summary: "Apply every available mod update",
      tags: ["mods"],
      params: instanceParams(),
      requestBody: { schema: ModUpdatesRequest },
      response: { 200: ModApplyResult, ...errors(400, 404, 500) },
    } },
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

  app.post<{ Params: InstanceParams & { slug: string } }>(
    `${P}/mods/:slug/disable`,
    { schema: {
      summary: "Disable a mod without uninstalling it",
      tags: ["mods"],
      params: instanceParams({ slug: "Mod slug or project id." }),
      response: { 200: ModToggleResult, ...errors(400, 404, 500) },
    } },
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;
      if (!SLUG_RE.test(req.params.slug)) {
        return reply.status(400).send({ error: "Invalid mod slug" });
      }
      try {
        return await entry.disableMod(req.params.slug);
      } catch (err) {
        return internalError(reply, `mods/disable ${req.params.id}`, err);
      }
    },
  );

  app.post<{ Params: InstanceParams & { slug: string } }>(
    `${P}/mods/:slug/enable`,
    { schema: {
      summary: "Re-enable a disabled mod",
      tags: ["mods"],
      params: instanceParams({ slug: "Mod slug or project id." }),
      response: { 200: ModToggleResult, ...errors(400, 404, 500) },
    } },
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;
      if (!SLUG_RE.test(req.params.slug)) {
        return reply.status(400).send({ error: "Invalid mod slug" });
      }
      try {
        return await entry.enableMod(req.params.slug);
      } catch (err) {
        return internalError(reply, `mods/enable ${req.params.id}`, err);
      }
    },
  );

  app.post<{
    Params: InstanceParams;
    Querystring: { refresh?: string };
    Body: { mcVersion?: unknown; refresh?: unknown };
  }>(
    `${P}/mods/compat`,
    { schema: {
      summary: "Start a mod compatibility check for a Minecraft version",
      description:
        "Checks every installed mod for a release on `mcVersion` and the " +
        "installed loader, in the background. One job runs per version: a " +
        "second request returns the running job. A finished answer is reused " +
        "for six hours unless `refresh` is set (body or `?refresh=1`) or a mod " +
        "changed.",
      tags: ["mods"],
      params: instanceParams(),
      querystring: queryParams({ refresh: "`1` skips the cached answer." }),
      requestBody: { required: true, schema: ModCompatRequest },
      response: { 202: ModCompatStarted, ...errors(400, 404, 429, 500) },
    } },
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;
      const mcVersion = req.body?.mcVersion;
      if (typeof mcVersion !== "string" || !MC_VERSION_RE.test(mcVersion)) {
        return reply.status(400).send({ error: "Invalid or missing mcVersion" });
      }
      const refresh = req.body?.refresh === true || req.query.refresh === "1";
      try {
        const started = await entry.startModCompat(mcVersion, { refresh });
        return reply.status(202).send(started);
      } catch (err) {
        if (err instanceof CompatManifestMissingError) {
          return reply.status(404).send({ error: err.message });
        }
        if (err instanceof CompatBusyError) {
          return reply.status(429).send({ error: err.message });
        }
        return internalError(reply, `mods/compat ${req.params.id}`, err);
      }
    },
  );

  app.get<{ Params: InstanceParams & { jobId: string } }>(
    `${P}/mods/compat/:jobId`,
    { schema: {
      summary: "Progress and result of a mod compatibility check",
      description:
        "Finished jobs are kept for about 15 minutes; after that the job id " +
        "is unknown (404) and the check can be started again.",
      tags: ["mods"],
      params: instanceParams({ jobId: "Job id from the start request." }),
      response: { 200: ModCompatJob, ...errors(400, 404) },
    } },
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;
      if (!JOB_ID_RE.test(req.params.jobId)) {
        return reply.status(400).send({ error: "Invalid job id" });
      }
      const job = entry.getModCompat(req.params.jobId);
      if (!job) return reply.status(404).send({ error: "Unknown or expired job" });
      return job;
    },
  );
}
