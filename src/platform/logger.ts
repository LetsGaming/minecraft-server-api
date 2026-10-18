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

/**
 * W-020: lines waiting for the file, written by one async append per batch.
 * Every line used to cost an existsSync, a statSync and an appendFileSync on
 * the event loop, so a flood of 429s blocked the requests it was logging.
 */
let queue: string[] = [];
let flushing: Promise<void> | null = null;
/** Size of the current file as far as this process knows; null until first read. */
let knownSize: number | null = null;

async function rotateIfLarge(file: string): Promise<void> {
  if (knownSize === null) {
    try {
      knownSize = (await fs.promises.stat(file)).size;
    } catch {
      knownSize = 0;
    }
  }
  if (knownSize < LOG_FILE_MAX_BYTES) return;
  for (let i = LOG_FILES_KEPT - 1; i >= 1; i--) {
    await fs.promises.rename(`${file}.${i}`, `${file}.${i + 1}`).catch(() => undefined);
  }
  await fs.promises.rename(file, `${file}.1`).catch(() => undefined);
  knownSize = 0;
}

async function drain(dir: string): Promise<void> {
  while (queue.length > 0 && !fileFailed) {
    const batch = queue.join("");
    queue = [];
    try {
      await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, "api-server.log");
      await rotateIfLarge(file);
      await fs.promises.appendFile(file, batch, { mode: 0o600 });
      knownSize = (knownSize ?? 0) + Buffer.byteLength(batch);
    } catch (err) {
      fileFailed = true;
      queue = [];
      // eslint-disable-next-line no-console
      console.error(`[${ts()}] [WARN] [log] cannot write ${dir}, logging to the journal only: ${(err as Error).message}`);
    }
  }
}

function writeFile(line: string): void {
  const dir = logDir();
  if (!dir || fileFailed) return;
  queue.push(`${line}\n`);
  flushing ??= new Promise<void>((resolve) => setImmediate(resolve))
    .then(() => drain(dir))
    .finally(() => {
      flushing = null;
    });
}

/** Resolves once every line logged so far has reached the file. */
export async function flushLog(): Promise<void> {
  while (flushing) await flushing;
}

// Whatever is still queued when the process exits goes out synchronously.
process.on("exit", () => {
  const dir = logDir();
  if (!dir || fileFailed || queue.length === 0) return;
  try {
    fs.appendFileSync(path.join(dir, "api-server.log"), queue.join(""), { mode: 0o600 });
  } catch {
    /* nothing left to report it to */
  }
});

/**
 * Log at most once per `intervalMs` under `key`, counting what was held back.
 * For lines a client can trigger at request rate (429s).
 */
const throttled = new Map<string, { at: number; suppressed: number }>();
export function logThrottled(
  key: string,
  intervalMs: number,
  write: (suppressedSinceLast: number) => void,
): void {
  const now = Date.now();
  const entry = throttled.get(key);
  if (entry && now - entry.at < intervalMs) {
    entry.suppressed++;
    return;
  }
  throttled.set(key, { at: now, suppressed: 0 });
  write(entry?.suppressed ?? 0);
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
