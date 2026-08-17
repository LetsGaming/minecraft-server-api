/**
 * Mod management for one instance: reading the installed manifest and driving
 * the suite's scripts to add, remove and update mods.
 *
 * The wrapper's whole job is that it lives on the same host as the server, so
 * it has what nothing else does — direct read access to the mod manifest and
 * the right to run the suite's scripts as the instance user. Browsing Modrinth
 * needs neither and belongs on the dashboard; this module never talks to
 * Modrinth.
 *
 * The split within that job: reads happen here (downloaded_versions.json is
 * this process's to read); writes happen in scripts/update/*.js, spawned via
 * `sudo -n -u <user>` (platform/spawn.ts) because the mods directory is owned
 * by the instance user, not by whoever runs the wrapper. The scripts already
 * hold the install and dependency logic, and are the only thing that can write
 * those files anyway.
 *
 * The scripts run in their `--json` mode, so each returns one JSON object this
 * module parses rather than screen-scraping log lines. A script that ran and
 * reported a handled failure (`ok:false`) is returned to the route as data;
 * only a script that could not run, or produced no parseable result, throws.
 */
import fsp from "fs/promises";
import path from "path";

import { runAsInstanceUser } from "../platform/spawn.js";
import type { InstanceConfig } from "../config/types.js";
import type {
  InstalledMods,
  ModAddResult,
  ModRemoveResult,
  ModUpdateCheck,
  ModApplyResult,
} from "../contracts/wire.js";

const SCRIPTS = {
  add: "update/add-mod.js",
  remove: "update/remove-mod.js",
  check: "update/check-updates.js",
  apply: "update/update-mods.js",
} as const;

/**
 * Timeouts shaped by what each script does. add/remove touch one mod; check
 * hits Modrinth once per installed mod; apply may download every mod that has
 * an update, so it gets the same ten-minute ceiling as a backup.
 */
const SCRIPT_TIMEOUTS: Record<keyof typeof SCRIPTS, number> = {
  add: 120_000,
  remove: 30_000,
  check: 120_000,
  apply: 600_000,
};

/** A slug or project id, as recorded in downloaded_versions.json. */
const SLUG_RE = /^[\w.-]{1,96}$/;
/** A Minecraft version like 1.21.4 or 1.21. */
const MC_VERSION_RE = /^[\w.-]{1,20}$/;
/** A loader like fabric, forge, quilt, neoforge. */
const LOADER_RE = /^[a-z]{1,20}$/;

