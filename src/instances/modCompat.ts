/**
 * "Which of my installed mods have a release for Minecraft version X?"
 *
 * check-updates.js answers that for one version but checks mods one after the
 * other, so a large modpack outruns both the script timeout and any client
 * timeout. This module runs the script once per installed slug (`--only`),
 * a few at a time, as a background job the client polls: progress and partial
 * results are live, and one mod that fails to check is one `unknown` entry
 * rather than a failed job.
 *
 * Finished answers are cached per (Minecraft version, installed mod set) for
 * hours because Modrinth data changes slowly; any mod mutation drops the cache
 * and keeps jobs that were already running from writing a stale answer back.
 */
import { createHash, randomUUID } from "crypto";

import { mapLimit } from "../platform/concurrency.js";
import { log, logSafe } from "../platform/logger.js";
import type {
  ModCompatAvailability,
  ModCompatJob,
  ModCompatMod,
  ModCompatResult,
} from "../contracts/wire.js";

export const COMPAT_CONCURRENCY = 3;
export const COMPAT_CACHE_TTL_MS = 6 * 60 * 60_000;
export const COMPAT_JOB_RETENTION_MS = 15 * 60_000;
export const COMPAT_MAX_JOBS = 30;
export const COMPAT_MAX_RUNNING = 3;
const COMPAT_MAX_CACHE_ENTRIES = 20;
const CDN_HOST = "cdn.modrinth.com";

export interface InstalledSnapshot {
  modLoader: string | null;
  mods: Array<{ slug: string; versionId: string | null }>;
}

export interface ModCompatDeps {
  /** The installed manifest, uncached; null when the instance has none. */
  readInstalled(): Promise<InstalledSnapshot | null>;
  /** One check-updates.js run for a single slug; resolves to its parsed JSON. */
  checkOne(slug: string, mcVersion: string): Promise<unknown>;
  now?: () => number;
}

export class CompatManifestMissingError extends Error {
  constructor() {
    super("Mod list not found");
  }
}

export class CompatBusyError extends Error {
  constructor() {
    super("Too many compatibility checks are running");
  }
}

interface Job {
  id: string;
  key: string;
  mcVersion: string;
  modLoader: string | null;
  state: "running" | "done" | "failed";
  total: number;
  done: number;
  partial: ModCompatMod[];
  result: ModCompatResult | null;
  error: string | null;
  finishedAt: number | null;
}

/**
 * Failure text reaching a client is one of a few fixed phrases. Script output
 * and thrown errors can carry paths, sudo output and upstream bodies, so the
 * raw text is only matched against, never forwarded.
 */
export function failureReason(raw: unknown): string {
  const text = typeof raw === "string" ? raw : JSON.stringify(raw) ?? "";
  if (/timed? ?out|ETIMEDOUT|ECONNABORTED|ESOCKETTIMEDOUT/i.test(text)) return "timeout";
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|EHOSTUNREACH|network|socket hang up/i.test(text)) {
    return "modrinth unreachable";
  }
  if (/(?<![0-9])429(?![0-9])|rate.?limit|too many requests/i.test(text)) return "rate limited";
  if (/(?<![0-9])404(?![0-9])|not found/i.test(text)) return "mod not found on modrinth";
  return "check failed";
}

function publicDownloadUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === CDN_HOST ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Maps one check-updates.js result entry to the contract's per-mod shape. */
export function classifyResult(
  slug: string,
  currentVersionId: string | null,
  entry: unknown,
): ModCompatMod {
  const base: ModCompatMod = { slug, availability: "unknown" };
  if (currentVersionId) base.currentVersionId = currentVersionId;
  if (!isRecord(entry)) {
    return { ...base, reason: "check failed" };
  }
  const status = entry["status"];
  let availability: ModCompatAvailability = "unknown";
  if (status === "up_to_date" || status === "update_available") {
    availability = "available";
  } else if (status === "no_versions" || status === "no_matching_version") {
    availability = "unavailable";
  }

  const mod: ModCompatMod = { ...base, availability };
  if (status === "update_available") {
    const versionId = str(entry["latestVersionId"]);
    if (versionId) {
      const downloadUrl = publicDownloadUrl(entry["downloadUrl"]);
      mod.target = {
        versionId,
        versionName: str(entry["latestVersionName"]) ?? versionId,
        datePublished: str(entry["datePublished"]) ?? "",
        ...(downloadUrl ? { downloadUrl } : {}),
      };
    }
  }
  if (availability === "unavailable") {
    mod.reason = "no compatible release";
  } else if (availability === "unknown") {
    mod.reason =
      status === "invalid_entry"
        ? "invalid manifest entry"
        : failureReason(entry["error"] ?? entry["message"]);
    if (status !== "invalid_entry" && status !== "error") {
      log.warn(
        "mods",
        `compat: unrecognised check status slug=${logSafe(slug, 100)} status=${logSafe(status, 50)}`,
      );
    } else if (status === "error") {
      log.warn(
        "mods",
        `compat: check failed slug=${logSafe(slug, 100)} detail=${logSafe(entry["error"])}`,
      );
    }
  }
  return mod;
}

function summarise(mods: ModCompatMod[]): ModCompatResult["summary"] {
  const count = (a: ModCompatAvailability) =>
    mods.filter((m) => m.availability === a).length;
  return {
    available: count("available"),
    unavailable: count("unavailable"),
    unknown: count("unknown"),
    total: mods.length,
  };
}

function installedHash(installed: InstalledSnapshot): string {
  const lines = installed.mods
    .map((m) => `${m.slug}@${m.versionId ?? ""}`)
    .sort()
    .join("\n");
  return createHash("sha1").update(`${installed.modLoader ?? ""}\n${lines}`).digest("hex");
}

