/**
 * The mod manifest written by the setup suite (common/downloaded_versions.json).
 */
import fsp from "fs/promises";
import path from "path";

import type { InstanceConfig } from "../config/types.js";

export function createMods(cfg: InstanceConfig) {
async function getModSlugs(): Promise<{
  slugs: string[];
  mtimeMs: number;
} | null> {
  // A-04: single try/catch — avoids TOCTOU exists/stat/read
  const jsonPath = path.join(cfg.scriptsDir, "common", "downloaded_versions.json");
  try {
    const stat = await fsp.stat(jsonPath);
    const raw = JSON.parse(await fsp.readFile(jsonPath, "utf-8")) as {
      mods?: Record<string, unknown>;
    };
    return { slugs: Object.keys(raw.mods ?? {}), mtimeMs: stat.mtimeMs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

  return { getModSlugs };
}
