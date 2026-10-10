import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

import {
  COMPAT_CACHE_TTL_MS,
  COMPAT_CONCURRENCY,
  COMPAT_JOB_RETENTION_MS,
  COMPAT_MAX_JOBS,
  COMPAT_REFRESH_MIN_MS,
  createCompatSlots,
  COMPAT_MAX_RUNNING,
  CompatBusyError,
  CompatManifestMissingError,
  classifyResult,
  createModCompat,
  type InstalledSnapshot,
} from "../../src/instances/modCompat.js";
import type { ModCompatJob } from "../../src/contracts/wire.js";

function installed(...slugs: string[]): InstalledSnapshot {
  return {
    modLoader: "fabric",
    mods: slugs.map((slug) => ({ slug, versionId: `${slug}-v1` })),
  };
}

function scriptResult(slug: string, entry: Record<string, unknown>) {
  return { mcVersion: "1.21.5", modLoader: "fabric", results: [{ slug, ...entry }] };
}

async function finished(
  compat: ReturnType<typeof createModCompat>,
  jobId: string,
): Promise<ModCompatJob> {
  for (let i = 0; i < 200; i++) {
    const job = compat.get(jobId)!;
    if (job.state !== "running") return job;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error("job never finished");
}

describe("classifyResult", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["up_to_date", {}, "available"],
    ["update_available", { latestVersionId: "v2" }, "available"],
    ["no_versions", { message: "none" }, "unavailable"],
    ["no_matching_version", { message: "none" }, "unavailable"],
    ["invalid_entry", { message: "bad" }, "unknown"],
    ["error", { error: "boom" }, "unknown"],
    ["something_new", {}, "unknown"],
  ];
  it.each(cases)("maps %s to %s", (status, extra, availability) => {
    const mod = classifyResult("a", "a-v1", { slug: "a", status, ...extra });
    expect(mod.availability).toBe(availability);
    expect(mod.currentVersionId).toBe("a-v1");
    if (availability === "available") expect(mod.reason).toBeUndefined();
    else expect(mod.reason).toBeTruthy();
  });

  it("carries the target release of an update", () => {
    const mod = classifyResult("a", "a-v1", {
      status: "update_available",
      latestVersionId: "v2",
      latestVersionName: "A 2.0",
      datePublished: "2026-01-01T00:00:00Z",
      downloadUrl: "https://cdn.modrinth.com/data/x/a.jar",
    });
    expect(mod.target).toEqual({
      versionId: "v2",
      versionName: "A 2.0",
      datePublished: "2026-01-01T00:00:00Z",
      downloadUrl: "https://cdn.modrinth.com/data/x/a.jar",
    });
  });

  const LEAKY = "ENOENT /home/mcuser/server/scripts/update/check-updates.js sudo: a password is required token=hunter2";

  it.each([
    [{ status: "error", error: LEAKY }],
    [{ status: "error", error: { description: LEAKY } }],
    [{ status: "invalid_entry", message: LEAKY }],
    [{ status: "no_versions", message: LEAKY }],
    [{ status: "weird", message: LEAKY }],
  ])("never forwards script text: %j", (entry) => {
    const mod = classifyResult("a", null, entry);
    expect(mod.reason).toBeTruthy();
    expect(mod.reason).not.toMatch(/home|mcuser|sudo|hunter2|[.]js|[/]/);
  });

  it("maps upstream failures to fixed phrases", () => {
    const reason = (error: unknown) =>
      classifyResult("a", null, { status: "error", error }).reason;
    expect(reason("connect ETIMEDOUT 1.2.3.4:443")).toBe("timeout");
    expect(reason("getaddrinfo ENOTFOUND api.modrinth.com")).toBe("modrinth unreachable");
    expect(reason({ error: "rate_limit", status: 429 })).toBe("rate limited");
    expect(reason("Request failed with status code 404")).toBe("mod not found on modrinth");
    expect(reason("anything else")).toBe("check failed");
  });

  it("keeps only a Modrinth CDN download link", () => {
    const url = (downloadUrl: string) =>
      classifyResult("a", null, {
        status: "update_available",
        latestVersionId: "v2",
        downloadUrl,
      }).target?.downloadUrl;
    expect(url("https://cdn.modrinth.com/data/x/versions/y/a.jar")).toBe(
      "https://cdn.modrinth.com/data/x/versions/y/a.jar",
    );
    expect(url("http://cdn.modrinth.com/a.jar")).toBeUndefined();
    expect(url("https://evil.example/a.jar")).toBeUndefined();
    expect(url("file:///etc/passwd")).toBeUndefined();
  });

  it("treats a missing entry as unknown", () => {
    expect(classifyResult("a", null, undefined).availability).toBe("unknown");
  });
});

