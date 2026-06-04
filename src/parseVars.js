"use strict";

// F-007: Shared variables.txt parser — used by both src/config.js and
// ecosystem.config.cjs. Keep this file dependency-free (no Express, no
// runtime state) so it runs safely in both the app process and the PM2
// config loader.

const fs = require("fs");

/**
 * Parse a variables.txt file into a plain key→value map.
 * Lines must match: KEY="value" or KEY=value
 * Lines that don't match are silently skipped.
 *
 * @param {string} filePath  Absolute path to variables.txt
 * @returns {Record<string, string>}
 */
function parseVarsFile(filePath) {
  const vars = {};
  for (const line of fs.readFileSync(filePath, "utf-8").split(/\r?\n/)) {
    const m = line.match(/^(\w+)="?([^"]*)"?$/);
    if (m) vars[m[1]] = m[2];
  }
  return vars;
}

module.exports = { parseVarsFile };
