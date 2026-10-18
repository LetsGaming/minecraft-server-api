/**
 * Console dispatch. RCON when configured, `screen stuff` as the fallback —
 * the one place a command string reaches the server process.
 */
import { execFile } from "child_process";

import { log } from "../platform/logger.js";
import { RconNoReplyError, type RconClient } from "../platform/rcon/client.js";
import type { InstanceConfig } from "../config/types.js";

/**
 * Make a console line safe for `screen -X stuff`. Exported for direct testing.
 *
 * A-01: strip CR, LF and every other control character, which screen would
 * type as separate key-presses.
 *
 * W-001: `stuff` also processes its own escapes: `^M` and `\015` become
 * Enter, and `$VAR` / `${VAR}` expand from screen's environment. Stripping
 * real control characters does nothing about those, so `say hi^Mop Mallory`
 * ran a second command. Prefixing `\`, `^` and `$` with a backslash makes
 * screen type each one literally, so the line arrives exactly as sent
 * (tellraw JSON with `\"` included) and is always one line.
 */
export function sanitizeScreenCommand(command: string): string {
  return command
    .replace(/[\r\n\x00-\x1f\x7f]/g, "")
    .replace(/[\\^$]/g, (c) => `\\${c}`);
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
        // W-005: RCON took the command and only the reply went missing, so
        // the server has probably run it. Sending it again through screen
        // would run it twice (a second `give`, a second ban), so report it
        // as sent without a reply instead.
        if (err instanceof RconNoReplyError) {
          return { result: null, via: "rcon", sent: true, rconError };
        }
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
            // err.message embeds the whole command line, and so the command.
            const code = (err as NodeJS.ErrnoException).code;
            log.warn(cfg.id, `screen send failed${code !== undefined ? ` (${String(code)})` : ""}`);
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
