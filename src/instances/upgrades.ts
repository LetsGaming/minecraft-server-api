/**
 * The server version upgrade as a background job.
 *
 * The suite's `update/upgrade.sh` does all the work (stop, backup, install,
 * start, fall back); this module only starts it, relays its NDJSON progress
 * to whoever polls, and keeps the instance slot taken while it runs. The job
 * state lives in memory, but the script also writes the same lines to
 * `common/upgrade-status.ndjson`, so after a wrapper restart a poller can still
 * be told what happened ("finished", or "interrupted" when the script is gone
 * without a result line).
 */
import { randomUUID } from "crypto";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";

import { log } from "../platform/logger.js";
import {
  interpreter,
  jobStateDir,
  processGroupAlive,
  spawnJobAsInstanceUser,
  type JobSpawnHandle,
} from "../platform/spawn.js";
import type { InstanceConfig } from "../config/types.js";
import type { UpgradeEvent, UpgradeJob, UpgradeResult } from "../contracts/wire.js";
import { OperationBusyError, type OperationSlot } from "./operationSlot.js";

import { UPGRADE_SCRIPT } from "./scripts.js";
const STATUS_FILE = path.join("common", "upgrade-status.ndjson");

/**
 * Countdown, stop, a ten-minute backup, install, two start attempts and a
 * possible restore. A job that outlives this is wedged, not slow.
 */
export const UPGRADE_TIMEOUT_MS = 90 * 60_000;
export const UPGRADE_MAX_EVENTS = 500;
export const UPGRADE_JOBS_KEPT = 5;
export const UPGRADE_JOB_RETENTION_MS = 6 * 60 * 60_000;
export const MAX_COUNTDOWN_SECONDS = 600;

/** Exit status upgrade.sh uses when another operation holds the file lock. */
const EXIT_BUSY = 75;

export class UpgradeUnavailableError extends Error {
  constructor() {
    super("This instance's setup suite has no upgrade script");
  }
}

export class PrunePlanMissingError extends Error {
  constructor() {
    super("That prune plan does not exist any more. Scan again.");
  }
}

export interface UpgradeRequest {
  /** The version to move to. Absent for a prune-only job. */
  mcVersion?: string;
  /** The mods the user saw reported as unavailable; the job refuses if they changed. */
  expectUnavailable?: string[];
  countdownSeconds?: number;
  /** A stored prune plan to apply after the install, before the first start. */
  prunePlan?: string;
  /** Run the prune alone: stop, back up, prune, start. */
  pruneOnly?: boolean;
}

interface Job {
  id: string;
  kind: "upgrade" | "prune";
  mcVersion: string;
  state: "running" | "done" | "failed";
  startedAt: number;
  finishedAt: number | null;
  events: UpgradeEvent[];
  result: UpgradeResult | null;
  error: string | null;
}

export interface UpgradeDeps {
  spawnJob?: (
    target: InstanceConfig,
    command: string[],
    opts: Parameters<typeof spawnJobAsInstanceUser>[2],
  ) => JobSpawnHandle;
  now?: () => number;
  /** Where the running job's record is kept; defaults to the wrapper's job state dir. */
  recordDir?: string;
  /** Liveness of a recorded job's process group. */
  isAlive?: (pgid: number) => boolean;
  /** How often a job recovered after a restart is checked for having ended. */
  recoveryPollMs?: number;
}

/**
 * The running job, on disk (W-009). The job outlives a wrapper restart; the
 * jobs map and the slot do not. This record is how the next wrapper knows a
 * job is still running, keeps the slot taken for it (so nobody stops or
 * restarts the server under an upgrade), and reports it as running rather
 * than interrupted.
 */
interface JobRecord {
  pgid: number;
  jobId: string;
  kind: "upgrade" | "prune";
  mcVersion: string;
  startedAt: number;
  files: string[];
}

