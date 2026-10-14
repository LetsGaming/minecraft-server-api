import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import net from "net";

import { RconClient } from "../../src/platform/rcon/client.js";
import { decodePkt, encodePkt } from "../../src/platform/rcon/packet.js";

type Mode = "drop" | "ok" | "silent" | "long" | "garbage" | "mute" | "hangup";

let mode: Mode;
let server: net.Server;
let port: number;
const sockets = new Set<net.Socket>();
let connections: number;

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await tick();
}

beforeEach(async () => {
  mode = "drop";
  connections = 0;
  server = net.createServer((sock) => {
    connections++;
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => {});
    if (mode === "drop") {
      sock.destroy();
      return;
    }
    sock.on("data", (buf) => {
      if (mode === "silent") return;
      const pkt = decodePkt(buf);
      if (!pkt) return;
      if (pkt.type === 3) sock.write(encodePkt(1, 2, ""));
      else if (pkt.type === 2) {
        if (mode === "mute") return;
        if (mode === "hangup") {
          sock.destroy();
          return;
        }
        if (mode === "garbage") {
          const bad = Buffer.alloc(20);
          bad.writeInt32LE(-5, 0);
          sock.write(bad);
          return;
        }
        const body = mode === "long" ? "y".repeat(4096) : `echo:${pkt.body}`;
        sock.write(encodePkt(pkt.id, 0, body));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as net.AddressInfo).port;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(async () => {
  vi.useRealTimers();
  for (const s of sockets) s.destroy();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("RconClient auth timeout", () => {
  it("disarms the auth timer when the socket closes during auth", async () => {
    const client = new RconClient("127.0.0.1", port, "pw");
    await expect(client.connect()).rejects.toThrow("RCON lost");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not let a stale auth timer kill a newer healthy connection", async () => {
    const client = new RconClient("127.0.0.1", port, "pw");
    await expect(client.connect()).rejects.toThrow("RCON lost");

    await vi.advanceTimersByTimeAsync(2_500);
    mode = "ok";
    await client.connect();
    expect(await client.send("list")).toBe("echo:list");

    await vi.advanceTimersByTimeAsync(11_000);
    await settle();
    expect(await client.send("list")).toBe("echo:list");
    expect(connections).toBe(2);
  });

  it("still times out an authentication that never answers", async () => {
    mode = "silent";
    const client = new RconClient("127.0.0.1", port, "pw");
    const attempt = client.connect();
    const assertion = expect(attempt).rejects.toThrow("RCON auth timeout");
    await settle();
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });
});

describe("RconClient framing (W-003)", () => {
  it("takes a full-size reply and keeps answering afterwards", async () => {
    mode = "long";
    const client = new RconClient("127.0.0.1", port, "pw");
    expect(await client.send("big")).toHaveLength(4096);
    mode = "ok";
    expect(await client.send("list")).toBe("echo:list");
  });

  it("drops a connection that is out of step and starts clean", async () => {
    mode = "garbage";
    const client = new RconClient("127.0.0.1", port, "pw");
    await expect(client.send("list")).rejects.toMatchObject({
      name: "RconNoReplyError",
    });
    mode = "ok";
    expect(await client.send("list")).toBe("echo:list");
    expect(connections).toBe(2);
  });

  it("reports a missing reply as RconNoReplyError, not a delivery failure", async () => {
    mode = "mute";
    const client = new RconClient("127.0.0.1", port, "pw");
    const attempt = client.send("list");
    const assertion = expect(attempt).rejects.toMatchObject({
      name: "RconNoReplyError",
      message: "RCON timeout",
    });
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });
});

describe("RconClient connection loss (W-005)", () => {
  it("reports a command whose connection dropped after the write as RconNoReplyError", async () => {
    mode = "ok";
    const client = new RconClient("127.0.0.1", port, "pw");
    await client.connect();
    mode = "hangup";
    await expect(client.send("give Steve diamond")).rejects.toMatchObject({
      name: "RconNoReplyError",
      message: "RCON lost",
    });
  });
});
