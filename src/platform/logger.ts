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

function emit(level: Level, scope: string, msg: string): void {
  const line = `[${ts()}] [${level}] [${scope}] ${msg}`;
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
