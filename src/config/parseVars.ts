/**
 * F-007: variables.txt parser — the single-instance fallback config
 * source for server-setup managed deployments.
 *
 * Accepted formats per line:
 *   KEY="quoted value"   → value is the text between the double quotes
 *   KEY=unquoted value   → value is everything after = (trimmed)
 *
 * The historical single-regex /^(\w+)="?([^"]*)"?$/ was ambiguous: for
 * KEY="hello" it captured `hello` correctly, but for a value like
 * KEY="foo"bar the outer "? matched the trailing " and `[^"]*` stopped
 * at the mid-string quote, silently truncating the value. Two explicit
 * branches eliminate the ambiguity.
 *
 * Lines that match neither branch are silently skipped (comments, blank
 * lines, malformed entries).
 */
import fs from "fs";

export function parseVarsFile(filePath: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const rawLine of fs.readFileSync(filePath, "utf-8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // Branch 1: KEY="value" — value is everything between the first and last "
    const quoted = /^(\w+)="(.*)"$/.exec(line);
    if (quoted) {
      vars[quoted[1]!] = quoted[2]!;
      continue;
    }

    // Branch 2: KEY=value — unquoted; value is everything after the first =
    const unquoted = /^(\w+)=(.*)$/.exec(line);
    if (unquoted) {
      vars[unquoted[1]!] = unquoted[2]!.trim();
    }
  }
  return vars;
}
