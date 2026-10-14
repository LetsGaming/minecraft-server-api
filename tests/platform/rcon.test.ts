import { describe, it, expect } from "vitest";
import {
  encodePkt,
  decodePkt,
  RconFramingError,
} from "../../src/platform/rcon/packet.js";

describe("RCON packet encoding", () => {
  it("round-trips a command packet", () => {
    const buf = encodePkt(42, 2, "list");
    const pkt = decodePkt(buf);
    expect(pkt).not.toBeNull();
    expect(pkt!.id).toBe(42);
    expect(pkt!.type).toBe(2);
    expect(pkt!.body).toBe("list");
    expect(pkt!.totalSize).toBe(buf.length);
  });

  it("returns null for a truncated buffer", () => {
    const buf = encodePkt(1, 2, "hello");
    expect(decodePkt(buf.subarray(0, 10))).toBeNull();
  });

  it("handles multi-byte UTF-8 bodies", () => {
    const pkt = decodePkt(encodePkt(7, 0, "ünïcode ✓"));
    expect(pkt!.body).toBe("ünïcode ✓");
  });
});

describe("decodePkt hostile input (A-09, W-003)", () => {
  // A bad length can never become a packet, and waiting for "more data"
  // would leave it blocking the buffer forever, so it is a framing error.
  it.each([
    ["a negative length field", -1],
    ["an absurdly large length field", 1_000_000],
    ["a length below the RCON minimum", 9],
  ])("throws on %s", (_name, length) => {
    const buf = Buffer.alloc(20);
    buf.writeInt32LE(length, 0);
    expect(() => decodePkt(buf)).toThrow(RconFramingError);
  });

  it("accepts a full 4096-byte Minecraft reply", () => {
    const body = "x".repeat(4096);
    const pkt = decodePkt(encodePkt(5, 0, body));
    expect(pkt?.body).toBe(body);
  });
});
