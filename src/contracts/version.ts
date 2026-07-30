/**
 * The wrapper's own semver, read from package.json at import time.
 * Reported by GET /health and GET /instances/:id/info — the bot's
 * startup handshake compares this against its MIN_WRAPPER_VERSION.
 */
import fs from "fs";

import { PACKAGE_JSON_PATH } from "../platform/paths.js";

let version = "0.0.0";
try {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf-8")) as {
    version?: string;
  };
  if (typeof pkg.version === "string") version = pkg.version;
} catch {
  /* keep 0.0.0 — never fail startup over a version read */
}

export const WRAPPER_VERSION = version;
