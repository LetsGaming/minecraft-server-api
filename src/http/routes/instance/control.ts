/**
 * The two routes that change something: console dispatch and script
 * execution. Every guard that keeps a client from reaching a shell lives
 * here or in the validators it calls.
 */
import type { FastifyInstance } from "fastify";

import { internalError } from "../../errors.js";
import { validateArgs } from "../../validation.js";
import { checkConsoleCommand, COMMAND_ERRORS } from "../../consoleCommand.js";
import { SCRIPT_MAP } from "../../../instances/scripts.js";
import {
  INSTANCE_PREFIX as P,
  type InstanceParams,
  type ResolveInstance,
} from "./shared.js";

export function registerControlRoutes(
  app: FastifyInstance,
  resolve: ResolveInstance,
): void {
  app.post<{ Params: InstanceParams; Body: { command?: unknown } }>(
    `${P}/command`,
    async (req, reply) => {
      const entry = resolve(req.params.id, reply);
      if (!entry) return;

      const check = checkConsoleCommand(req.body?.command);
      if (!check.ok) {
        return reply.status(400).send({ error: COMMAND_ERRORS[check.reason] });
      }

      try {
        return { result: await entry.sendCommand(check.command) };
      } catch (err) {
        return internalError(reply, `command ${req.params.id}`, err);
      }
    },
  );

  app.post<{
    Params: InstanceParams;
    Body: { action?: unknown; args?: unknown };
  }>(`${P}/scripts/run`, async (req, reply) => {
    const entry = resolve(req.params.id, reply);
    if (!entry) return;
    const action = req.body?.action;
    const args = req.body?.args;
    if (!action || typeof action !== "string") {
      return reply.status(400).send({ error: "Missing action" });
    }
    // SEC-05 companion: an unknown action is CLIENT input error, not an
    // internal failure — reject it here with a helpful 400 (echoing the
    // client's own input is safe) instead of letting runScript throw
    // into the generic-500 path and losing the feedback the bot
    // surfaces to admins.
    if (!(action in SCRIPT_MAP)) {
      return reply
        .status(400)
        .send({ error: `Unknown script action: ${action.slice(0, 64)}` });
    }
    // F-001: validate args before passing to spawn()
    if (!validateArgs(args)) {
      return reply.status(400).send({
        error:
          "Invalid args: must be an array of up to 5 strings containing only " +
          "alphanumeric, '.', '@', or '-' characters (max 128 chars each)",
      });
    }
    try {
      return await entry.runScript(action, args);
    } catch (err) {
      return internalError(reply, `scripts/run ${req.params.id}`, err);
    }
  });
}
