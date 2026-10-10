import { describe, it, expect, vi, beforeEach } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({ execFile: execFileMock }));

import { createCommands } from "../../src/instances/commands.js";
import type { RconClient } from "../../src/platform/rcon/client.js";
import type { InstanceConfig } from "../../src/config/types.js";

const cfg = { id: "survival", linuxUser: "minecraft" } as InstanceConfig;

function rconReturning(result: string | Error): RconClient {
  return {
    send: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  } as unknown as RconClient;
}

beforeEach(() => {
  execFileMock.mockReset();
  execFileMock.mockImplementation((_bin, _args, _opts, cb) => cb(null));
});

describe("sendCommand", () => {
  it("sends through RCON without the leading slash", async () => {
    const rcon = rconReturning("done");
    const out = await createCommands(cfg, rcon).sendCommand("/say hi");
    expect(out).toBe("done");
    expect(rcon.send).toHaveBeenCalledWith("say hi");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("falls back to screen stuff when RCON throws", async () => {
    const rcon = rconReturning(new Error("down"));
    const out = await createCommands(cfg, rcon).sendCommand("say hi");
    expect(out).toBeNull();
    const [bin, args, opts] = execFileMock.mock.calls[0]!;
    expect(bin).toBe("sudo");
    expect(args).toEqual([
      "-n", "-u", "minecraft", "screen", "-S", "survival", "-X", "stuff", "/say hi\r",
    ]);
    expect(opts.timeout).toBe(15_000);
  });

  it("uses screen directly with no RCON and strips control characters", async () => {
    await createCommands(cfg, null).sendCommand("/say a\nstop");
    expect(execFileMock.mock.calls[0]![1].at(-1)).toBe("/say astop\r");
  });

  it("resolves null even when screen fails", async () => {
    execFileMock.mockImplementation((_b, _a, _o, cb) => cb(new Error("no screen")));
    await expect(createCommands(cfg, null).sendCommand("list")).resolves.toBeNull();
  });
});
