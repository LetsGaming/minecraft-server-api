"use strict";

// F-007: Shared variables.txt parser — used by both src/config.js and
// ecosystem.config.cjs. Keep this file dependency-free (no Express, no
// runtime state) so it runs safely in both the app process and the PM2
// config loader.

const fs = require("fs");

/**
 * Parse a variables.txt file into a plain key→value map.
 *
 * Accepted formats per line:
 *   KEY="quoted value"   → value is the text between the double quotes
 *   KEY=unquoted value   → value is everything after = (trimmed)
 *
 * The previous single-regex /^(\w+)="?([^"]*)"?$/ was ambiguous:
 * for KEY="hello" it captured `hello` correctly, but for a value like
 * KEY="foo"bar the outer "? matched the trailing " and `[^"]*` stopped
 * at the mid-string quote, silently truncating the value.  Two explicit
 * branches eliminate the ambiguity.
 *
 * Lines that match neither branch are silently skipped (comments, blank
 * lines, malformed entries).
 *
 * @param {string} filePath  Absolute path to variables.txt
 * @returns {Record<string, string>}
 */
function parseVarsFile(filePath) {
  const vars = {};
  for (const rawLine of fs.readFileSync(filePath, "utf-8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // Branch 1: KEY="value" — value is everything between the first and last "
    const quoted = line.match(/^(\w+)="(.*)"$/);
    if (quoted) {
      vars[quoted[1]] = quoted[2];
      continue;
    }

    // Branch 2: KEY=value — unquoted; value is everything after the first =
    const unquoted = line.match(/^(\w+)=(.*)$/);
    if (unquoted) {
      vars[unquoted[1]] = unquoted[2].trim();
    }
  }
  return vars;
}

module.exports = { parseVarsFile };