export function createModCompat(deps: ModCompatDeps) {
  const now = deps.now ?? Date.now;
  const jobs = new Map<string, Job>();
  const cache = new Map<string, { result: ModCompatResult; at: number }>();
  let generation = 0;

  function sweep(): void {
    const t = now();
    for (const [id, job] of jobs) {
      if (job.finishedAt !== null && t - job.finishedAt > COMPAT_JOB_RETENTION_MS) {
        jobs.delete(id);
      }
    }
    const finished = [...jobs.values()]
      .filter((j) => j.finishedAt !== null)
      .sort((a, b) => a.finishedAt! - b.finishedAt!);
    while (jobs.size > COMPAT_MAX_JOBS && finished.length > 0) {
      jobs.delete(finished.shift()!.id);
    }
    for (const [key, entry] of cache) {
      if (t - entry.at > COMPAT_CACHE_TTL_MS) cache.delete(key);
    }
  }

  function remember(key: string, result: ModCompatResult): void {
    cache.set(key, { result, at: now() });
    while (cache.size > COMPAT_MAX_CACHE_ENTRIES) {
      cache.delete(cache.keys().next().value as string);
    }
  }

  function newJob(
    key: string,
    mcVersion: string,
    modLoader: string | null,
    total: number,
  ): Job {
    const job: Job = {
      id: randomUUID(),
      key,
      mcVersion,
      modLoader,
      state: "running",
      total,
      done: 0,
      partial: [],
      result: null,
      error: null,
      finishedAt: null,
    };
    jobs.set(job.id, job);
    return job;
  }

  async function run(job: Job, installed: InstalledSnapshot): Promise<void> {
    const startedIn = generation;
    let thrown = 0;
    let firstError = "";
    let loaderFromScript: string | null = null;

    await mapLimit(installed.mods, COMPAT_CONCURRENCY, async (mod) => {
      let outcome: ModCompatMod;
      try {
        const parsed = await deps.checkOne(mod.slug, job.mcVersion);
        const results = isRecord(parsed) ? parsed["results"] : undefined;
        if (isRecord(parsed) && typeof parsed["modLoader"] === "string") {
          loaderFromScript = parsed["modLoader"];
        }
        outcome = classifyResult(
          mod.slug,
          mod.versionId,
          Array.isArray(results)
            ? results.find((r) => isRecord(r) && r["slug"] === mod.slug)
            : undefined,
        );
      } catch (err) {
        thrown++;
        const detail = err instanceof Error ? err.message : String(err);
        log.error(
          "mods",
          `compat: check script failed slug=${logSafe(mod.slug, 100)} detail=${logSafe(detail)}`,
        );
        const reason = /timed? ?out/i.test(detail) ? "timeout" : "script failed";
        firstError ||= reason;
        outcome = {
          slug: mod.slug,
          availability: "unknown",
          ...(mod.versionId ? { currentVersionId: mod.versionId } : {}),
          reason,
        };
      }
      job.partial.push(outcome);
      job.done++;
    });

    job.finishedAt = now();
    if (installed.mods.length > 0 && thrown === installed.mods.length) {
      job.state = "failed";
      job.error = firstError;
      return;
    }
    const mods = [...job.partial].sort((a, b) => a.slug.localeCompare(b.slug));
    const summary = summarise(mods);
    job.modLoader = job.modLoader ?? loaderFromScript;
    job.result = {
      mcVersion: job.mcVersion,
      modLoader: job.modLoader,
      checkedAt: job.finishedAt,
      complete: summary.unknown === 0,
      summary,
      mods,
    };
    job.state = "done";
    if (startedIn === generation) remember(job.key, job.result);
  }

  function view(job: Job): ModCompatJob {
    const out: ModCompatJob = {
      jobId: job.id,
      state: job.state,
      mcVersion: job.mcVersion,
      modLoader: job.modLoader,
      progress: { done: job.done, total: job.total },
      partial: job.state === "running" ? [...job.partial] : [],
    };
    if (job.result) {
      out.checkedAt = job.result.checkedAt;
      out.complete = job.result.complete;
      out.summary = job.result.summary;
      out.mods = job.result.mods;
    }
    if (job.error !== null) out.error = job.error;
    return out;
  }

  return {
    /**
     * Starts a check for `mcVersion`, or returns the job already running for
     * it, or a finished job answered from the cache.
     */
    async start(
      mcVersion: string,
      options: { refresh?: boolean } = {},
    ): Promise<{ jobId: string }> {
      sweep();
      const installed = await deps.readInstalled();
      if (!installed) throw new CompatManifestMissingError();

      for (const job of jobs.values()) {
        if (job.state === "running" && job.mcVersion === mcVersion) {
          return { jobId: job.id };
        }
      }

      const key = `${mcVersion}:${installedHash(installed)}`;
      const hit = options.refresh ? undefined : cache.get(key);
      if (hit) {
        const job = newJob(key, mcVersion, hit.result.modLoader, hit.result.mods.length);
        job.done = job.total;
        job.result = hit.result;
        job.state = "done";
        job.finishedAt = now();
        return { jobId: job.id };
      }

      const running = [...jobs.values()].filter((j) => j.state === "running").length;
      if (running >= COMPAT_MAX_RUNNING) throw new CompatBusyError();

      const job = newJob(key, mcVersion, installed.modLoader, installed.mods.length);
      void run(job, installed).catch((err: unknown) => {
        log.error(
          "mods",
          `compat: job failed job=${job.id} mcVersion=${logSafe(job.mcVersion, 30)} detail=${logSafe(err instanceof Error ? err.message : err)}`,
        );
        job.state = "failed";
        job.error = "check failed";
        job.finishedAt = now();
      });
      return { jobId: job.id };
    },

    get(jobId: string): ModCompatJob | null {
      sweep();
      const job = jobs.get(jobId);
      return job ? view(job) : null;
    },

    /** Called after any mod mutation: cached answers and in-flight runs are stale. */
    invalidate(): void {
      generation++;
      cache.clear();
    },
  };
}
