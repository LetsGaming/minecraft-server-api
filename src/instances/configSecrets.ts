/**
 * W-006: what the config editor may show and change.
 *
 * The editor serves `server.properties` and `plugins/` next to mod configs,
 * and both hold credentials (`rcon.password`, a DiscordSRV token, a
 * LuckPerms database password) and switches that decide who may join or
 * command the server (`online-mode`, `enable-rcon`, `white-list`). Someone
 * handed "tune the mods" was handed all of that too.
 *
 * Two rules:
 *
 * - **Secrets are redacted on read** and put back on write. Each format the
 *   editor lists is scanned for the values of credential-looking keys (and
 *   for `scheme://user:password@` URLs); every such value is replaced by
 *   {@link REDACTED}. A write that sends a placeholder back in the same
 *   place gets the real value restored, and a write that still carries the
 *   marker anywhere else is refused, so a placeholder can never land on disk.
 * - **Protected `server.properties` keys** may only change when the request
 *   says it may (`allowProtected`), which the bot sends for sysadmins only.
 *   The comparison uses the grammar the game itself loads the file with
 *   (`java.util.Properties`), so no spelling of a key slips past it.
 */

/** Stands in for a secret value in what a client sees. */
export const REDACTED = "<redacted by mc-api-server>";

/** The marker is matched too, so a redacted URL is still found when it comes back. */
const URL_CREDENTIALS = new RegExp(
  `((?<![a-z0-9+.-])[a-z][a-z0-9+.-]{0,31}://[^/\\s:@"'?#]+:)(${REDACTED}|[^@/\\s"']+)(@)`,
  "gi",
);

/** Key names that hold a credential, in any format. */
const SECRET_KEY = /(pass(word|wd|phrase)?|secret|token|api[-_.]?key|private[-_.]?key|credential)/i;

const URL_CREDENTIAL_KEY = "url-credential";

/** The span of one secret value in a text, and the key that marks it secret. */
interface Site {
  start: number;
  end: number;
  key: string;
  /** Quote characters wrapped around the value inside the span, if any. */
  quote: string;
  /** A bare word or number that must be shown as a quoted string to stay one token. */
  bare?: boolean;
}

type Dialect = "properties" | "json" | "toml" | "yaml" | "cfg" | "generic";

function dialectOf(format: string): Dialect {
  switch (format) {
    case "properties":
      return "properties";
    case "json":
    case "json5":
      return "json";
    case "toml":
      return "toml";
    case "yaml":
      return "yaml";
    case "cfg":
      return "cfg";
    default:
      return "generic";
  }
}

function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

function isNewline(c: string | undefined): boolean {
  return c === "\n" || c === "\r";
}

function isPropertiesBlank(c: string | undefined): boolean {
  return c === " " || c === "\t" || c === "\f";
}

function forEachLine(text: string, fn: (line: string, offset: number) => void): void {
  let offset = 0;
  while (offset <= text.length) {
    let end = offset;
    while (end < text.length && !isNewline(text[end])) end++;
    fn(text.slice(offset, end), offset);
    if (end >= text.length) return;
    offset = end + (text[end] === "\r" && text[end + 1] === "\n" ? 2 : 1);
  }
}

function hasNothingToHide(value: string): boolean {
  return (
    value === "" ||
    value === '""' ||
    value === "''" ||
    value === "{" ||
    value === "[" ||
    value === "|" ||
    value === ">"
  );
}

function wrappingQuote(value: string): string {
  const q = value[0];
  return value.length >= 2 && (q === '"' || q === "'") && value.endsWith(q) ? q : "";
}

/* ---------------------------- java.util.Properties --------------------------- */

interface PropertyEntry {
  key: string;
  value: string;
  valueStart: number;
  valueEnd: number;
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = { t: "\t", n: "\n", r: "\r", f: "\f" };

/**
 * Entries of a `.properties` text under the `Properties.load` grammar:
 * `=`, `:` or whitespace between key and value, backslash escapes (including
 * `\uXXXX`) in both, lines continued by a trailing odd backslash, `#`/`!`
 * comment lines. Later entries for the same key win in the game, so callers
 * that want the effective value take the last one.
 */
function propertyEntries(text: string): PropertyEntry[] {
  const entries: PropertyEntry[] = [];
  const n = text.length;
  let pos = 0;

  const skipBlanks = (from: number): number => {
    let j = from;
    for (;;) {
      if (isPropertiesBlank(text[j])) {
        j++;
      } else if (text[j] === "\\" && isNewline(text[j + 1])) {
        j += text[j + 1] === "\r" && text[j + 2] === "\n" ? 3 : 2;
      } else {
        return j;
      }
    }
  };

  /** Read the escape at `j` (a backslash): the character it stands for and the next offset. */
  const readEscape = (j: number): { ch: string; next: number } => {
    const nxt = text[j + 1];
    if (nxt === undefined) return { ch: "", next: j + 1 };
    if (isNewline(nxt)) return { ch: "", next: skipBlanks(j) };
    if (nxt === "u") {
      const hex = text.slice(j + 2, j + 6);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        return { ch: String.fromCharCode(parseInt(hex, 16)), next: j + 6 };
      }
    }
    return { ch: SIMPLE_ESCAPES[nxt] ?? nxt, next: j + 2 };
  };

