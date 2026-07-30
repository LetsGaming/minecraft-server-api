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

export function createCommands(cfg: InstanceConfig, rcon: RconClient | null) {
async function sendCommand(command: string): Promise<string | null> {
  if (rcon) {
    try {
      const cmd = command.startsWith("/") ? command.slice(1) : command;
      return await rcon.send(cmd);
    } catch {
      // fall through to screen
    }
  }
  const formatted = command.startsWith("/") ? command : `/${command}`;
  const safe = sanitizeScreenCommand(formatted); // A-01

  await new Promise<void>((resolve) => {
    execFile(
      "sudo",
      ["-n", "-u", cfg.linuxUser, "screen", "-S", cfg.id, "-X", "stuff", `${safe}\r`],
      { timeout: 15_000 },
      (err) => {
        if (err) log.warn(cfg.id, `screen send failed: ${err.message}`);
        resolve();
      },
    );
  });
  return null;
}

  return { sendCommand };
}
