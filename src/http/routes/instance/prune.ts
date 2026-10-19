/**
 * Chunk pruning routes.
 *
 *   chunk-prune  GET/PUT /prune/settings         the saved parameters,
 *                GET  /prune/dimensions          the world's dimensions, no chunk read,
 *                GET  /prune/status              engine version, an unfinished delete,
 *                GET  /prune/plans/:planId/chunk one chunk of a plan, in full,
 *                GET  /prune/tiles/:dimension/:rx/:rz  a region drawn from above (PNG),
 *                POST /prune/scans               start a read-only scan (a job),
 *                GET  /prune/scans/:jobId        poll it (with progress),
 *                POST /prune/scans/:jobId/cancel stop it,
 *                GET  /prune/plans/:planId/map/:index  one dimension's map,
 *                POST /operations/prune          delete what a plan names: a job
 *                                                that stops the server, backs it
 *                                                up, deletes, starts it, and
 *                                                restores the backup on failure.
 *
 * Deleting is polled through the upgrade job routes (`/operations/upgrade/...`),
 * which report any job holding the instance. A scan changes nothing.
 */
import type { FastifyInstance } from "fastify";

import {
  PruneCancelled,
  PruneChunkInfo,
  PruneDimensions,
  PruneEngineStatus,
  PruneMap,
  PruneParams,
  PruneParamsRequest,
  PruneRequest,
  PruneScanJob,
  PruneScanStarted,
  UpgradeStarted,
} from "../../../contracts/schemas.js";
import type { PruneParams as PruneParamsBody } from "../../../contracts/wire.js";
import { errors, instanceParams, queryParams } from "../../../contracts/routeSchema.js";
import { internalError } from "../../errors.js";
import { PruneBusyError, PruneScriptError, PruneUnavailableError } from "../../../instances/prune.js";
import { PrunePlanMissingError, UpgradeUnavailableError, MAX_COUNTDOWN_SECONDS } from "../../../instances/upgrades.js";
import { PLAN_ID_RE } from "./operations.js";
import { withSpawnReadCap } from "../../routeCaps.js";
import {
  INSTANCE_PREFIX as P,
  type InstanceParams,
  type ResolveInstance,
} from "./shared.js";

const JOB_ID_RE = /^[a-f0-9-]{36}$/;
const DIMENSION_RE = /^[a-z0-9_.:-]{1,64}$/;
/** Roughly a maximal selection (2500 ops) plus zones; the global limit is far smaller. */
const PRUNE_BODY_LIMIT_BYTES = 512 * 1024;
const validDimension = (v: unknown): v is string =>
  typeof v === "string" && DIMENSION_RE.test(v) && v !== "." && v !== "..";
const MAX_ZONES = 100;
const MAX_DIMENSIONS = 32;
const MAX_COORD = 2_000_000;
const MAX_SELECTION_OPS = 2500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const coord = (v: unknown): v is number => Number.isInteger(v) && Math.abs(v as number) <= MAX_COORD;

/**
 * Checks the shape of a parameter body before it becomes a process argument.
 * Ranges are the script's business (it clamps); this only refuses what is not
 * the right kind of value. Returns null for a body that is not acceptable.
 */
export function parsePruneParams(body: unknown): Partial<PruneParamsBody> | null {
  if (!isRecord(body)) return null;
  const out: Partial<PruneParamsBody> = {};
  for (const key of ["thresholdMinutes", "spawnRadiusChunks", "playerRadiusChunks", "bufferChunks"] as const) {
    if (body[key] === undefined) continue;
    if (!Number.isInteger(body[key]) || (body[key] as number) < 0 || (body[key] as number) > 1_000_000) return null;
    out[key] = body[key] as number;
  }
  if (body.zones !== undefined) {
    if (!Array.isArray(body.zones) || body.zones.length > MAX_ZONES) return null;
    const zones = [];
    for (const z of body.zones) {
      if (!isRecord(z) || !validDimension(z.dimension)) return null;
      if (![z.x1, z.z1, z.x2, z.z2].every(coord)) return null;
      const name = typeof z.name === "string" ? z.name.slice(0, 64) : "";
      zones.push({ name, dimension: z.dimension, x1: z.x1 as number, z1: z.z1 as number, x2: z.x2 as number, z2: z.z2 as number });
    }
    out.zones = zones;
  }
  if (body.dimensions !== undefined && body.dimensions !== null) {
    if (
      !Array.isArray(body.dimensions) ||
      body.dimensions.length > MAX_DIMENSIONS ||
      !body.dimensions.every(validDimension)
    ) {
      return null;
    }
    out.dimensions = body.dimensions as string[];
  } else if (body.dimensions === null) {
    out.dimensions = null;
  }
  if (body.buildProtection !== undefined) {
    if (body.buildProtection !== "off" && body.buildProtection !== "likely") return null;
    out.buildProtection = body.buildProtection;
  }
  if (body.selection !== undefined) {
    const sel = body.selection;
    if (!isRecord(sel) || !Array.isArray(sel.ops) || sel.ops.length > MAX_SELECTION_OPS) return null;
    if (sel.allowProtected !== undefined && typeof sel.allowProtected !== "boolean") return null;
    const ops = [];
    for (const op of sel.ops) {
      if (!isRecord(op) || !validDimension(op.dimension)) return null;
      if (op.mode !== "add" && op.mode !== "remove") return null;
      if (![op.x1, op.z1, op.x2, op.z2].every(coord)) return null;
      ops.push({ dimension: op.dimension, mode: op.mode as "add" | "remove", x1: op.x1 as number, z1: op.z1 as number, x2: op.x2 as number, z2: op.z2 as number });
    }
    out.selection = { ops, allowProtected: sel.allowProtected === true };
  }
  return out;
}

