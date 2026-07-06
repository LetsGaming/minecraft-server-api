import { describe, it, expect } from "vitest";
import { encodePkt, decodePkt } from "../src/rcon.js";

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

describe("decodePkt hostile input (A-09)", () => {
  it("rejects a negative length field", () => {
    const buf = Buffer.alloc(20);
    buf.writeInt32LE(-1, 0);
    expect(decodePkt(buf)).toBeNull();
  });

  it("rejects an absurdly large length field", () => {
    const buf = Buffer.alloc(20);
    buf.writeInt32LE(1_000_000, 0);
    expect(decodePkt(buf)).toBeNull();
  });

  it("rejects a length below the RCON minimum", () => {
    const buf = Buffer.alloc(20);
    buf.writeInt32LE(9, 0);
    expect(decodePkt(buf)).toBeNull();
  });
});