  while (pos < n) {
    let i = pos;
    while (isPropertiesBlank(text[i])) i++;
    if (i >= n) break;
    const first = text[i];
    if (isNewline(first)) {
      pos = i + 1;
      continue;
    }
    if (first === "#" || first === "!") {
      while (i < n && !isNewline(text[i])) i++;
      pos = i;
      continue;
    }

    let key = "";
    let j = i;
    while (j < n) {
      const c = text[j]!;
      if (isNewline(c) || c === "=" || c === ":" || isPropertiesBlank(c)) break;
      if (c === "\\") {
        const esc = readEscape(j);
        key += esc.ch;
        j = esc.next;
        continue;
      }
      key += c;
      j++;
    }
    j = skipBlanks(j);
    if (text[j] === "=" || text[j] === ":") j = skipBlanks(j + 1);

    const valueStart = j;
    let value = "";
    while (j < n && !isNewline(text[j])) {
      if (text[j] === "\\") {
        const esc = readEscape(j);
        value += esc.ch;
        j = esc.next;
        continue;
      }
      value += text[j];
      j++;
    }
    entries.push({ key, value, valueStart, valueEnd: j });
    pos = j;
  }
  return entries;
}

function propertySites(text: string): Site[] {
  const sites: Site[] = [];
  for (const e of propertyEntries(text)) {
    if (e.valueEnd > e.valueStart && isSecretKey(e.key)) {
      sites.push({ start: e.valueStart, end: e.valueEnd, key: e.key, quote: "" });
    }
  }
  return sites;
}

/* ------------------------------ JSON / TOML values ------------------------------ */

/**
 * Scan JSON, JSON5 or TOML (inline tables and arrays included) and report
 * every scalar that sits under a credential-looking key, however deeply the
 * key nests and however little whitespace separates it. Tolerant of what it
 * does not understand: it never throws, and unknown input just yields fewer
 * sites. `rootOnly` parses a single value at `from` (JSON, or a YAML flow
 * collection); otherwise TOML statements are read until the end.
 */
