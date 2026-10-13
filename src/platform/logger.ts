/**
 * Minimal leveled logger — same output format as minecraft-bot's logger
 * so wrapper and bot logs read identically when tailed side by side:
 *
 *   [2026-07-06 10:00:00] [INFO] [survival] message
 */

import fs from "node:fs";
import path from "node:path";

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

/** Code point ranges that can end a line, move a cursor, or reorder text. */
const UNSAFE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f], // C0 controls, including CR, LF and ESC
  [0x7f, 0x9f], // DEL and the C1 controls, including NEL
  [0x200b, 0x200f], // zero-width characters and directional marks
  [0x2028, 0x2029], // line and paragraph separators
  [0x202a, 0x202e], // bidi embeddings and overrides
  [0x2066, 0x2069], // bidi isolates
  [0xfeff, 0xfeff], // byte order mark
];

const NAMED_ESCAPES: Record<number, string> = { 10: "\\n", 13: "\\r", 9: "\\t" };

function isUnsafe(code: number): boolean {
  return UNSAFE_RANGES.some(([lo, hi]) => code >= lo && code <= hi);
}

/**
 * Makes untrusted text safe to put in a log line. Every line-breaking,
 * control, escape-sequence-introducing and bidi character becomes a visible
 * escape (an ANSI or OSC sequence loses its ESC and is left as inert text),
 * and the length is capped. Ordinary text, spaces included, is unchanged.
 */
export function logSafe(value: unknown, max = LOG_VALUE_MAX): string {
  const text =
    typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  let out = "";
  for (const ch of text) {
    if (out.length >= max) return out + "...";
    const code = ch.codePointAt(0)!;
    out += isUnsafe(code)
      ? (NAMED_ESCAPES[code] ?? "\\u" + code.toString(16).padStart(4, "0"))
      : ch;
  }
  return out;
}

const PLAIN_FIELD_VALUE = /^[\w.:/@+-]*$/;

/**
 * Renders fixed-name fields as `key=value` pairs. A value that is not plain
 * (spaces, `=`, quotes, anything neutralised) is JSON-quoted, so untrusted
 * text can never open a second pair or close the one it sits in.
 */
export function logFields(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .map(([key, value]) => {
      const safe = logSafe(value, LOG_VALUE_MAX);
      return `${key}=${PLAIN_FIELD_VALUE.test(safe) ? safe : JSON.stringify(safe)}`;
    })
    .join(" ");
}

const LOG_FILE_MAX_BYTES = 5 * 1024 * 1024;
const LOG_FILES_KEPT = 3;
const ROTATE_CHECK_EVERY = 200;

/**
 * Where lines are also written: MC_LOG_DIR, else ./logs of the working directory (the unit's
 * WorkingDirectory). An empty MC_LOG_DIR turns the file off; a test run is off unless it sets one.
 */
function logDir(): string | null {
  const set = process.env.MC_LOG_DIR;
  if (set !== undefined) return set === "" ? null : set;
  return process.env.VITEST ? null : path.join(process.cwd(), "logs");
}

let fileFailed = false;
let sinceCheck = ROTATE_CHECK_EVERY;

function rotate(file: string): void {
  if (fs.statSync(file).size < LOG_FILE_MAX_BYTES) return;
  for (let i = LOG_FILES_KEPT - 1; i >= 1; i--) {
    if (fs.existsSync(`${file}.${i}`)) fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
  }
  fs.renameSync(file, `${file}.1`);
}

function writeFile(line: string): void {
  const dir = logDir();
  if (!dir || fileFailed) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "api-server.log");
    if (++sinceCheck >= ROTATE_CHECK_EVERY) {
      sinceCheck = 0;
      if (fs.existsSync(file)) rotate(file);
    }
    fs.appendFileSync(file, `${line}\n`);
  } catch (err) {
    fileFailed = true;
    // eslint-disable-next-line no-console
    console.error(`[${ts()}] [WARN] [log] cannot write ${dir}, logging to the journal only: ${(err as Error).message}`);
  }
}

function emit(level: Level, scope: string, msg: string): void {
  const line = `[${ts()}] [${level}] [${logSafe(scope, 100)}] ${logSafe(msg, LOG_LINE_MAX)}`;
  writeFile(line);
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