export function createMods(cfg: InstanceConfig) {
  const manifestPath = path.join(
    cfg.scriptsDir,
    "common",
    "downloaded_versions.json",
  );

  async function exists(target: string): Promise<boolean> {
    try {
      await fsp.access(target);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read and narrow downloaded_versions.json. Returns null only when the file
   * is absent; a permission or parse error throws, so the caller can tell "no
   * manifest here" from "the manifest is broken". A-04: one try/catch over
   * stat+read avoids a TOCTOU.
   */
  async function readManifest(): Promise<{
    data: {
      gameVersion: string | null;
      modLoader: string | null;
      mods: Record<string, { versionId?: string; filename?: string | null } | string>;
    };
    mtimeMs: number;
  } | null> {
    try {
      const stat = await fsp.stat(manifestPath);
      const raw = JSON.parse(await fsp.readFile(manifestPath, "utf-8")) as {
        gameVersion?: unknown;
        modLoader?: unknown;
        mods?: Record<string, unknown>;
      };
      return {
        data: {
          gameVersion:
            typeof raw.gameVersion === "string" ? raw.gameVersion : null,
          modLoader: typeof raw.modLoader === "string" ? raw.modLoader : null,
          mods: (raw.mods ?? {}) as Record<
            string,
            { versionId?: string; filename?: string | null } | string
          >,
        },
        mtimeMs: stat.mtimeMs,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  /**
   * The slug-only reader the bot's /mods route still uses. Kept exactly as it
   * was — its shape is the `mods` v1 feature contract the bot casts to.
   */
  async function getModSlugs(): Promise<{ slugs: string[]; mtimeMs: number } | null> {
    const manifest = await readManifest();
    if (!manifest) return null;
    return { slugs: Object.keys(manifest.data.mods), mtimeMs: manifest.mtimeMs };
  }

  /** The richer installed list the dashboard reads: versions, loader, filenames. */
  async function listInstalled(): Promise<InstalledMods | null> {
    const manifest = await readManifest();
    if (!manifest) return null;
    const mods = Object.entries(manifest.data.mods).map(([slug, entry]) =>
      // Legacy entries were a bare version-id string; new ones are objects.
      typeof entry === "string"
        ? { slug, versionId: entry, filename: null }
        : {
            slug,
            versionId: entry.versionId ?? null,
            filename: entry.filename ?? null,
          },
    );
    mods.sort((a, b) => a.slug.localeCompare(b.slug));
    return {
      gameVersion: manifest.data.gameVersion,
      modLoader: manifest.data.modLoader,
      mtimeMs: manifest.mtimeMs,
      mods,
    };
  }

  /**
   * Run one of the suite's mod scripts in --json mode and parse its result.
   * Throws when the script is missing, cannot be spawned, or produced no JSON
   * (a genuine internal failure → 500). Returns the parsed object otherwise —
   * including a script's own `{ok:false}`, which the route reports at 200.
   */
  async function runModScript(
    which: keyof typeof SCRIPTS,
    args: string[],
    label: string,
  ): Promise<unknown> {
    const scriptPath = path.join(cfg.scriptsDir, SCRIPTS[which]);
    if (!(await exists(scriptPath))) {
      throw new Error(`Mod script not found: ${scriptPath}`);
    }

    const result = await runAsInstanceUser(
      cfg,
      ["node", scriptPath, ...args, "--json"],
      { timeoutMs: SCRIPT_TIMEOUTS[which], label },
    );

    try {
      return JSON.parse(result.output);
    } catch {
      const detail = result.stderr || result.output || "(no output)";
      throw new Error(
        `${label} produced no parseable result (exit ${result.exitCode}): ` +
          detail.slice(-500),
      );
    }
  }

  function assertOkField(value: unknown, label: string): void {
    if (
      typeof value !== "object" ||
      value === null ||
      typeof (value as { ok?: unknown }).ok !== "boolean"
    ) {
      throw new Error(`${label} returned an unrecognised result shape`);
    }
  }

  async function addMod(
    slug: string,
    mcVersion?: string,
    modLoader?: string,
  ): Promise<ModAddResult> {
    const args = [slug];
    if (mcVersion) args.push(`--mcVersion=${mcVersion}`);
    if (modLoader) args.push(`--modLoader=${modLoader}`);
    const parsed = await runModScript("add", args, "Add mod");
    assertOkField(parsed, "Add mod");
    return parsed as ModAddResult;
  }

  async function removeMod(slug: string): Promise<ModRemoveResult> {
    const parsed = await runModScript("remove", [slug], "Remove mod");
    assertOkField(parsed, "Remove mod");
    return parsed as ModRemoveResult;
  }

  async function checkUpdates(mcVersion?: string): Promise<ModUpdateCheck> {
    const args = mcVersion ? [`--mcVersion=${mcVersion}`] : [];
    // check-updates.js emits { mcVersion, modLoader, results } with no ok
    // field — a check cannot "fail"; a mod that errored is one result.
    const parsed = await runModScript("check", args, "Check mod updates");
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as { results?: unknown }).results)
    ) {
      throw new Error("Check mod updates returned an unrecognised result shape");
    }
    return parsed as ModUpdateCheck;
  }

  async function applyUpdates(mcVersion?: string): Promise<ModApplyResult> {
    const args = mcVersion ? [`--mcVersion=${mcVersion}`] : [];
    const parsed = await runModScript("apply", args, "Apply mod updates");
    assertOkField(parsed, "Apply mod updates");
    return parsed as ModApplyResult;
  }

  return {
    getModSlugs,
    listInstalled,
    addMod,
    removeMod,
    checkUpdates,
    applyUpdates,
  };
}

// Exported so the route validates inputs against the same patterns the module
// trusts — a bad slug is a 400 at the boundary rather than a spawn.
export const MOD_VALIDATION = { SLUG_RE, MC_VERSION_RE, LOADER_RE } as const;