function structuredSites(text: string, toml: boolean, from = 0, rootOnly = !toml): Site[] {
  const sites: Site[] = [];
  const n = text.length;
  const sep = toml ? "=" : ":";
  let i = from;

  const skipLine = (): void => {
    while (i < n && !isNewline(text[i])) i++;
  };

  const skipSpace = (newlines: boolean): void => {
    for (;;) {
      const c = text[i];
      if (c === undefined) return;
      if (c === " " || c === "\t" || (newlines && isNewline(c))) {
        i++;
      } else if (toml ? c === "#" : c === "/" && text[i + 1] === "/") {
        skipLine();
      } else if (!toml && c === "/" && text[i + 1] === "*") {
        const e = text.indexOf("*/", i + 2);
        i = e < 0 ? n : e + 2;
      } else {
        return;
      }
    }
  };

  const stringEnd = (): { end: number; quote: string } => {
    const q = text[i]!;
    if (toml && text.startsWith(q.repeat(3), i)) {
      const close = text.indexOf(q.repeat(3), i + 3);
      return { end: close < 0 ? n : close + 3, quote: q.repeat(3) };
    }
    let j = i + 1;
    while (j < n && text[j] !== q && !(toml && isNewline(text[j]))) {
      if (text[j] === "\\" && q === '"') j++;
      j++;
    }
    return { end: Math.min(j + 1, n), quote: q };
  };

  const parseValue = (key: string, secret: boolean): void => {
    const c = text[i];
    if (c === '"' || c === "'") {
      const start = i;
      const { end, quote } = stringEnd();
      i = end;
      const innerStart = start + quote.length;
      if (secret && text.slice(innerStart, Math.max(innerStart, end - quote.length)) !== "") {
        sites.push({ start, end, key, quote });
      }
    } else if (c === "{") {
      i++;
      parseMembers(secret);
    } else if (c === "[") {
      i++;
      parseElements(key, secret);
    } else {
      const start = i;
      while (i < n && !/[\s,\]}#]/.test(text[i]!)) i++;
      const raw = text.slice(start, i);
      if (secret && raw !== "" && !/^(true|false|null)$/i.test(raw)) {
        sites.push({ start, end: i, key, quote: "", bare: true });
      }
    }
  };

  const parseMembers = (parentSecret: boolean): void => {
    for (;;) {
      skipSpace(true);
      const c = text[i];
      if (c === undefined) return;
      if (c === "}") {
        i++;
        return;
      }
      if (c === ",") {
        i++;
        continue;
      }
      const before = i;
      const start = i;
      let key: string;
      if (c === '"' || c === "'") {
        i = stringEnd().end;
        key = text.slice(start + 1, Math.max(start + 1, i - 1));
      } else {
        while (i < n && !/[\s:=,{}[\]]/.test(text[i]!)) i++;
        key = text.slice(start, i);
      }
      skipSpace(true);
      if (text[i] === sep) {
        i++;
        skipSpace(true);
        parseValue(key, parentSecret || isSecretKey(key));
      }
      if (i === before) i++;
    }
  };

  const parseElements = (key: string, secret: boolean): void => {
    for (;;) {
      skipSpace(true);
      const c = text[i];
      if (c === undefined) return;
      if (c === "]") {
        i++;
        return;
      }
      if (c === ",") {
        i++;
        continue;
      }
      const before = i;
      parseValue(key, secret);
      if (i === before) i++;
    }
  };

  if (rootOnly) {
    skipSpace(true);
    parseValue("", false);
    return sites;
  }

  let tableSecret = false;
  while (i < n) {
    skipSpace(true);
    if (i >= n) break;
    const before = i;
    if (text[i] === "[") {
      const start = i;
      skipLine();
      tableSecret = isSecretKey(text.slice(start, i));
      continue;
    }
    const start = i;
    while (i < n && !/[\s=#]/.test(text[i]!)) {
      if (text[i] === '"' || text[i] === "'") i = stringEnd().end;
      else i++;
    }
    const key = text.slice(start, i);
    skipSpace(false);
    if (text[i] === "=") {
      i++;
      skipSpace(false);
      parseValue(key, tableSecret || isSecretKey(key));
    } else {
      skipLine();
    }
    if (i === before) i++;
  }
  return sites;
}

/* ----------------------------------- YAML ----------------------------------- */

const YAML_ENTRY = /^(\s*(?:[-#;]\s*)*("?)([\w.-]+)\2\s*:\s*)(.*?)(\s*)$/;
const YAML_LIST_ITEM = /^(\s*-\s+)(.*?)(\s*)$/;

function yamlSites(text: string): Site[] {
  const sites: Site[] = [];
  const lines: { line: string; offset: number }[] = [];
  forEachLine(text, (line, offset) => {
    lines.push({ line, offset });
  });
  const indentOf = (line: string): number => line.length - line.trimStart().length;

  // Indent of the credential-named key whose nested lines are all secret.
  let secretIndent = -1;
  for (let idx = 0; idx < lines.length; idx++) {
    const { line, offset } = lines[idx]!;
    if (line.trim() === "") continue;
    const indent = indentOf(line);
    if (secretIndent >= 0 && indent <= secretIndent) secretIndent = -1;
    const inSecret = secretIndent >= 0;

    const m = YAML_ENTRY.exec(line);
    if (!m) {
      const item = YAML_LIST_ITEM.exec(line);
      if (inSecret && item && item[2] !== "") {
        const start = offset + item[1]!.length;
        sites.push({ start, end: start + item[2]!.length, key: "-", quote: wrappingQuote(item[2]!) });
      }
      continue;
    }

    const key = m[3]!;
    const value = m[4]!;
    const valueStart = offset + m[1]!.length;
    const secret = inSecret || isSecretKey(key);

    if (value === "") {
      if (secret && !inSecret) secretIndent = indent;
      continue;
    }
    if (/^[|>][+\-\d]*$/.test(value)) {
      if (!secret) continue;
      let first = -1;
      let last = -1;
      for (let k = idx + 1; k < lines.length; k++) {
        const next = lines[k]!;
        if (next.line.trim() === "") continue;
        if (indentOf(next.line) <= indent) break;
        if (first < 0) first = k;
        last = k;
      }
      if (first >= 0) {
        const f = lines[first]!;
        const l = lines[last]!;
        sites.push({
          start: f.offset + indentOf(f.line),
          end: l.offset + l.line.length,
          key,
          quote: "",
        });
        idx = last;
      }
      continue;
    }
    if (value.startsWith("{") || value.startsWith("[")) {
      if (secret) sites.push({ start: valueStart, end: valueStart + value.length, key, quote: "" });
      else sites.push(...structuredSites(text, false, valueStart, true));
      continue;
    }
    if (secret && !hasNothingToHide(value)) {
      sites.push({
        start: valueStart,
        end: valueStart + value.length,
        key,
        quote: wrappingQuote(value),
      });
    }
  }
  return sites;
}

/* ------------------------------ other line formats ------------------------------ */

const FORGE_CFG_LINE = /^(\s*[A-Z]:("?)([^=\s"]+)\2\s*=\s*)(.*?)(\s*)$/;
const KEY_VALUE_LINE = /^(\s*(?:[-#;]\s*)?("?)([\w.-]+)\2\s*[:=]\s*)(.*?)(\s*,?\s*)$/;

function lineSites(text: string, dialect: Dialect): Site[] {
  const sites: Site[] = [];
  forEachLine(text, (line, offset) => {
    const m = (dialect === "cfg" ? FORGE_CFG_LINE.exec(line) : null) ?? KEY_VALUE_LINE.exec(line);
    if (!m) return;
    const key = m[3]!;
    const value = m[4]!;
    if (!isSecretKey(key) || hasNothingToHide(value)) return;
    const start = offset + m[1]!.length;
    sites.push({ start, end: start + value.length, key, quote: wrappingQuote(value) });
  });
  return sites;
}

/* -------------------------------------- core -------------------------------------- */

function urlSites(text: string): Site[] {
  const sites: Site[] = [];
  for (const m of text.matchAll(URL_CREDENTIALS)) {
    const start = m.index + m[1]!.length;
    sites.push({ start, end: start + m[2]!.length, key: URL_CREDENTIAL_KEY, quote: "" });
  }
  return sites;
}

function findSites(text: string, format: string): Site[] {
  const dialect = dialectOf(format);
  let sites: Site[];
  switch (dialect) {
    case "properties":
      sites = propertySites(text);
      break;
    case "json":
      sites = structuredSites(text, false);
      break;
    case "toml":
      sites = structuredSites(text, true);
      break;
    case "yaml":
      sites = yamlSites(text);
      break;
    default:
      sites = lineSites(text, dialect);
  }
  sites.push(...urlSites(text));
  sites.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Site[] = [];
  for (const s of sites) {
    const prev = kept[kept.length - 1];
    if (prev && s.start < prev.end) continue;
    kept.push(s);
  }
  return kept;
}

/** A bare JSON/TOML number or word becomes a string so the placeholder stays one token. */
function replacementQuote(site: Site): string {
  return site.quote !== "" ? site.quote : site.bare ? '"' : "";
}

/** The text a client may see. */
export function redactSecrets(text: string, format = "text"): string {
  let out = "";
  let at = 0;
  for (const site of findSites(text, format)) {
    const q = replacementQuote(site);
    out += text.slice(at, site.start) + q + REDACTED + q;
    at = site.end;
  }
  return out + text.slice(at);
}

function innerOf(text: string, site: Site): string {
  const q = site.quote.length;
  return text.slice(site.start + q, Math.max(site.start + q, site.end - q));
}

/**
 * Put the real values back into a client's text. Every secret position that
 * still holds the placeholder is replaced by the original value of the same
 * key in the current file (in order, for keys that repeat). Returns null
 * when a placeholder is left that no original value accounts for.
 */
export function restoreSecrets(
  submitted: string,
  current: string,
  format = "text",
): string | null {
  const originals = new Map<string, string[]>();
  for (const site of findSites(current, format)) {
    const list = originals.get(site.key) ?? [];
    list.push(current.slice(site.start, site.end));
    originals.set(site.key, list);
  }

  let out = "";
  let at = 0;
  for (const site of findSites(submitted, format)) {
    if (innerOf(submitted, site) !== REDACTED) continue;
    const original = originals.get(site.key)?.shift();
    if (original === undefined) return null;
    out += submitted.slice(at, site.start) + original;
    at = site.end;
  }
  out += submitted.slice(at);
  return out.includes(REDACTED) ? null : out;
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

/** Effective key/value pairs of a `.properties` text; the last entry for a key wins. */
export function parseJavaProperties(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of propertyEntries(text)) out.set(e.key, e.value);
  return out;
}

/** Protected keys whose value differs between two `server.properties` texts. */
export function changedProtectedKeys(before: string, after: string): string[] {
  const a = parseJavaProperties(before);
  const b = parseJavaProperties(after);
  const keys = new Set([...a.keys(), ...b.keys()]);
  return [...keys].filter((k) => isProtectedProperty(k) && a.get(k) !== b.get(k)).sort();
}
