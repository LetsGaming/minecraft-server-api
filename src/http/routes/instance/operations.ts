/**
 * Long-running operations and the lifecycle event feed.
 *
 *   operations      POST /operations/upgrade           start a version upgrade
 *                                                      (a job; 202 + jobId),
 *                   GET  /operations/upgrade/current   the running or latest job,
 *                   GET  /operations/upgrade/:jobId    poll one job.
 *   lifecycle-events GET /events?since=<offset>        what start.sh recorded.
 *
 * Polling takes `?since=<seq>` and returns only the progress lines after it,
 * so a long job costs a few bytes per poll. A second start while anything
 * else holds the instance answers 423 with what holds it.
 */
import type { FastifyInstance } from "fastify";

import {
  LifecycleEvents,
  UpgradeJob,
  UpgradeRequest,
  UpgradeStarted,
} from "../../../contracts/schemas.js";
import { errors, instanceParams, queryParams } from "../../../contracts/routeSchema.js";
import { internalError } from "../../errors.js";
import { MOD_VALIDATION } from "../../../instances/mods.js";
import { MAX_COUNTDOWN_SECONDS, UpgradeUnavailableError } from "../../../instances/upgrades.js";
import {
  INSTANCE_PREFIX as P,
  type InstanceParams,
  type ResolveInstance,
} from "./shared.js";

const JOB_ID_RE = /^[a-f0-9-]{36}$/;
const MAX_EXPECTED_MODS = 500;

function sinceOf(raw: unknown): number | null {
  if (raw === undefined) return 0;
  if (typeof raw !== "string" || !/^\d{1,12}$/.test(raw)) return null;
  return Number(raw);
}

export function registerOperationRoutes(
  app: FastifyInstance,
  resolve: ResolveInstance,
): void {
  app.post<{
    Params: InstanceParams;
    Body: { mcVersion?: unknown; expectUnavailable?: unknown; countdownSeconds?: unknown };
  }>(
    `${P}/operations/upgrade`,
    { schema: {
      summary: "Start a Minecraft version upgrade",
      description:
        "Runs the suite's upgrade job in the background: players are warned, " +
        "the server is stopped and backed up, the new version and mods are " +
        "installed, and the server is started and watched. If it does not come " +
        "up, the mods without a build are disabled and it starts again; if that " +
        "fails too, this job's own backup is restored. Refused with 423 while " +
        "anything else holds the instance.",
      tags: ["operations"],
      params: instanceParams(),
      requestBody: { required: true, schema: UpgradeRequest },
      response: { 202: UpgradeStarted, ...errors(400, 404, 423, 500, 501) },
    } },
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;

      const { mcVersion, expectUnavailable, countdownSeconds } = req.body ?? {};
      if (typeof mcVersion !== "string" || !MOD_VALIDATION.MC_VERSION_RE.test(mcVersion)) {
        return reply.status(400).send({ error: "Invalid or missing mcVersion" });
      }
      let expected: string[] | undefined;
      if (expectUnavailable !== undefined) {
        if (
          !Array.isArray(expectUnavailable) ||
          expectUnavailable.length > MAX_EXPECTED_MODS ||
          !expectUnavailable.every((s) => typeof s === "string" && MOD_VALIDATION.SLUG_RE.test(s))
        ) {
          return reply.status(400).send({ error: "Invalid expectUnavailable" });
        }
        expected = expectUnavailable as string[];
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
          mcVersion,
          ...(expected ? { expectUnavailable: expected } : {}),
          ...(countdownSeconds !== undefined ? { countdownSeconds: countdownSeconds as number } : {}),
        });
        return reply.status(202).send(started);
      } catch (err) {
        if (err instanceof UpgradeUnavailableError) {
          return reply.status(501).send({ error: err.message });
        }
        return internalError(reply, `operations/upgrade ${req.params.id}`, err);
      }
    },
  );

  app.get<{ Params: InstanceParams; Querystring: { since?: string } }>(
    `${P}/operations/upgrade/current`,
    { schema: {
      summary: "The running or most recent upgrade",
      description:
        "The job this wrapper is running, else the latest one it knows, else " +
        "what the script left behind (so a wrapper restart does not lose the " +
        "outcome). 404 when there has been none.",
      tags: ["operations"],
      params: instanceParams(),
      querystring: queryParams({ since: "Progress sequence number; only newer lines are returned." }),
      response: { 200: UpgradeJob, ...errors(400, 404) },
    } },
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;
      const since = sinceOf(req.query.since);
      if (since === null) return reply.status(400).send({ error: "Invalid since" });
      const job = await entry.getCurrentUpgrade(since);
      if (!job) return reply.status(404).send({ error: "No upgrade has run" });
      return job;
    },
  );

  app.get<{
    Params: InstanceParams & { jobId: string };
    Querystring: { since?: string };
  }>(
    `${P}/operations/upgrade/:jobId`,
    { schema: {
      summary: "Progress and result of an upgrade",
      description:
        "Finished jobs are kept for a few hours (the last five); after that " +
        "the id is unknown (404).",
      tags: ["operations"],
      params: instanceParams({ jobId: "Job id from the start request." }),
      querystring: queryParams({ since: "Progress sequence number; only newer lines are returned." }),
      response: { 200: UpgradeJob, ...errors(400, 404) },
    } },
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;
      if (!JOB_ID_RE.test(req.params.jobId)) {
        return reply.status(400).send({ error: "Invalid job id" });
      }
      const since = sinceOf(req.query.since);
      if (since === null) return reply.status(400).send({ error: "Invalid since" });
      const job = entry.getUpgrade(req.params.jobId, since);
      if (!job) return reply.status(404).send({ error: "Unknown or expired job" });
      return job;
    },
  );

  app.get<{ Params: InstanceParams; Querystring: { since?: string } }>(
    `${P}/events`,
    { schema: {
      summary: "Server lifecycle events",
      description:
        "What start.sh recorded: JVM started and exited, restart scheduled, " +
        "crash loop gave up. Read with a byte-offset cursor: pass the previous " +
        "`next` as `since`. `reset` means the file was rotated and this read " +
        "starts from its beginning.",
      tags: ["operations"],
      params: instanceParams(),
      querystring: queryParams({ since: "Byte offset from the previous reply; default 0." }),
      response: { 200: LifecycleEvents, ...errors(400, 404, 500) },
    } },
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;
      const since = sinceOf(req.query.since);
      if (since === null) return reply.status(400).send({ error: "Invalid since" });
      try {
        return await entry.readLifecycleEvents(since);
      } catch (err) {
        return internalError(reply, `events ${req.params.id}`, err);
      }
    },
  );
}