describe("createModCompat", () => {
  let snapshot: InstalledSnapshot | null;
  let checkOne: Mock<(slug: string, mcVersion: string) => Promise<unknown>>;
  let clock: number;
  let compat: ReturnType<typeof createModCompat>;

  beforeEach(() => {
    snapshot = installed("a", "b", "c");
    clock = 1_000_000;
    checkOne = vi.fn(async (slug: string, _v: string) =>
      scriptResult(slug, { status: "up_to_date" }),
    );
    compat = createModCompat({
      readInstalled: async () => snapshot,
      checkOne,
      now: () => clock,
    });
  });

  it("runs the check once per slug and returns the final contract", async () => {
    snapshot = installed("c", "a", "b");
    checkOne.mockImplementation(async (slug: string) =>
      slug === "a"
        ? scriptResult(slug, { status: "no_versions", message: "none" })
        : slug === "b"
          ? scriptResult(slug, { status: "error", error: "429" })
          : scriptResult(slug, { status: "up_to_date" }),
    );
    const { jobId } = await compat.start("1.21.5");
    const job = await finished(compat, jobId);

    expect(checkOne).toHaveBeenCalledTimes(3);
    expect(job.state).toBe("done");
    expect(job.progress).toEqual({ done: 3, total: 3 });
    expect(job.partial).toEqual([]);
    expect(job.mcVersion).toBe("1.21.5");
    expect(job.modLoader).toBe("fabric");
    expect(job.summary).toEqual({ available: 1, unavailable: 1, unknown: 1, total: 3 });
    expect(job.complete).toBe(false);
    expect(job.mods!.map((m) => [m.slug, m.availability])).toEqual([
      ["a", "unavailable"],
      ["b", "unknown"],
      ["c", "available"],
    ]);
  });

  it("reports live progress and partial results while running", async () => {
    const gates = new Map<string, () => void>();
    checkOne.mockImplementation(
      (slug: string) =>
        new Promise((resolve) => {
          gates.set(slug, () => resolve(scriptResult(slug, { status: "up_to_date" })));
        }),
    );
    const { jobId } = await compat.start("1.21.5");
    await vi.waitFor(() => expect(gates.size).toBe(3));
    expect(compat.get(jobId)).toMatchObject({
      state: "running",
      progress: { done: 0, total: 3 },
      partial: [],
    });
    gates.get("a")!();
    await vi.waitFor(() => expect(compat.get(jobId)!.progress.done).toBe(1));
    const mid = compat.get(jobId)!;
    expect(mid.partial.map((m) => m.slug)).toEqual(["a"]);
    expect(mid.mods).toBeUndefined();
    gates.get("b")!();
    gates.get("c")!();
    expect((await finished(compat, jobId)).state).toBe("done");
  });

  it("bounds how many slugs are checked at once", async () => {
    snapshot = installed("a", "b", "c", "d", "e", "f", "g", "h");
    let active = 0;
    let peak = 0;
    checkOne.mockImplementation(async (slug: string) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
      return scriptResult(slug, { status: "up_to_date" });
    });
    const { jobId } = await compat.start("1.21.5");
    await finished(compat, jobId);
    expect(peak).toBe(COMPAT_CONCURRENCY);
  });

  it("returns the running job for a second request on the same version", async () => {
    checkOne.mockImplementation(() => new Promise(() => undefined));
    const first = await compat.start("1.21.5");
    const second = await compat.start("1.21.5");
    expect(second.jobId).toBe(first.jobId);
    const other = await compat.start("1.20.1");
    expect(other.jobId).not.toBe(first.jobId);
  });

  it("refuses new versions beyond the running-job limit", async () => {
    checkOne.mockImplementation(() => new Promise(() => undefined));
    for (let i = 0; i < COMPAT_MAX_RUNNING; i++) await compat.start(`1.${i}`);
    await expect(compat.start("1.99")).rejects.toBeInstanceOf(CompatBusyError);
  });

  it("one failing slug does not fail the job", async () => {
    checkOne.mockImplementation(async (slug: string) => {
      if (slug === "b") throw new Error("spawn failed");
      return scriptResult(slug, { status: "up_to_date" });
    });
    const job = await finished(compat, (await compat.start("1.21.5")).jobId);
    expect(job.state).toBe("done");
    expect(job.summary).toEqual({ available: 2, unavailable: 0, unknown: 1, total: 3 });
    expect(job.mods!.find((m) => m.slug === "b")!.reason).toBe("script failed");
  });

  it("fails the job only when every slug could not run", async () => {
    checkOne.mockRejectedValue(
      new Error("sudo: /home/mcuser/scripts/update/check-updates.js: not found"),
    );
    const job = await finished(compat, (await compat.start("1.21.5")).jobId);
    expect(job.state).toBe("failed");
    expect(job.error).toBe("script failed");
    expect(JSON.stringify(job)).not.toMatch(/home|sudo|mcuser/);
  });

  it("issues unguessable uuid job ids and keeps jobs per instance", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) ids.add((await compat.start(`1.${i}`)).jobId);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    expect(ids.size).toBe(5);

    const other = createModCompat({ readInstalled: async () => snapshot, checkOne });
    const [id] = [...ids];
    expect(other.get(id!)).toBeNull();
    expect(compat.get(id!)).not.toBeNull();
  });

  it("finishes an empty mod set as done", async () => {
    snapshot = installed();
    const job = await finished(compat, (await compat.start("1.21.5")).jobId);
    expect(job).toMatchObject({ state: "done", complete: true });
    expect(job.summary!.total).toBe(0);
  });

  it("reports a missing manifest", async () => {
    snapshot = null;
    await expect(compat.start("1.21.5")).rejects.toBeInstanceOf(
      CompatManifestMissingError,
    );
  });

  describe("cache", () => {
    it("answers a repeat request without running the script", async () => {
      await finished(compat, (await compat.start("1.21.5")).jobId);
      checkOne.mockClear();
      const again = await compat.start("1.21.5");
      expect(checkOne).not.toHaveBeenCalled();
      expect(compat.get(again.jobId)).toMatchObject({ state: "done" });
    });

    it("keys on the version", async () => {
      await finished(compat, (await compat.start("1.21.5")).jobId);
      checkOne.mockClear();
      await finished(compat, (await compat.start("1.20.1")).jobId);
      expect(checkOne).toHaveBeenCalledTimes(3);
    });

    it("keys on the installed mod set", async () => {
      await finished(compat, (await compat.start("1.21.5")).jobId);
      checkOne.mockClear();
      snapshot = installed("a", "b", "c", "d");
      await finished(compat, (await compat.start("1.21.5")).jobId);
      expect(checkOne).toHaveBeenCalledTimes(4);
    });

    it("refresh bypasses it", async () => {
      await finished(compat, (await compat.start("1.21.5")).jobId);
      checkOne.mockClear();
      clock += COMPAT_REFRESH_MIN_MS + 1;
      await finished(compat, (await compat.start("1.21.5", { refresh: true })).jobId);
      expect(checkOne).toHaveBeenCalledTimes(3);
    });

    it("expires after the TTL", async () => {
      await finished(compat, (await compat.start("1.21.5")).jobId);
      checkOne.mockClear();
      clock += COMPAT_CACHE_TTL_MS + 1;
      await finished(compat, (await compat.start("1.21.5")).jobId);
      expect(checkOne).toHaveBeenCalledTimes(3);
    });

    it("is dropped by invalidate()", async () => {
      await finished(compat, (await compat.start("1.21.5")).jobId);
      checkOne.mockClear();
      compat.invalidate();
      await finished(compat, (await compat.start("1.21.5")).jobId);
      expect(checkOne).toHaveBeenCalledTimes(3);
    });

    it("does not store the answer of a job that a mutation overtook", async () => {
      let release!: () => void;
      checkOne.mockImplementation(
        (slug: string) =>
          new Promise((resolve) => {
            release = () => resolve(scriptResult(slug, { status: "up_to_date" }));
            setTimeout(release, 5);
          }),
      );
      const { jobId } = await compat.start("1.21.5");
      compat.invalidate();
      await finished(compat, jobId);
      checkOne.mockClear();
      checkOne.mockImplementation(async (slug: string) =>
        scriptResult(slug, { status: "up_to_date" }),
      );
      await finished(compat, (await compat.start("1.21.5")).jobId);
      expect(checkOne).toHaveBeenCalledTimes(3);
    });
  });


  describe("resource caps", () => {
    it("shares a process-wide running limit across instances", async () => {
      const slots = createCompatSlots(2);
      checkOne.mockImplementation(() => new Promise(() => undefined));
      const mk = () => createModCompat({ readInstalled: async () => snapshot, checkOne, slots });
      const a = mk();
      const b = mk();
      await a.start("1.1");
      await b.start("1.2");
      await expect(a.start("1.3")).rejects.toBeInstanceOf(CompatBusyError);
      await expect(b.start("1.4")).rejects.toBeInstanceOf(CompatBusyError);
    });

    it("frees a slot when a job finishes", async () => {
      const slots = createCompatSlots(1);
      const one = createModCompat({ readInstalled: async () => snapshot, checkOne, slots });
      await finished(one, (await one.start("1.1")).jobId);
      await expect(one.start("1.2")).resolves.toBeDefined();
    });

    it("cycling through many distinct versions never runs more than the per-instance cap", async () => {
      checkOne.mockImplementation(() => new Promise(() => undefined));
      let accepted = 0;
      for (let i = 0; i < 50; i++) {
        try {
          await compat.start("1." + i);
          accepted++;
        } catch (err) {
          expect(err).toBeInstanceOf(CompatBusyError);
        }
      }
      expect(accepted).toBe(COMPAT_MAX_RUNNING);
    });

    it("rate limits refresh per version", async () => {
      await finished(compat, (await compat.start("1.21.5")).jobId);
      await expect(compat.start("1.21.5", { refresh: true })).rejects.toBeInstanceOf(CompatBusyError);
      clock += COMPAT_REFRESH_MIN_MS + 1;
      await expect(compat.start("1.21.5", { refresh: true })).resolves.toBeDefined();
    });

    it("keeps the number of remembered jobs bounded when starts are answered from the cache", async () => {
      const first = await compat.start("1.21.5");
      await finished(compat, first.jobId);
      const ids: string[] = [];
      for (let i = 0; i < COMPAT_MAX_JOBS * 3; i++) {
        ids.push((await compat.start("1.21.5")).jobId);
        clock += 1;
      }
      const alive = ids.filter((id) => compat.get(id) !== null).length;
      expect(alive).toBeLessThanOrEqual(COMPAT_MAX_JOBS);
    });
  });

  describe("eviction", () => {
    it("forgets a finished job after the retention window", async () => {
      const { jobId } = await compat.start("1.21.5");
      await finished(compat, jobId);
      clock += COMPAT_JOB_RETENTION_MS - 1;
      expect(compat.get(jobId)).not.toBeNull();
      clock += 2;
      expect(compat.get(jobId)).toBeNull();
    });

    it("never evicts a running job", async () => {
      checkOne.mockImplementation(() => new Promise(() => undefined));
      const { jobId } = await compat.start("1.21.5");
      clock += COMPAT_JOB_RETENTION_MS * 10;
      expect(compat.get(jobId)).not.toBeNull();
    });

    it("returns null for an unknown id", () => {
      expect(compat.get("00000000-0000-0000-0000-000000000000")).toBeNull();
    });
  });
});