function isJobRecord(v: unknown): v is JobRecord {
  return (
    isRecord(v) &&
    typeof v.pgid === "number" &&
    typeof v.jobId === "string" &&
    (v.kind === "upgrade" || v.kind === "prune") &&
    typeof v.mcVersion === "string" &&
    typeof v.startedAt === "number" &&
    Array.isArray(v.files)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One NDJSON line from the script to either a progress event or the result; null for anything else. */
export function parseUpgradeLine(
  line: string,
): { event: UpgradeEvent } | { result: UpgradeResult } | null {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(obj)) return null;
  if (obj.type === "result" && typeof obj.ok === "boolean") {
    const rest: Record<string, unknown> = { ...obj };
    delete rest.type;
    delete rest.seq;
    delete rest.ts;
    return { result: rest as unknown as UpgradeResult };
  }
  if (typeof obj.seq === "number" && typeof obj.phase === "string") {
    return {
      event: {
        seq: obj.seq,
        ts: typeof obj.ts === "number" ? obj.ts : 0,
        phase: obj.phase,
        status: typeof obj.status === "string" ? obj.status : "running",
        msg: typeof obj.msg === "string" ? obj.msg : "",
      },
    };
  }
  return null;
}

export function createUpgrades(
  cfg: InstanceConfig,
  slot: OperationSlot,
  deps: UpgradeDeps = {},
) {
  const spawnJob = deps.spawnJob ?? spawnJobAsInstanceUser;
  const now = deps.now ?? Date.now;
  const isAlive = deps.isAlive ?? processGroupAlive;
  const jobs = new Map<string, Job>();
  const recordPath = path.join(deps.recordDir ?? jobStateDir(), `${cfg.id}.upgrade.json`);

  function writeRecord(record: JobRecord): void {
    try {
      fs.mkdirSync(path.dirname(recordPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(recordPath, JSON.stringify(record), { mode: 0o600 });
    } catch (err) {
      log.warn("upgrade", `${cfg.id}: could not record the running job: ${(err as Error).message}`);
    }
  }

  function removeRecord(files: readonly string[] = []): void {
    for (const f of [recordPath, ...files]) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* best effort */
      }
    }
  }

  /** A job a previous wrapper process started that is still running. */
  let recovered: JobRecord | null = null;

  (function recover(): void {
    let record: unknown;
    try {
      record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    } catch {
      return; // no record: nothing was running
    }
    if (!isJobRecord(record) || !isAlive(record.pgid)) {
      removeRecord(isJobRecord(record) ? record.files : []);
      return;
    }
    const release = slot.begin(record.kind, record.jobId);
    if (!release) return;
    recovered = record;
    log.info("upgrade", `${cfg.id}: ${record.kind} job ${record.jobId} still running after a restart`);
    const timer = setInterval(() => {
      if (recovered && isAlive(recovered.pgid)) return;
      clearInterval(timer);
      removeRecord(recovered?.files);
      recovered = null;
      release();
    }, deps.recoveryPollMs ?? 5_000);
    timer.unref();
  })();

  function prune(): void {
    const finished = [...jobs.values()]
      .filter((j) => j.state !== "running")
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
    finished.forEach((job, index) => {
      const expired = now() - (job.finishedAt ?? 0) > UPGRADE_JOB_RETENTION_MS;
      if (index >= UPGRADE_JOBS_KEPT || expired) jobs.delete(job.id);
    });
  }

  async function scriptPath(): Promise<string | null> {
    const target = path.join(cfg.scriptsDir, UPGRADE_SCRIPT);
    try {
      await fsp.access(target);
      return target;
    } catch {
      return null;
    }
  }

  /**
   * True only when the plan file is certainly absent. The plan directory belongs
   * to the instance user, so a permission error means "cannot tell", and the
   * script's own check before the stop then decides.
   */
  async function planIsGone(planId: string): Promise<boolean> {
    try {
      await fsp.access(path.join(cfg.scriptsDir, "common", "prune", `${planId}.plan.json`));
      return false;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ENOENT";
    }
  }

  async function start(request: UpgradeRequest): Promise<{ jobId: string }> {
    const script = await scriptPath();
    if (!script) throw new UpgradeUnavailableError();
    if (request.prunePlan && (await planIsGone(request.prunePlan))) throw new PrunePlanMissingError();

    const jobId = randomUUID();
    const kind = request.pruneOnly ? "prune" : "upgrade";
    const release = slot.begin(kind, jobId);
    if (!release) throw new OperationBusyError(slot.current() ?? { kind: "unknown" });

    const job: Job = {
      id: jobId,
      kind,
      mcVersion: request.mcVersion ?? "",
      state: "running",
      startedAt: now(),
      finishedAt: null,
      events: [],
      result: null,
      error: null,
    };
    jobs.set(jobId, job);

    const args: string[] = request.pruneOnly ? ["--prune-only"] : [request.mcVersion ?? ""];
    if (request.prunePlan) args.push(`--prune-plan=${request.prunePlan}`);
    if (request.expectUnavailable) {
      args.push(`--expect-unavailable=${request.expectUnavailable.join(",")}`);
    }
    if (request.countdownSeconds !== undefined) {
      args.push(`--countdown=${Math.min(MAX_COUNTDOWN_SECONDS, Math.max(0, Math.floor(request.countdownSeconds)))}`);
    }

    let handleFiles: readonly string[] = [];
    const finish = (state: "done" | "failed", error: string | null): void => {
      job.state = state;
      job.error = error;
      job.finishedAt = now();
      removeRecord(handleFiles);
      release();
      prune();
    };

    try {
      const handle = spawnJob(cfg, [interpreter("bash"), script, ...args], {
        timeoutMs: UPGRADE_TIMEOUT_MS,
        label: "Upgrade",
        onLine: (line) => {
          const parsed = parseUpgradeLine(line);
          if (!parsed) return;
          if ("result" in parsed) job.result = parsed.result;
          else if (job.events.length < UPGRADE_MAX_EVENTS) job.events.push(parsed.event);
        },
      });
      handleFiles = handle.outputFiles ?? [];
      if (handle.pid !== undefined) {
        writeRecord({
          pgid: handle.pid,
          jobId,
          kind,
          mcVersion: job.mcVersion,
          startedAt: job.startedAt,
          files: [...handleFiles],
        });
      }
      void handle.done.then(
        ({ exitCode }) => {
          if (exitCode === 0) return finish("done", null);
          finish("failed", exitCode === EXIT_BUSY ? "busy" : (job.result ? null : "failed"));
        },
        (err: unknown) => {
          log.error("upgrade", `${cfg.id}: ${err instanceof Error ? err.message : String(err)}`);
          finish("failed", "failed");
        },
      );
    } catch (err) {
      finish("failed", "failed");
      throw err;
    }
    return { jobId };
  }

  function view(job: Job, since: number): UpgradeJob {
    const events = job.events.filter((e) => e.seq > since);
    return {
      jobId: job.id,
      kind: job.kind,
      state: job.state,
      mcVersion: job.mcVersion,
      events,
      next: events.length > 0 ? events[events.length - 1]!.seq : since,
      ...(job.result ? { result: job.result } : {}),
      ...(job.error ? { error: job.error } : {}),
    };
  }

  function get(jobId: string, since = 0): UpgradeJob | null {
    const job = jobs.get(jobId);
    return job ? view(job, since) : null;
  }

  /**
   * The running job, else the latest one this process knows, else whatever the
   * script left in its status file (which survives a wrapper restart).
   */
  async function current(since = 0): Promise<UpgradeJob | null> {
    const live = [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt)[0];
    if (live) return view(live, since);
    return readStatusFile(since);
  }

  async function readStatusFile(since: number): Promise<UpgradeJob | null> {
    let text: string;
    try {
      text = await fsp.readFile(path.join(cfg.scriptsDir, STATUS_FILE), "utf8");
    } catch {
      return null;
    }
    const events: UpgradeEvent[] = [];
    let result: UpgradeResult | null = null;
    for (const line of text.split("\n")) {
      const parsed = line.trim() ? parseUpgradeLine(line.trim()) : null;
      if (!parsed) continue;
      if ("result" in parsed) result = parsed.result;
      else events.push(parsed.event);
    }
    if (events.length === 0 && !result) return null;
    const fresh = events.filter((e) => e.seq > since);
    // No result and nothing holds the slot: the script died or was killed.
    // A job recovered after a restart holds the slot until it ends (W-009).
    const interrupted = !result && slot.current() === null;
    return {
      jobId: recovered?.jobId ?? "recovered",
      kind: recovered?.kind ?? "upgrade",
      state: result ? (result.ok ? "done" : "failed") : interrupted ? "failed" : "running",
      mcVersion: recovered?.mcVersion ?? "",
      events: fresh,
      next: fresh.length > 0 ? fresh[fresh.length - 1]!.seq : since,
      ...(result ? { result } : {}),
      ...(interrupted ? { error: "interrupted" } : {}),
    };
  }

  return {
    startUpgrade: start,
    getUpgrade: get,
    getCurrentUpgrade: current,
    hasUpgradeScript: async () => (await scriptPath()) !== null,
  };
}
