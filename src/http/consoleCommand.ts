export const COMMAND_MAX_BYTES = 1400;

const CONTROL_CHAR = /\p{C}/u;

export type CommandCheck =
  | { ok: true; command: string }
  | { ok: false; reason: "missing" | "control_chars" | "too_long" };

type CommandFailure = Extract<CommandCheck, { ok: false }>;

export const COMMAND_ERRORS = {
  missing: "Missing command",
  control_chars: "command must not contain control characters",
  too_long: `command must be ≤ ${COMMAND_MAX_BYTES} bytes`,
} as const satisfies Record<CommandFailure["reason"], string>;

export function checkConsoleCommand(input: unknown): CommandCheck {
  if (typeof input !== "string" || input.trim() === "")
    return { ok: false, reason: "missing" };
  const command = input.trim();
  if (CONTROL_CHAR.test(command)) return { ok: false, reason: "control_chars" };
  if (Buffer.byteLength(command, "utf8") > COMMAND_MAX_BYTES)
    return { ok: false, reason: "too_long" };
  return { ok: true, command };
}
