/**
 * The bug: `isRunning()` sent `list` over RCON and called a timeout "stopped".
 *
 * A server pinned by chunk generation, a busy evening, or mob-AI simulation
 * stops answering RCON long before it stops running, and one that is still
 * starting has not begun answering yet. All three reported `running: false`,
 * which downstream became downtime alerts, empty player lists, and closed
 * play sessions for a server that was up the whole time.
 *
 * So what is asserted here is mostly the separation: liveness comes from
 * probes that survive a stalled game thread, RCON answers only the
 * responsiveness question, and the two are reported as different fields.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import net from "net";
import type { AddressInfo } from "net";

import {
  createHealthMonitor,
  parsePlayerList,
  tcpProbe,
  HEALTH_FRESH_MS,
} from "../src/health.js";
import { cached } from "../src/cache.js";
import type { InstanceConfig } from "../src/types.js";
import type { RconClient } from "../src/rcon.js";

// Every OS probe shells out; stub the layer they share so these tests assert
// the decision logic rather than the contents of this container's process table.
const execSafeMock = vi.fn();
vi.mock("../src/exec.js", () => ({
  execSafe: (...args: unknown[]) => execSafeMock(...args),
}));

const processUsageMock = vi.fn();
vi.mock("../src/hostInfo.js", () => ({
  getServerProcessUsage: (...args: unknown[]) => processUsageMock(...args),
}));

function cfg(overrides: Partial<InstanceConfig> = {}): InstanceConfig {
  return {
    id: "smp",
    serverPath: "/srv/smp",
    linuxUser: "mc",
    useRcon: true,
    rconHost: "127.0.0.1",
    rconPort: 25575,
    rconPassword: "pw",
    backupsPath: "",
    scriptsDir: "/srv/scripts",
    ...overrides,
  };
}

/** A stand-in RCON client: only `send` and `lastSuccessTime` are consulted. */
function fakeRcon(send: ReturnType<typeof vi.fn>, lastSuccessTime = 0): RconClient {
  return { send, lastSuccessTime } as unknown as RconClient;
}

const LIST_OK = "There are 2 of a max of 20 players online: Alice, Bob";

beforeEach(() => {
  execSafeMock.mockReset();
  processUsageMock.mockReset();
  // Default: nothing found by the OS probes unless a test says otherwise.
  execSafeMock.mockResolvedValue({ stdout: "", ok: true });
  processUsageMock.mockResolvedValue(null);
});

// ── tcpProbe ───────────────────────────────────────────────────────────────

describe("tcpProbe", () => {
  it("is true for a bound listener and false for a closed port", async () => {
    // The property that matters: a connect is accepted by the JVM's IO
    // threads even when the game thread is blocked, so this stays true for a
    // server that cannot answer a single RCON command.
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;

    expect(await tcpProbe("127.0.0.1", port, 1_000)).toBe(true);

    await new Promise<void>((r) => server.close(() => r()));
    expect(await tcpProbe("127.0.0.1", port, 1_000)).toBe(false);
  });
});

// ── State resolution ───────────────────────────────────────────────────────

describe("health state resolution", () => {
  it("is online when RCON answers", async () => {
    const send = vi.fn().mockResolvedValue(LIST_OK);
    const health = await createHealthMonitor(cfg(), fakeRcon(send)).get();

    expect(health.state).toBe("online");
    expect(health.processUp).toBe(true);
    expect(health.probe).toBe("rcon");
    expect(health.rcon).toMatchObject({ configured: true, responsive: true });
  });

  it("is unresponsive — NOT offline — when RCON times out but the port is open", async () => {
    // The original bug, in one assertion.
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;

    const send = vi.fn().mockRejectedValue(new Error("RCON timeout"));
    const health = await createHealthMonitor(
      cfg({ rconPort: port }),
      fakeRcon(send),
    ).get();

    expect(health.state).toBe("unresponsive");
    expect(health.state).not.toBe("offline");
    expect(health.processUp).toBe(true);
    expect(health.probe).toBe("socket");
    expect(health.rcon).toMatchObject({ configured: true, responsive: false });

    await new Promise<void>((r) => server.close(() => r()));
  });

  it("is unresponsive when only a java process is found — the startup window", async () => {
    // RCON binds late in startup, so the socket probe fails while the server
    // is genuinely coming up. `ps` covers that gap without sudo.
    processUsageMock.mockResolvedValue({ pid: 42, cpuPercent: 90, rssBytes: 1 });
    const send = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    // Port 1 is not listening, so the socket probe falls through to ps.
    const health = await createHealthMonitor(
      cfg({ rconPort: 1 }),
      fakeRcon(send),
    ).get();

    expect(health.state).toBe("unresponsive");
    expect(health.probe).toBe("process");
  });

  it("is unresponsive when only a screen session is found", async () => {
    execSafeMock.mockResolvedValue({ stdout: "\t12345.smp\t(Detached)", ok: true });
    const send = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const health = await createHealthMonitor(
      cfg({ rconPort: 1 }),
      fakeRcon(send),
    ).get();

    expect(health.state).toBe("unresponsive");
    expect(health.probe).toBe("screen");
  });

  it("is offline only when every probe comes back negative", async () => {
    const send = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const health = await createHealthMonitor(
      cfg({ rconPort: 1 }),
      fakeRcon(send),
    ).get();

    expect(health.state).toBe("offline");
    expect(health.processUp).toBe(false);
    expect(health.probe).toBe("none");
  });

  it("is online from a process probe alone when RCON is not configured", async () => {
    // Without RCON there is no responsiveness question to answer, so a live
    // process is the best and the whole answer.
    processUsageMock.mockResolvedValue({ pid: 42, cpuPercent: 1, rssBytes: 1 });
    const health = await createHealthMonitor(cfg({ useRcon: false }), null).get();

    expect(health.state).toBe("online");
    expect(health.rcon).toMatchObject({ configured: false, responsive: false });
  });

  it("trusts a very recent round-trip instead of sending another command", async () => {
    const send = vi.fn();
    const health = await createHealthMonitor(
      cfg(),
      fakeRcon(send, Date.now()),
    ).get();

    expect(health.state).toBe("online");
    expect(send).not.toHaveBeenCalled();
  });
});

