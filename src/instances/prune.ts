/**
 * Chunk pruning: the read-only scan as a background job, the saved settings,
 * and the plan maps the dashboard draws.
 *
 * The suite's `world/prune-chunks.js` does the work. A scan reads every region
 * file and can take minutes on a large world, so it is a job the client polls,
 * like the mod compatibility check. It changes nothing, so it does not take the
 * instance slot; deleting does, and goes through the upgrade job
 * (`startUpgrade` with `pruneOnly`), which stops the server and takes a backup
 * first.
 */
import { randomUUID } from "crypto";
import fsp from "fs/promises";
import path from "path";

import { log } from "../platform/logger.js";
import { interpreter, runAsInstanceUser, spawnJobAsInstanceUser, type JobSpawnHandle } from "../platform/spawn.js";
import type { InstanceConfig } from "../config/types.js";
import type {
  PruneChunkInfo,
  PruneDimensions,
  PruneEngineStatus,
  PruneParams,
  PruneScanJob,
  PruneScanProgress,
  PruneSummary,
} from "../contracts/wire.js";

import { PRUNE_SCRIPT } from "./scripts.js";
const PRUNE_DIR = path.join("common", "prune");

/** A scan reads the whole world; an hour is a stuck process, not a slow disk. */
export const PRUNE_SCAN_TIMEOUT_MS = 60 * 60_000;
export const PRUNE_SETTINGS_TIMEOUT_MS = 20_000;
export const PRUNE_JOBS_KEPT = 5;
/** A map larger than this is refused rather than relayed whole. */
export const PRUNE_MAP_MAX_BYTES = 24 * 1024 * 1024;

export class PruneUnavailableError extends Error {
  constructor() {
    super("This instance's setup suite has no chunk prune script");
  }
}

export class PruneBusyError extends Error {
  constructor() {
    super("A prune scan is already running");
  }
}

export class PruneScriptError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`prune script failed: ${code}`);
    this.code = code;
  }
}

interface Job {
  id: string;
  state: "running" | "done" | "failed";
  result: PruneSummary | null;
  error: string | null;
  finishedAt: number | null;
  progress: PruneScanProgress | null;
  cancelled: boolean;
  handle: JobSpawnHandle | null;
}

