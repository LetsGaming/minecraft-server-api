/**
 * /info host-metrics parsing — ps/df outputs are canned via the exec
 * seam so the parse logic (which mirrors the bot's local
 * hostResources.ts) is pinned exactly. Real-command smoke happens in
 * app.test.ts through the unmocked /info route.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/platform/exec.js", () => ({ execSafe: vi.fn() }));

import { execSafe } from "../../src/platform/exec.js";
import { getServerProcessUsage } from "../../src/platform/host/index.js";
import {
  cpuPercentBetween,
  parseMemInfo,
  parsePidCpuJiffies,
  parseProcStat,
} from "../../src/platform/host/cpu.js";
import { getDiskUsage, monitoredPaths } from "../../src/platform/host/disk.js";
import type { InstanceConfig } from "../../src/config/types.js";

const mockExec = vi.mocked(execSafe);

const DF_OUTPUT =
  "Filesystem     1024-blocks      Used Available Capacity Mounted on\n" +
  "/dev/sda1        102400000  51200000  46080000      53% /\n";

/** getDiskUsage runs df and du concurrently; queue both in call order. */
function mockDfAndDu(df: string | null, duKb: number | null): void {
  mockExec.mockImplementation((cmd: string) => {
    if (cmd === "df") {
      return Promise.resolve({ ok: df !== null, stdout: df ?? "" });
    }
    if (cmd === "du") {
      return Promise.resolve({
        ok: duKb !== null,
        stdout: duKb === null ? "" : `${duKb}\t/opt/mc\n`,
      });
    }
    return Promise.resolve({ ok: false, stdout: "" });
  });
}

describe("getDiskUsage (df + du)", () => {
  it("reports the directory's own size alongside its filesystem", async () => {
    mockDfAndDu(DF_OUTPUT, 5_242_880);
    expect(await getDiskUsage("/opt/mc")).toEqual({
      path: "/opt/mc",
      sizeBytes: 5_242_880 * 1024,
      filesystem: {
        mountPoint: "/",
        usedPercent: 53,
        availableBytes: 46080000 * 1024,
        totalBytes: 102400000 * 1024,
      },
    });
  });

  it("still reports the filesystem when du times out on a big backup dir", async () => {
    mockDfAndDu(DF_OUTPUT, null);
    const usage = await getDiskUsage("/opt/mc");
    expect(usage?.sizeBytes).toBeNull();
    expect(usage?.filesystem.usedPercent).toBe(53);
  });

  it("returns null when df fails", async () => {
    mockDfAndDu(null, 100);
    expect(await getDiskUsage("/nope")).toBeNull();
  });

  it("returns null for unparseable df output", async () => {
    mockDfAndDu("garbage\n", 100);
    expect(await getDiskUsage("/x")).toBeNull();
  });
});

describe("whole-machine sampling", () => {
  it("parses /proc/stat and counts iowait as idle", () => {
    const totals = parseProcStat("cpu  100 20 50 800 30 0 0 0 0 0\ncpu0 1 2 3\n");
    expect(totals).toEqual({ idle: 830, total: 1000 });
  });

  it("derives utilisation from two samples", () => {
    // 1000 jiffies elapsed, 200 of them busy.
    expect(
      cpuPercentBetween({ idle: 800, total: 1000 }, { idle: 1600, total: 2000 }),
    ).toBe(20);
  });

  it("reports 0 rather than NaN when no time elapsed between samples", () => {
    expect(
      cpuPercentBetween({ idle: 800, total: 1000 }, { idle: 800, total: 1000 }),
    ).toBe(0);
  });

  it("uses MemAvailable, so page cache is not counted as used", () => {
    const mem = parseMemInfo(
      "MemTotal:       16384000 kB\nMemFree:          512000 kB\nMemAvailable:    8192000 kB\n",
    );
    expect(mem).toEqual({
      totalBytes: 16384000 * 1024,
      availableBytes: 8192000 * 1024,
    });
  });

  it("returns null when /proc/meminfo lacks MemAvailable (very old kernels)", () => {
    expect(parseMemInfo("MemTotal: 16384000 kB\nMemFree: 512000 kB\n")).toBeNull();
  });
});

describe("parsePidCpuJiffies", () => {
  const stat = (comm: string) =>
    `1234 (${comm}) S 1 1234 1234 0 -1 4194560 ` +
    // fields 10..13 → the two we want are utime=400 stime=100
    `100 200 0 0 400 100 0 0 20 0 12 0 987654 ...`;

  it("sums utime and stime", () => {
    expect(parsePidCpuJiffies(stat("java"))).toBe(500);
  });

  it("survives a comm containing spaces and brackets", () => {
    // A process name is attacker-adjacent input here: it comes from the
    // host, and splitting on whitespace from the left would misalign.
    expect(parsePidCpuJiffies(stat("java (old) gen"))).toBe(500);
  });

  it("returns null for a truncated stat line", () => {
    expect(parsePidCpuJiffies("1234 (java) S 1 2")).toBeNull();
  });
});

describe("getServerProcessUsage (ps parsing)", () => {
  it("picks the biggest java process of the user", async () => {
    // ps no longer supplies pcpu — CPU is sampled from /proc, which is
    // absent for these fake pids, so it degrades to 0.
    mockExec.mockResolvedValueOnce({
      ok: true,
      stdout:
        "  101  50000 bash\n" +
        "  202 4194304 java\n" +
        "  303 1048576 java\n",
    });
    expect(await getServerProcessUsage("minecraft")).toEqual({
      pid: 202,
      cpuPercent: 0,
      rssBytes: 4194304 * 1024,
    });
  });

  it("returns null when no java process exists", async () => {
    mockExec.mockResolvedValueOnce({ ok: true, stdout: "  1 1000 bash\n" });
    expect(await getServerProcessUsage("minecraft")).toBeNull();
  });

  it("returns null when ps fails (unknown user)", async () => {
    mockExec.mockResolvedValueOnce({ ok: false, stdout: "" });
    expect(await getServerProcessUsage("ghost")).toBeNull();
  });
});

describe("monitoredPaths", () => {
  const base: InstanceConfig = {
    id: "t",
    serverPath: "/opt/mc/survival",
    linuxUser: "minecraft",
    useRcon: false,
    rconHost: "localhost",
    rconPort: 25575,
    rconPassword: "",
    backupsPath: "",
    scriptsDir: "/opt/mc/scripts",
  };

  it("reports the server dir alone without a backups path", () => {
    expect(monitoredPaths(base)).toEqual(["/opt/mc/survival"]);
  });

  it("adds the backups dir and dedupes resolved paths", () => {
    expect(
      monitoredPaths({ ...base, backupsPath: "/opt/mc/survival/../backups" }),
    ).toEqual(["/opt/mc/survival", "/opt/mc/backups"]);
    expect(
      monitoredPaths({ ...base, backupsPath: "/opt/mc/survival/." }),
    ).toEqual(["/opt/mc/survival"]);
  });
});
