"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { encodePkt, decodePkt } = require("../src/rcon");

describe("RCON packet codec", () => {
  it("round-trips a non-empty body", () => {
    const encoded = encodePkt(42, 2, "list");
    const decoded = decodePkt(encoded);
    assert.equal(decoded.id, 42);
    assert.equal(decoded.type, 2);
    assert.equal(decoded.body, "list");
    assert.equal(decoded.totalSize, encoded.length);
  });

  it("round-trips an empty body", () => {
    const encoded = encodePkt(1, 3, "");
    const decoded = decodePkt(encoded);
    assert.equal(decoded.id, 1);
    assert.equal(decoded.type, 3);
    assert.equal(decoded.body, "");
  });

  it("returns null for a buffer that is too short (< 14 bytes)", () => {
    assert.equal(decodePkt(Buffer.alloc(10)), null);
  });

  it("returns null when the buffer contains a partial packet", () => {
    const full = encodePkt(7, 2, "say hello world");
    const partial = full.subarray(0, full.length - 4);
    assert.equal(decodePkt(partial), null);
  });

  it("handles multi-byte UTF-8 body", () => {
    const body = "§aGreen §rReset";
    const encoded = encodePkt(99, 2, body);
    const decoded = decodePkt(encoded);
    assert.equal(decoded.body, body);
  });

  // A-09 regression tests
  it("returns null for a packet with a negative length field", () => {
    const buf = Buffer.alloc(20);
    buf.writeInt32LE(-1, 0); // length = -1
    buf.writeInt32LE(42, 4);
    buf.writeInt32LE(2, 8);
    assert.equal(decodePkt(buf), null);
  });

  it("returns null for a packet with an absurdly large length field", () => {
    const buf = Buffer.alloc(20);
    buf.writeInt32LE(99999, 0); // length = 99999, way above 4096 cap
    buf.writeInt32LE(42, 4);
    buf.writeInt32LE(2, 8);
    assert.equal(decodePkt(buf), null);
  });

  it("returns null for a packet with length = 9 (below minimum of 10)", () => {
    const buf = Buffer.alloc(20);
    buf.writeInt32LE(9, 0);
    buf.writeInt32LE(1, 4);
    buf.writeInt32LE(3, 8);
    assert.equal(decodePkt(buf), null);
  });
});
