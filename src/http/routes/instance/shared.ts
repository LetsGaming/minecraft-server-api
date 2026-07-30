/**
 * What every /instances/:id route group needs: the URL prefix, the params
 * shape, and the resolver that turns an id into an operations bundle or a
 * 404. Registration is split by resource in the sibling modules.
 */
import type { FastifyReply } from "fastify";

import type { InstanceConfig } from "../../../config/types.js";
import type { Operations } from "../../../instances/operations.js";

export const INSTANCE_PREFIX = "/instances/:id";

export interface InstanceParams {
  id: string;
}

export type InstanceEntry = Operations & { cfg: InstanceConfig };

/** Returns null after replying 404, so handlers early-return on falsy. */
export type ResolveInstance = (
  id: string,
  reply: FastifyReply,
) => InstanceEntry | null;
