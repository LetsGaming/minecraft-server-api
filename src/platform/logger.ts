/**
 * Minimal leveled logger — same output format as minecraft-bot's logger
 * so wrapper and bot logs read identically when tailed side by side:
 *
 *   [2026-07-06 10:00:00] [INFO] [survival] message
 */

type Level = "INFO" | "WARN" | "ERROR" | "DEBUG";

function ts(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

const LOG_VALUE_MAX = 500;
const LOG_LINE_MAX = 4000;

/**
 * Makes untrusted text safe to put in a log line: CR, LF, tab, ESC and every
 * other control character become visible escapes (so input cannot forge a
 * second line or drive a terminal), and the length is capped.
 */
export function logSafe(value: unknown, max = LOG_VALUE_MAX): string {
  const text =
    typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  const escaped = text.replace(
    /[\u0000-\u001f\u007f-\u009f]/g,
    (c) => {
      if (c === "\n") return "\\n";
      if (c === "\r") return "\\r";
      if (c === "\t") return "\\t";
      return "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0");
    },
  );
  return escaped.length > max ? escaped.slice(0, max) + "..." : escaped;
}

function emit(level: Level, scope: string, msg: string): void {
  const line = `[${ts()}] [${level}] [${scope}] ${logSafe(msg, LOG_LINE_MAX)}`;
  // eslint-disable-next-line no-console
  if (level === "ERROR" || level === "WARN") console.error(line);
  // eslint-disable-next-line no-console
  else console.log(line);
}

export const log = {
  info: (scope: string, msg: string) => emit("INFO", scope, msg),
  warn: (scope: string, msg: string) => emit("WARN", scope, msg),
  error: (scope: string, msg: string) => emit("ERROR", scope, msg),
  debug: (scope: string, msg: string) => {
    if (process.env.MC_DEBUG === "true") emit("DEBUG", scope, msg);
  },
};
