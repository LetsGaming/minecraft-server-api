/**
 * W-006: what the config editor may show and change.
 *
 * The editor serves `server.properties` and `plugins/` next to mod configs,
 * and both hold credentials (`rcon.password`, a DiscordSRV token, a
 * LuckPerms database password) and switches that decide who may join or
 * command the server (`online-mode`, `enable-rcon`, `white-list`). Someone
 * handed "tune the mods" was handed all of that too.
 *
 * Two rules, both line-based so they work on every text format the editor
 * lists without parsing any of them:
 *
 * - **Secrets are redacted on read** and put back on write. A line whose key
 *   looks like a credential has its value replaced by {@link REDACTED}; a
 *   write that sends that line back unchanged gets the real value restored,
 *   and a write that still carries the marker anywhere else is refused, so a
 *   placeholder can never land on disk.
 * - **Protected `server.properties` keys** may only change when the request
 *   says it may (`allowProtected`), which the bot sends for sysadmins only.
 */

/** Stands in for a secret value in what a client sees. */
export const REDACTED = "<redacted by mc-api-server>";

/** Key names that hold a credential, in any format. */
const SECRET_KEY = /(pass(word|wd|phrase)?|secret|token|api[-_.]?key|private[-_.]?key|credential)/i;

/**
 * One `key <sep> value` line: properties/ini/cfg/toml (`=`, `:`), YAML
 * (`key: value`), and a single-line JSON member (`"key": "value",`).
 * Group 1 is everything up to the value, group 2 the value, group 3 any
 * trailing JSON comma.
 */
const KEY_VALUE_LINE =
  /^(\s*(?:[-#;]\s*)?"?([\w.\-]+)"?\s*[:=]\s*)(.*?)(\s*,?\s*)$/;

function isSecretLine(line: string): RegExpExecArray | null {
  const m = KEY_VALUE_LINE.exec(line);
  if (!m) return null;
  const key = m[2]!;
  const value = m[3]!.trim();
  if (!SECRET_KEY.test(key)) return null;
  // Nothing to hide: an empty value, an empty string, or a YAML/JSON block opener.
  if (value === "" || value === '""' || value === "''") return null;
  if (value === "{" || value === "[" || value === "|" || value === ">") return null;
  return m;
}

function redactLine(line: string): string {
  const m = isSecretLine(line);
  if (!m) return line;
  const value = m[3]!.trim();
  const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : "";
  return `${m[1]}${quote}${REDACTED}${quote}${m[4]}`;
}

function splitLines(text: string): { lines: string[]; eol: string } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  return { lines: text.split(/\r?\n/), eol };
}

/** The text a client may see. */
export function redactSecrets(text: string): string {
  const { lines, eol } = splitLines(text);
  return lines.map(redactLine).join(eol);
}

/**
 * Put the real values back into a client's text. Every line that still
 * reads exactly like a redacted line of the current file is replaced by
 * that original line (in order, for keys that repeat). Returns null when a
 * placeholder is left that no original line accounts for.
 */
export function restoreSecrets(submitted: string, current: string): string | null {
  const originals = new Map<string, string[]>();
  for (const line of splitLines(current).lines) {
    const shown = redactLine(line);
    if (shown === line) continue;
    const list = originals.get(shown) ?? [];
    list.push(line);
    originals.set(shown, list);
  }
  const { lines, eol } = splitLines(submitted);
  const out: string[] = [];
  for (const line of lines) {
    const queue = originals.get(line);
    if (queue && queue.length > 0) {
      out.push(queue.shift()!);
      continue;
    }
    if (line.includes(REDACTED)) return null;
    out.push(line);
  }
  return out.join(eol);
}

/**
 * `server.properties` keys that decide who may join, who may command the
 * server, or where its data lives. `level-name` also moves where stats are
 * read and deleted.
 */
export const PROTECTED_PROPERTIES: readonly string[] = [
  "enable-rcon",
  "rcon.password",
  "rcon.port",
  "enable-query",
  "query.port",
  "online-mode",
  "white-list",
  "enforce-whitelist",
  "op-permission-level",
  "function-permission-level",
  "enforce-secure-profile",
  "level-name",
  "server-ip",
  "server-port",
];

function isProtectedProperty(key: string): boolean {
  return PROTECTED_PROPERTIES.includes(key) || key.startsWith("management-server");
}

function parseProperties(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("!")) continue;
    const m = /^([^=:\s]+)\s*[=:]\s*(.*)$/.exec(line);
    if (m) out.set(m[1]!, m[2]!.trim());
  }
  return out;
}

/** Protected keys whose value differs between two `server.properties` texts. */
export function changedProtectedKeys(before: string, after: string): string[] {
  const a = parseProperties(before);
  const b = parseProperties(after);
  const keys = new Set([...a.keys(), ...b.keys()]);
  return [...keys].filter((k) => isProtectedProperty(k) && a.get(k) !== b.get(k)).sort();
}