// ── Load behaviour ─────────────────────────────────────────────────────────

describe("behaviour under load", () => {
  it("collapses concurrent callers onto one probe", async () => {
    // Three consumers poll this wrapper. Each starting its own RCON round-trip
    // against a stalled game thread is how the API itself came to look down.
    const send = vi.fn().mockResolvedValue(LIST_OK);
    const monitor = createHealthMonitor(cfg(), fakeRcon(send));

    await Promise.all([monitor.get(), monitor.get(), monitor.get()]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("serves the player list from the health probe's own round-trip", async () => {
    // getList used to send a second `list`. It is the same command.
    const send = vi.fn().mockResolvedValue(LIST_OK);
    const monitor = createHealthMonitor(cfg(), fakeRcon(send));

    await monitor.get();
    const list = await monitor.getList();

    expect(list).toEqual({
      playerCount: "2",
      maxPlayers: "20",
      players: ["Alice", "Bob"],
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps the last roster for an unresponsive server rather than reporting zero", async () => {
    // "0 players online" is a claim. A stale-but-true roster beats a fresh lie
    // — and a lag spike is not an exodus.
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;

    const send = vi.fn().mockResolvedValue(LIST_OK);
    const monitor = createHealthMonitor(cfg({ rconPort: port }), fakeRcon(send));
    expect((await monitor.getList()).players).toEqual(["Alice", "Bob"]);

    vi.useFakeTimers();
    try {
      send.mockRejectedValue(new Error("RCON timeout"));
      await vi.advanceTimersByTimeAsync(HEALTH_FRESH_MS + 1_000);

      const health = await monitor.get();
      expect(health.state).toBe("unresponsive");
      expect((await monitor.getList()).players).toEqual(["Alice", "Bob"]);
    } finally {
      vi.useRealTimers();
    }

    await new Promise<void>((r) => server.close(() => r()));
  });

  it("empties the roster once the server is confirmed stopped", async () => {
    const send = vi.fn().mockResolvedValue(LIST_OK);
    const monitor = createHealthMonitor(cfg({ rconPort: 1 }), fakeRcon(send));
    expect((await monitor.getList()).players).toEqual(["Alice", "Bob"]);

    vi.useFakeTimers();
    try {
      send.mockRejectedValue(new Error("ECONNREFUSED"));
      await vi.advanceTimersByTimeAsync(HEALTH_FRESH_MS + 1_000);

      expect((await monitor.get()).state).toBe("offline");
      expect(await monitor.getList()).toEqual({
        playerCount: "0",
        maxPlayers: "?",
        players: [],
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── The cache primitive ────────────────────────────────────────────────────

describe("cached()", () => {
  afterEach(() => vi.useRealTimers());

  it("serves a stale value while a refresh runs instead of queueing", async () => {
    // The property that keeps the API answering while the server is
    // struggling: a caller never waits behind a load that is slow precisely
    // because the thing being loaded is slow.
    vi.useFakeTimers();
    let resolveSecond: (v: number) => void = () => {};
    let call = 0;
    const load = vi.fn().mockImplementation(() => {
      call++;
      if (call === 1) return Promise.resolve(1);
      return new Promise<number>((r) => {
        resolveSecond = r;
      });
    });

    const c = cached(load, { freshMs: 100, staleMs: 10_000 });
    expect((await c.get()).value).toBe(1);

    await vi.advanceTimersByTimeAsync(500); // past fresh, inside stale
    const second = c.get(); // starts the slow refresh
    const third = c.get(); // must not wait for it

    expect((await third).value).toBe(1); // the stale value, immediately
    resolveSecond(2);
    expect((await second).value).toBe(2);
  });

  it("waits for a load when the cached value is older than staleMs", async () => {
    vi.useFakeTimers();
    const load = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    const c = cached(load, { freshMs: 100, staleMs: 1_000 });

    expect((await c.get()).value).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await c.get()).value).toBe(2);
  });
});

// ── Parsing ────────────────────────────────────────────────────────────────

describe("parsePlayerList", () => {
  it("reads the vanilla form", () => {
    expect(parsePlayerList(LIST_OK)).toEqual({
      playerCount: "2",
      maxPlayers: "20",
      players: ["Alice", "Bob"],
    });
  });

  it("reads an empty server without inventing a player", () => {
    expect(
      parsePlayerList("There are 0 of a max of 20 players online:"),
    ).toEqual({ playerCount: "0", maxPlayers: "20", players: [] });
  });

  it("degrades to zeros on an unrecognised response", () => {
    expect(parsePlayerList("Unknown command")).toEqual({
      playerCount: "0",
      maxPlayers: "?",
      players: [],
    });
  });
});
