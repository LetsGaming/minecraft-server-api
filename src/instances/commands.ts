/**
 * Console dispatch. RCON when configured, `screen stuff` as the fallback —
 * the one place a command string reaches the server process.
 */
import { execFile } from "child_process";

import { log } from "../platform/logger.js";
import type { RconClient } from "../platform/rcon/client.js";
import type { InstanceConfig } from "../config/types.js";

/**
 * A-01: strip CR, LF, and all other control characters before handing a
 * string to `screen stuff`. A command containing \r would be interpreted
 * by screen as multiple key-presses. Exported for direct testing.
 */
export function sanitizeScreenCommand(command: string): string {
  return command.replace(/[\r\n\x00-\x1f\x7f]/g, "");
}

export interface CommandDispatch {
  /** The console's reply; null when the command went through the screen fallback. */
  result: string | null;
  via: "rcon" | "screen";
  sent: boolean;
  /** Why RCON was passed over, when the screen fallback carried the command. */
  rconError?: string;
}

/** Neither RCON nor the screen fallback could deliver the command. */
export class CommandDeliveryError extends Error {
  constructor(
    message: string,
    readonly rconError?: string,
  ) {
    super(message);
    this.name = "CommandDeliveryError";
  }
}

const RCON_ERROR_MAX = 200;

export function createCommands(cfg: InstanceConfig, rcon: RconClient | null) {
  async function sendCommand(command: string): Promise<CommandDispatch> {
    let rconError: string | undefined;
    if (rcon) {
      try {
        const cmd = command.startsWith("/") ? command.slice(1) : command;
        return { result: await rcon.send(cmd), via: "rcon", sent: true };
      } catch (err) {
        rconError = (err instanceof Error ? err.message : String(err)).slice(
          0,
          RCON_ERROR_MAX,
        );
      }
    }
    const formatted = command.startsWith("/") ? command : `/${command}`;
    const safe = sanitizeScreenCommand(formatted); // A-01

    await new Promise<void>((resolve, reject) => {
      execFile(
        "sudo",
        ["-n", "-u", cfg.linuxUser, "screen", "-S", cfg.id, "-X", "stuff", `${safe}\r`],
        { timeout: 15_000 },
        (err) => {
          if (err) {
            log.warn(cfg.id, `screen send failed: ${err.message}`);
            reject(new CommandDeliveryError("screen send failed", rconError));
            return;
          }
          resolve();
        },
      );
    });
    return {
      result: null,
      via: "screen",
      sent: true,
      ...(rconError !== undefined ? { rconError } : {}),
    };
  }

  return { sendCommand };
}
