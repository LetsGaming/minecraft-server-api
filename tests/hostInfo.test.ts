/**
 * /info host-metrics parsing — ps/df outputs are canned via the exec
 * seam so the parse logic (which mirrors the bot's local
 * hostResources.ts) is pinned exactly. Real-command smoke happens in
 * app.test.ts through the unmocked /info route.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../src/exec.js", () => ({ execSafe: vi.fn() }));

import { execSafe } from "../src/exec.js";
import {
  getDiskUsage,
  getServerProcessUsage,
  monitoredPaths,
} from "../src/hostInfo.js";
import type { InstanceConfig } from "../src/types.js";

const mockExec = vi.mocked(execSafe);

describe("getDiskUsage (df -Pk parsing)", () => {
  it("parses POSIX df output into bytes", async () => {
    mockExec.mockResolvedValueOnce({
      ok: true,
      stdout:
        "Filesystem     1024-blocks      Used Available Capacity Mounted on\n" +
        "/dev/sda1        102400000  51200000  46080000      53% /\n",
    });
    expect(await getDiskUsage("/opt/mc")).toEqual({
      path: "/opt/mc",
      usedPercent: 53,
      availableBytes: 46080000 * 1024,
      totalBytes: 102400000 * 1024,
    });
  });

  it("returns null when df fails", async () => {
    mockExec.mockResolvedValueOnce({ ok: false, stdout: "" });
    expect(await getDiskUsage("/nope")).toBeNull();
  });

  it("returns null for unparseable output", async () => {
    mockExec.mockResolvedValueOnce({ ok: true, stdout: "garbage\n" });
    expect(await getDiskUsage("/x")).toBeNull();
  });
});

describe("getServerProcessUsage (ps parsing)", () => {
  it("picks the biggest java process of the user", async () => {
    mockExec.mockResolvedValueOnce({
      ok: true,
      stdout:
        "  101  1.0  50000 bash\n" +
        "  202 45.5 4194304 java\n" +
        "  303 12.0 1048576 java\n",
    });
    expect(await getServerProcessUsage("minecraft")).toEqual({
      pid: 202,
      cpuPercent: 45.5,
      rssBytes: 4194304 * 1024,
    });
  });

  it("returns null when no java process exists", async () => {
    mockExec.mockResolvedValueOnce({ ok: true, stdout: "  1 0.0 1000 bash\n" });
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
