/**
 * The single 500 path. SEC-05: bodies used to carry String(err) — absolute
 * paths, sudo and stderr fragments included. Detail goes to the wrapper log;
 * the client gets a fixed body in the historical `{ error }` shape the bot's
 * helpers surface verbatim.
 */
import type { FastifyReply } from "fastify";

import { log } from "../platform/logger.js";
import { OperationBusyError } from "../instances/operationSlot.js";

export function internalError(
  reply: FastifyReply,
  context: string,
  err: unknown,
): FastifyReply {
  // Not a fault: the instance is busy with something that must not overlap.
  if (err instanceof OperationBusyError) {
    return reply.status(423).send({
      error: `Another operation is running (${err.busy.kind}). Try again when it has finished.`,
      busy: err.busy,
    });
  }
  const msg = err instanceof Error ? err.message : String(err);
  log.error("routes", `${context}: ${msg}`);
  return reply.status(500).send({ error: "Internal server error" });
}
