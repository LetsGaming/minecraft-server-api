/**
 * Repo root resolution, found by walking up from this module until a
 * package.json appears.
 *
 * The alternative — counting "../.." from import.meta.url — encodes this
 * file's depth in the tree at every call site, so moving a module silently
 * resolves the config file and the version string to the wrong directory
 * and the process boots with defaults instead of failing. Searching costs
 * a few stat() calls once at import time and cannot drift.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return start; // filesystem root; nothing found
    dir = parent;
  }
}

/** The package root, whether running from src/ (vitest) or dist/ (build). */
export const REPO_ROOT = findRepoRoot(
  path.dirname(fileURLToPath(import.meta.url)),
);

export const PACKAGE_JSON_PATH = path.join(REPO_ROOT, "package.json");
