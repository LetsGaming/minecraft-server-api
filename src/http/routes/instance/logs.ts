/**
 * Log reads: a bounded tail, and the SSE stream.
 *
 * The stream is the one route that leaves Fastify's reply lifecycle, so it
 * is kept apart from the request/response routes rather than buried among
 * them.
 */
import type { FastifyInstance } from "fastify";

import { LogTail } from "../../../contracts/schemas.js";
import {
  errors,
  instanceParams,
  queryParams,
} from "../../../contracts/routeSchema.js";
import { internalError } from "../../errors.js";
import { sanitizeLines } from "../../validation.js";
import type { LogStreamAPI } from "../../../platform/logStream.js";
import { endRequest } from "../../../platform/metrics.js";
import {
  INSTANCE_PREFIX as P,
  type InstanceParams,
  type ResolveInstance,
} from "./shared.js";

const HEARTBEAT_MS = 20_000;

export function registerLogRoutes(
  app: FastifyInstance,
  resolve: ResolveInstance,
  logStreamAPI: LogStreamAPI,
): void {
  app.get<{ Params: InstanceParams; Querystring: { lines?: string } }>(
    `${P}/logs/tail`,
    {
      schema: {
        summary: "The end of the server log",
        tags: ["logs"],
        params: instanceParams(),
        querystring: queryParams({
          lines: "Line count, clamped to 1..500. Default 10.",
        }),
        response: { 200: LogTail, ...errors(404, 500) },
      },
    },
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;
      const lines = sanitizeLines(req.query.lines);
      try {
        return { output: await entry.tailLog(lines) };
      } catch (err) {
        return internalError(reply, `logs/tail ${req.params.id}`, err);
      }
    },
  );

  app.get<{ Params: InstanceParams }>(
    `${P}/logs/stream`,
    {
      schema: {
        summary: "Live log lines as server-sent events",
        description:
          "Holds the connection open. Each log line is one `data:` event; " +
          "comment lines (`:heartbeat`) keep idle connections alive.",
        tags: ["logs"],
        params: instanceParams(),
        produces: { 200: "text/event-stream" },
        response: { 200: { type: "string" }, ...errors(404, 503) },
      },
    },
    (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;

      // SEC-02: register (and cap-check) BEFORE hijacking so the over-cap
      // case is still a normal Fastify reply. Nothing is written to the
      // stored response until the next log line, and hijack + writeHead
      // happen synchronously below — no fan-out can interleave.
      if (!logStreamAPI.addClient(req.params.id, reply.raw)) {
        return reply
          .status(503)
          .send({ error: "Too many log stream clients for this instance" });
      }

      // SSE: take over the raw socket; Fastify must not touch the reply after this.
      reply.hijack();
      // Fastify never runs onResponse for a hijacked reply, so the in-flight
      // slot taken by the onRequest hook would be held for the life of the
      // stream. A stream is a subscription, not work in progress: release the
      // slot right away.
      endRequest();
      const res = reply.raw;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(":connected\n\n");

      const hb = setInterval(() => {
        try {
          res.write(":heartbeat\n\n");
        } catch {
          clearInterval(hb);
        }
      }, HEARTBEAT_MS);

      req.raw.on("close", () => {
        clearInterval(hb);
        logStreamAPI.removeClient(req.params.id, res);
      });
    },
  );
}