export interface PruneDeps {
  spawnJob?: (
    target: InstanceConfig,
    command: string[],
    opts: Parameters<typeof spawnJobAsInstanceUser>[2],
  ) => JobSpawnHandle;
  run?: typeof runAsInstanceUser;
  now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Error codes the script may report; anything else reaches a client as "failed". */
const KNOWN_CODES = new Set(["params", "scan_failed", "server_path", "cancelled", "plan_missing", "dimension", "inspect_failed"]);

/** The numeric fields of a progress line, or null for a line that is not one. */
function parseProgress(line: Record<string, unknown>): PruneScanProgress | null {
  if (line.phase !== "scan") return null;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const done = num(line.done);
  const total = num(line.total);
  if (done === null || total === null) return null;
  return {
    done,
    total,
    chunks: num(line.chunks) ?? 0,
    chunksPerSecond: num(line.chunksPerSecond) ?? 0,
    etaSeconds: num(line.etaSeconds),
  };
}

export function createPrune(cfg: InstanceConfig, deps: PruneDeps = {}) {
  const spawnJob = deps.spawnJob ?? spawnJobAsInstanceUser;
  const run = deps.run ?? runAsInstanceUser;
  const now = deps.now ?? Date.now;
  const jobs = new Map<string, Job>();

  async function scriptPath(): Promise<string | null> {
    const target = path.join(cfg.scriptsDir, PRUNE_SCRIPT);
    try {
      await fsp.access(target);
      return target;
    } catch {
      return null;
    }
  }

  function trim(): void {
    const finished = [...jobs.values()]
      .filter((j) => j.state !== "running")
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
    for (const job of finished.slice(PRUNE_JOBS_KEPT)) jobs.delete(job.id);
  }

  async function startPruneScan(params?: PruneParams): Promise<{ jobId: string }> {
    const script = await scriptPath();
    if (!script) throw new PruneUnavailableError();
    if ([...jobs.values()].some((j) => j.state === "running")) throw new PruneBusyError();

    const job: Job = {
      id: randomUUID(),
      state: "running",
      result: null,
      error: null,
      finishedAt: null,
      progress: null,
      cancelled: false,
      handle: null,
    };
    jobs.set(job.id, job);

    // A manual selection can outgrow what one argument may hold, so parameters travel on stdin.
    const args = [interpreter("node"), script, "--scan"];
    if (params) args.push("--params-stdin");

    let last: Record<string, unknown> | null = null;
    const finish = (state: "done" | "failed", error: string | null): void => {
      job.state = state;
      job.error = error;
      job.finishedAt = now();
      job.handle = null;
      trim();
    };
    try {
      const handle = spawnJob(cfg, args, {
        timeoutMs: PRUNE_SCAN_TIMEOUT_MS,
        label: "Prune scan",
        ...(params ? { input: JSON.stringify(params) } : {}),
        onLine: (line) => {
          try {
            const parsed: unknown = JSON.parse(line);
            if (!isRecord(parsed)) return;
            if (typeof parsed.ok === "boolean") last = parsed;
            else job.progress = parseProgress(parsed) ?? job.progress;
          } catch {
            /* not ours */
          }
        },
      });
      job.handle = handle;
      void handle.done.then(
        ({ exitCode }) => {
          if (job.cancelled) return finish("failed", "cancelled");
          if (exitCode === 0 && last?.ok === true) {
            job.result = last as unknown as PruneSummary;
            return finish("done", null);
          }
          const code = typeof last?.code === "string" && KNOWN_CODES.has(last.code) ? last.code : "failed";
          finish("failed", code);
        },
        (err: unknown) => {
          log.error("prune", `${cfg.id}: ${err instanceof Error ? err.message : String(err)}`);
          finish("failed", "failed");
        },
      );
    } catch (err) {
      finish("failed", "failed");
      throw err;
    }
    return { jobId: job.id };
  }

  function getPruneScan(jobId: string): PruneScanJob | null {
    const job = jobs.get(jobId);
    if (!job) return null;
    return {
      jobId: job.id,
      state: job.state,
      ...(job.result ? { result: job.result } : {}),
      ...(job.error ? { error: job.error } : {}),
      ...(job.progress ? { progress: job.progress } : {}),
    };
  }

  /**
   * Stop a running scan. A scan only reads and every cache write is atomic, so
   * stopping the process is safe; what it already read stays cached. Returns
   * false when there is no such running scan.
   */
  function cancelPruneScan(jobId: string): boolean {
    const job = jobs.get(jobId);
    if (!job || job.state !== "running" || !job.handle) return false;
    job.cancelled = true;
    job.handle.cancel();
    return true;
  }

  /** Runs a short mode of the script; the last output line is one JSON object. */
  async function scriptCall(args: string[], label: string): Promise<Record<string, unknown>> {
    const script = await scriptPath();
    if (!script) throw new PruneUnavailableError();
    const res = await run(cfg, [interpreter("node"), script, ...args], {
      timeoutMs: PRUNE_SETTINGS_TIMEOUT_MS,
      label,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.output.trim().split("\n").pop() ?? "");
    } catch {
      throw new PruneScriptError("failed");
    }
    if (!isRecord(parsed) || parsed.ok !== true) {
      const code = isRecord(parsed) && typeof parsed.code === "string" && KNOWN_CODES.has(parsed.code) ? parsed.code : "failed";
      throw new PruneScriptError(code);
    }
    return parsed;
  }

  async function settingsCall(args: string[]): Promise<PruneParams> {
    const parsed = await scriptCall(args, "Prune settings");
    if (!isRecord(parsed.params)) throw new PruneScriptError("failed");
    return parsed.params as unknown as PruneParams;
  }

  const getPruneSettings = (): Promise<PruneParams> => settingsCall(["--settings=get"]);
  const setPruneSettings = (params: PruneParams): Promise<PruneParams> =>
    settingsCall(["--settings=set", `--params=${JSON.stringify(params)}`]);

  /** The dimensions of the world with their region counts, from directory listings only. */
  async function getPruneDimensions(): Promise<PruneDimensions> {
    const parsed = await scriptCall(["--dimensions"], "Prune dimensions");
    const list = Array.isArray(parsed.dimensions) ? parsed.dimensions : [];
    const dimensions = list.filter(
      (d): d is { id: string; regions: number } =>
        isRecord(d) && typeof d.id === "string" && typeof d.regions === "number",
    );
    return { dimensions: dimensions.map((d) => ({ id: d.id, regions: d.regions })) };
  }

  /** One chunk of a stored plan, read now. Null when the plan is gone. */
  async function inspectPruneChunk(planId: string, dimension: string, cx: number, cz: number): Promise<PruneChunkInfo | null> {
    try {
      const parsed = await scriptCall(
        ["--inspect", `--plan=${planId}`, `--dimension=${dimension}`, `--cx=${cx}`, `--cz=${cz}`],
        "Prune inspect",
      );
      const info: Record<string, unknown> = { ...parsed };
      delete info.ok;
      return info as unknown as PruneChunkInfo;
    } catch (err) {
      if (err instanceof PruneScriptError && err.code === "plan_missing") return null;
      throw err;
    }
  }

  /** Engine version, and a note when an earlier delete did not finish. */
  async function getPruneStatus(): Promise<PruneEngineStatus> {
    const parsed = await scriptCall(["--status"], "Prune status");
    const unfinished = isRecord(parsed.unfinishedApply) ? parsed.unfinishedApply : null;
    return {
      engine: typeof parsed.engine === "string" ? parsed.engine : "unknown",
      version: typeof parsed.version === "number" ? parsed.version : 0,
      ...(unfinished && typeof unfinished.state === "string"
        ? {
            unfinishedApply: {
              state: unfinished.state === "applying" ? ("applying" as const) : ("failed" as const),
              plan: typeof unfinished.plan === "string" ? unfinished.plan : "",
              startedAt: typeof unfinished.startedAt === "string" ? unfinished.startedAt : "",
            },
          }
        : {}),
    };
  }

  /**
   * The cell and heat map of one dimension of a stored plan, as the JSON text
   * the script wrote. Read here rather than through the script because it can
   * be megabytes, past what a script's output is allowed to carry.
   */
  async function readPruneMap(planId: string, dimensionIndex: number): Promise<string | null> {
    const file = path.join(cfg.scriptsDir, PRUNE_DIR, `${planId}.map.${dimensionIndex}.json`);
    try {
      const stat = await fsp.stat(file);
      if (stat.size > PRUNE_MAP_MAX_BYTES) throw new PruneScriptError("map_too_large");
      return await fsp.readFile(file, "utf8");
    } catch (err) {
      if (err instanceof PruneScriptError) throw err;
      return null;
    }
  }

  return {
    startPruneScan,
    getPruneScan,
    cancelPruneScan,
    getPruneDimensions,
    getPruneStatus,
    inspectPruneChunk,
    getPruneSettings,
    setPruneSettings,
    readPruneMap,
    hasPruneScript: async () => (await scriptPath()) !== null,
  };
}
