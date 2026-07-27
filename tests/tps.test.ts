/**
 * getTps parsing.
 *
 * These guards were written in minecraft-bot, against its own RCON client,
 * and covered three real regressions. That client is gone in bot 5.0.0 —
 * the wrapper owns the RCON connection now, so it is the only side that
 * ever sees a `tps` response, and it inherits the bugs along with the job.
 *
 * The parser here already had the fixes; it had no tests at all. Porting
 * them rather than deleting them with the bot's copy, because "the code
 * looks right" is how they got shipped broken the first time.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const send = vi.fn();
vi.mock("../src/rcon.js", () => ({
  RconClient: class {
    send = send;
    disconnect = vi.fn();
    lastSuccessTime = 0;
  },
}));

import { createOperations } from "../src/operations.js";
import type { InstanceConfig } from "../src/types.js";

function ops() {
  return createOperations({
    id: "smp",
    serverPath: "/tmp/nonexistent",
    scriptsDir: "/tmp/nonexistent",
    backupsPath: "/tmp/nonexistent",
    linuxUser: "mc",
    useRcon: true,
    rconHost: "127.0.0.1",
    rconPort: 25575,
    rconPassword: "pw",
  } as InstanceConfig);
}

beforeEach(() => send.mockReset());

describe("getTps — Paper", () => {
  it("parses the tps triplet", async () => {
    send.mockResolvedValue("TPS from last 1m, 5m, 15m: *19.98, *19.99, *20.0");
    expect(await ops().getTps()).toMatchObject({
      type: "paper",
      tps1m: 19.98,
      tps5m: 19.99,
      tps15m: 20.0,
    });
  });

  it("parses values without the '*' prefix", async () => {
    send.mockResolvedValue("TPS from last 1m, 5m, 15m: 20.0, 20.0, 20.0");
    expect(await ops().getTps()).toMatchObject({ tps1m: 20.0 });
  });

  it("reports a degraded server rather than clamping it", async () => {
    send.mockResolvedValue("TPS from last 1m, 5m, 15m: *8.21, *12.4, *17.9");
    expect((await ops().getTps())?.tps1m).toBeCloseTo(8.21);
  });

  it("does not match stray digits before the values (Bug 4)", async () => {
    // Three comma-separated numbers that sit neither after a colon nor at
    // the start of a line. An unanchored regex reads this as a TPS triplet
    // and reports 12 TPS, firing a false Low TPS alert.
    send.mockResolvedValue("Server ticking 12, 34, 56 ms behind");
    expect(await ops().getTps()).toBeNull();
  });

  it("returns null for an empty response rather than a zero triplet", async () => {
    send.mockResolvedValue("");
    expect(await ops().getTps()).toBeNull();
  });

  it("keeps trying `tps` after a network error (Bug 1)", async () => {
    // A blip says nothing about whether the server supports `tps`. Caching
    // "unsupported" here permanently demoted Paper servers to the tick-query
    // path, which they do not have.
    vi.useFakeTimers();
    try {
      send.mockRejectedValueOnce(new Error("ECONNRESET"));
      send.mockRejectedValueOnce(new Error("ECONNRESET")); // tick query too
      const o = ops();
      expect(await o.getTps()).toBeNull();

      // Past the short result cache. That cache is a load guard, not a
      // capability verdict — the distinction Bug 1 was about.
      await vi.advanceTimersByTimeAsync(10_000);

      send.mockReset();
      send.mockResolvedValue("TPS from last 1m, 5m, 15m: *20.0, *20.0, *20.0");
      expect((await o.getTps())?.tps1m).toBeCloseTo(20.0);
      expect(send).toHaveBeenCalledWith("tps");
    } finally {
      vi.useRealTimers();
    }
  });

  it("serves repeat calls from a short cache instead of re-asking the server", async () => {
    // TPS costs an RCON round-trip against the very thread that is struggling
    // whenever anyone bothers to ask for it. A status poll, an embed refresh
    // and a /tps arriving together must cost one measurement, not three.
    send.mockResolvedValue("TPS from last 1m, 5m, 15m: *19.5, *20.0, *20.0");
    const o = ops();

    const [a, b, c] = await Promise.all([o.getTps(), o.getTps(), o.getTps()]);
    expect(a?.tps1m).toBeCloseTo(19.5);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("getTps — vanilla tick query fallback", () => {
  it("falls back when `tps` is unknown", async () => {
    send.mockResolvedValueOnce("Unknown command. Try /help");
    send.mockResolvedValueOnce("Average time per tick: 40.0 ms");
    const tps = await ops().getTps();
    expect(tps).toMatchObject({ mspt: 40.0 });
    expect(tps?.tps1m).toBeCloseTo(25 > 20 ? 20 : 25);
  });

  it("caps TPS at 20 even when MSPT is very small (Bug 3)", async () => {
    send.mockResolvedValueOnce("Unknown command");
    send.mockResolvedValueOnce("Average time per tick: 1.0 ms");
    expect((await ops().getTps())?.tps1m).toBe(20);
  });

  it("returns null when the expected line is missing (Bug 2)", async () => {
    // A zero TPS would fire a false Low TPS alert; absence is not zero.
    send.mockResolvedValueOnce("Unknown command");
    send.mockResolvedValueOnce("Something else entirely");
    expect(await ops().getTps()).toBeNull();
  });

  it("returns null when tick query is also unsupported", async () => {
    send.mockResolvedValue("Unknown command. Try /help");
    expect(await ops().getTps()).toBeNull();
  });
});
