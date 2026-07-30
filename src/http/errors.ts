/**
 * The single 500 path. SEC-05: bodies used to carry String(err) — absolute
 * paths, sudo and stderr fragments included. Detail goes to the wrapper log;
 * the client gets a fixed body in the historical `{ error }` shape the bot's
 * helpers surface verbatim.
 */
import type { FastifyReply } from "fastify";

import { log } from "../platform/logger.js";

export function internalError(
  reply: FastifyReply,
  context: string,
  err: unknown,
): FastifyReply {
  const msg = err instanceof Error ? err.message : String(err);
  log.error("routes", `${context}: ${msg}`);
  return reply.status(500).send({ error: "Internal server error" });
}
