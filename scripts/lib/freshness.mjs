import fs from "node:fs";
import path from "node:path";

/** Modification time of the newest file below `dir` whose name ends in one of `extensions`. */
function newestMtime(dir, extensions) {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(full, extensions));
    } else if (entry.isFile() && extensions.some((e) => entry.name.endsWith(e))) {
      newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  }
  return newest;
}

/**
 * Why `dist/` cannot be shipped, or null when it can: it is missing, or some
 * TypeScript source was edited after the build wrote it.
 */
export function staleDistReason(root) {
  const entry = path.join(root, "dist", "index.js");
  if (!fs.existsSync(entry)) return "dist/index.js is missing; run npm run build first.";
  const built = fs.statSync(entry).mtimeMs;
  const src = path.join(root, "src");
  if (fs.existsSync(src) && newestMtime(src, [".ts"]) > built) {
    return "dist/ is older than src/; run npm run build first.";
  }
  return null;
}