export function registerPruneRoutes(app: FastifyInstance, resolve: ResolveInstance): void {
  app.get<{ Params: InstanceParams }>(
    `${P}/prune/settings`,
    { schema: {
      summary: "The saved chunk prune parameters",
      description: "What a scan uses when none are given. Defaults until saved.",
      tags: ["prune"],
      params: instanceParams(),
      response: { 200: PruneParams, ...errors(404, 429, 500, 501) },
    } },
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;
      return withSpawnReadCap(req.params.id, reply, async () => {
        try {
          return await entry.getPruneSettings();
        } catch (err) {
          if (err instanceof PruneUnavailableError) return reply.status(501).send({ error: err.message });
          return internalError(reply, `prune/settings ${req.params.id}`, err);
        }
      });
    },
  );

  app.put<{ Params: InstanceParams; Body: unknown }>(
    `${P}/prune/settings`,
    { bodyLimit: PRUNE_BODY_LIMIT_BYTES, schema: {
      summary: "Save the chunk prune parameters",
      description: "Values are clamped to their limits by the setup suite; the reply is what was stored.",
      tags: ["prune"],
      params: instanceParams(),
      requestBody: { required: true, schema: PruneParamsRequest },
      response: { 200: PruneParams, ...errors(400, 404, 413, 500, 501) },
    } },
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;
      const params = parsePruneParams(req.body);
      if (!params) return reply.status(400).send({ error: "Invalid parameters" });
      try {
        return await entry.setPruneSettings(params as PruneParamsBody);
      } catch (err) {
        if (err instanceof PruneUnavailableError) return reply.status(501).send({ error: err.message });
        return internalError(reply, `prune/settings ${req.params.id}`, err);
      }
    },
  );

  app.get<{ Params: InstanceParams }>(
    `${P}/prune/dimensions`,
    { schema: {
      summary: "The dimensions of the world",
      description:
        "Names and region-file counts, from directory listings only (no chunk is read), " +
        "so a client can offer a choice before scanning. A scan limited to chosen " +
        "dimensions reads only those.",
      tags: ["prune"],
      params: instanceParams(),
      response: { 200: PruneDimensions, ...errors(404, 429, 500, 501) },
    } },
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;
      return withSpawnReadCap(req.params.id, reply, async () => {
        try {
          return await entry.getPruneDimensions();
        } catch (err) {
          if (err instanceof PruneUnavailableError) return reply.status(501).send({ error: err.message });
          return internalError(reply, `prune/dimensions ${req.params.id}`, err);
        }
      });
    },
  );

  app.get<{ Params: InstanceParams }>(
    `${P}/prune/status`,
    { schema: {
      summary: "The prune engine's status",
      description:
        "The engine version, and `unfinishedApply` when a delete started and never " +
        "finished (the world may be half pruned; restore the job's backup).",
      tags: ["prune"],
      params: instanceParams(),
      response: { 200: PruneEngineStatus, ...errors(404, 429, 500, 501) },
    } },
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;
      return withSpawnReadCap(req.params.id, reply, async () => {
        try {
          return await entry.getPruneStatus();
        } catch (err) {
          if (err instanceof PruneUnavailableError) return reply.status(501).send({ error: err.message });
          return internalError(reply, `prune/status ${req.params.id}`, err);
        }
      });
    },
  );

  app.post<{ Params: InstanceParams & { jobId: string } }>(
    `${P}/prune/scans/:jobId/cancel`,
    { schema: {
      summary: "Stop a running scan",
      description:
        "A scan only reads, so stopping it is safe; what it already read stays cached " +
        "for the next scan. The job then reports `failed` with error `cancelled`.",
      tags: ["prune"],
      params: instanceParams({ jobId: "Job id from the start request." }),
      response: { 200: PruneCancelled, ...errors(400, 404) },
    } },
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;
      if (!JOB_ID_RE.test(req.params.jobId)) return reply.status(400).send({ error: "Invalid job id" });
      if (!entry.cancelPruneScan(req.params.jobId)) {
        return reply.status(404).send({ error: "No such running scan" });
      }
      return { cancelled: true };
    },
  );

  app.post<{ Params: InstanceParams; Body: unknown }>(
    `${P}/prune/scans`,
    { bodyLimit: PRUNE_BODY_LIMIT_BYTES, schema: {
      summary: "Scan for unused chunks",
      description:
        "Reads every region file and stores a plan; changes nothing and is safe on " +
        "a running server (the answer is approximate while chunks are being written). " +
        "Without a body the saved settings are used. One scan runs at a time.",
      tags: ["prune"],
      params: instanceParams(),
      requestBody: { required: false, schema: PruneParamsRequest },
      response: { 202: PruneScanStarted, ...errors(400, 404, 413, 429, 500, 501) },
    } },
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;
      let params: Partial<PruneParamsBody> | undefined;
      if (req.body !== undefined && req.body !== null) {
        const parsed = parsePruneParams(req.body);
        if (!parsed) return reply.status(400).send({ error: "Invalid parameters" });
        params = parsed;
      }
      try {
        const started = await entry.startPruneScan(params as PruneParamsBody | undefined);
        return reply.status(202).send(started);
      } catch (err) {
        if (err instanceof PruneUnavailableError) return reply.status(501).send({ error: err.message });
        if (err instanceof PruneBusyError) return reply.status(429).send({ error: err.message });
        return internalError(reply, `prune/scans ${req.params.id}`, err);
      }
    },
  );

  app.get<{ Params: InstanceParams & { jobId: string } }>(
    `${P}/prune/scans/:jobId`,
    { schema: {
      summary: "Progress and result of a prune scan",
      description: "The summary appears once `state` is `done`. The last few scans are kept.",
      tags: ["prune"],
      params: instanceParams({ jobId: "Job id from the start request." }),
      response: { 200: PruneScanJob, ...errors(400, 404) },
    } },
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;
      if (!JOB_ID_RE.test(req.params.jobId)) return reply.status(400).send({ error: "Invalid job id" });
      const job = entry.getPruneScan(req.params.jobId);
      if (!job) return reply.status(404).send({ error: "Unknown or expired scan" });
      return job;
    },
  );

  app.get<{ Params: InstanceParams & { dimension: string; rx: string; rz: string } }>(
    `${P}/prune/tiles/:dimension/:rx/:rz`,
    { schema: {
      summary: "A region drawn from above",
      description:
        "A 512 x 512 PNG, one pixel per block, of the region's terrain (no biome tint). Drawn when " +
        "first asked for and cached by the region file's fingerprint, so an edited region gets a new " +
        "picture. Chunks that cannot be read, or predate Minecraft 1.18, are transparent. At most two " +
        "tiles are drawn at once per instance. Supports If-None-Match.",
      tags: ["prune"],
      params: instanceParams({
        dimension: "Dimension id from the summary.",
        rx: "Region x coordinate.",
        rz: "Region z coordinate.",
      }),
      requestHeaders: { "if-none-match": { description: "The ETag of a tile already held.", required: false } },
      produces: { 200: "image/png", 304: "image/png" },
      response: { 200: { type: "string" }, 304: { type: "string" }, ...errors(400, 404, 429, 500, 501) },
    } },
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;
      const { dimension } = req.params;
      const rx = Number(req.params.rx);
      const rz = Number(req.params.rz);
      if (!validDimension(dimension) || !Number.isInteger(rx) || !Number.isInteger(rz) || Math.abs(rx) > 100_000 || Math.abs(rz) > 100_000) {
        return reply.status(400).send({ error: "Invalid dimension or region" });
      }
      return withSpawnReadCap(req.params.id, reply, async () => {
        try {
          const tile = await entry.readPruneTile(dimension, rx, rz);
          if (tile === null) return reply.status(404).send({ error: "No such region" });
          reply.header("etag", tile.etag).header("cache-control", "private, max-age=0, must-revalidate");
          if (req.headers["if-none-match"] === tile.etag) return reply.status(304).send();
          return reply.type("image/png").send(tile.png);
        } catch (err) {
          if (err instanceof PruneUnavailableError) return reply.status(501).send({ error: err.message });
          return internalError(reply, `prune/tile ${req.params.id}`, err);
        }
      });
    },
  );

  app.get<{ Params: InstanceParams & { planId: string }; Querystring: { dimension?: string; cx?: string; cz?: string } }>(
    `${P}/prune/plans/:planId/chunk`,
    { schema: {
      summary: "One chunk of a plan, in full",
      description:
        "Reads the chunk now and reports what it contains (block entities, structures), how long " +
        "players were near it, how much space it takes, whether the plan deletes it and which " +
        "protections cover it. For the map's inspector; the map itself stays light.",
      tags: ["prune"],
      params: instanceParams({ planId: "Plan id from the scan summary." }),
      querystring: queryParams({
        dimension: "Dimension id from the summary.",
        cx: "Chunk x coordinate.",
        cz: "Chunk z coordinate.",
      }),
      response: { 200: PruneChunkInfo, ...errors(400, 404, 429, 500, 501) },
    } },
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;
      const { dimension, cx, cz } = req.query;
      if (!PLAN_ID_RE.test(req.params.planId)) return reply.status(400).send({ error: "Invalid plan" });
      if (!validDimension(dimension)) return reply.status(400).send({ error: "Invalid dimension" });
      const x = Number(cx);
      const z = Number(cz);
      if (!coord(x) || !coord(z)) return reply.status(400).send({ error: "Invalid chunk" });
      return withSpawnReadCap(req.params.id, reply, async () => {
        try {
          const info = await entry.inspectPruneChunk(req.params.planId, dimension, x, z);
          if (info === null) return reply.status(404).send({ error: "Unknown or expired plan" });
          return info;
        } catch (err) {
          if (err instanceof PruneUnavailableError) return reply.status(501).send({ error: err.message });
          return internalError(reply, `prune/chunk ${req.params.id}`, err);
        }
      });
    },
  );

  app.get<{ Params: InstanceParams & { planId: string; index: string } }>(
    `${P}/prune/plans/:planId/map/:index`,
    { schema: {
      summary: "The map of one dimension of a scan",
      description:
        "Per region, base64 bytes per chunk: its class (0 empty, 1 would be deleted, " +
        "2 busy, 3 protected, 4 buffer, 5 unreadable) and a heat level of its " +
        "inhabited time. `index` is the dimension's position in the summary.",
      tags: ["prune"],
      params: instanceParams({ planId: "Plan id from the scan summary.", index: "Dimension index." }),
      response: { 200: PruneMap, ...errors(400, 404, 500) },
    } },
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;
      if (!PLAN_ID_RE.test(req.params.planId) || !/^\d{1,3}$/.test(req.params.index)) {
        return reply.status(400).send({ error: "Invalid plan or dimension" });
      }
      try {
        const text = await entry.readPruneMap(req.params.planId, Number(req.params.index));
        if (text === null) return reply.status(404).send({ error: "Unknown or expired plan" });
        // Already JSON text, possibly megabytes: sent as it is, not parsed and re-serialized.
        return reply.type("application/json").send(text);
      } catch (err) {
        if (err instanceof PruneScriptError) return reply.status(500).send({ error: "The map is too large to send" });
        return internalError(reply, `prune/map ${req.params.id}`, err);
      }
    },
  );

  app.post<{ Params: InstanceParams; Body: { planId?: unknown; countdownSeconds?: unknown } }>(
    `${P}/operations/prune`,
    { schema: {
      summary: "Delete the chunks a scan found",
      description:
        "Runs in the background: players are warned, the server is stopped and " +
        "backed up, the plan is applied (a fresh scan must still agree with at " +
        "least 90 % of it), and the server is started. If the prune fails or the " +
        "server does not come up, this job's own backup is restored. Poll it with " +
        "`GET /operations/upgrade/:jobId`. Refused with 423 while anything else " +
        "holds the instance.",
      tags: ["prune"],
      params: instanceParams(),
      requestBody: { required: true, schema: PruneRequest },
      response: { 202: UpgradeStarted, ...errors(400, 404, 423, 500, 501) },
    } },
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;
      const { planId, countdownSeconds } = req.body ?? {};
      if (typeof planId !== "string" || !PLAN_ID_RE.test(planId)) {
        return reply.status(400).send({ error: "Invalid or missing planId" });
      }
      if (
        countdownSeconds !== undefined &&
        (typeof countdownSeconds !== "number" ||
          !Number.isInteger(countdownSeconds) ||
          countdownSeconds < 0 ||
          countdownSeconds > MAX_COUNTDOWN_SECONDS)
      ) {
        return reply.status(400).send({ error: "Invalid countdownSeconds" });
      }
      try {
        const started = await entry.startUpgrade({
          pruneOnly: true,
          prunePlan: planId,
          ...(countdownSeconds !== undefined ? { countdownSeconds: countdownSeconds as number } : {}),
        });
        return reply.status(202).send(started);
      } catch (err) {
        if (err instanceof UpgradeUnavailableError) return reply.status(501).send({ error: err.message });
        if (err instanceof PrunePlanMissingError) return reply.status(404).send({ error: err.message });
        return internalError(reply, `operations/prune ${req.params.id}`, err);
      }
    },
  );
}
