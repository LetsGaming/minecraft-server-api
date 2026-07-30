/**
 * RCON wire format — the Source RCON packet codec, split out from the client
 * so the framing rules can be tested without a socket.
 */

export function encodePkt(id: number, type: number, body: string): Buffer {
  const b = Buffer.from(body, "utf-8");
  const len = 4 + 4 + b.length + 2;
  const buf = Buffer.alloc(4 + len);
  buf.writeInt32LE(len, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  b.copy(buf, 12);
  buf[12 + b.length] = 0;
  buf[13 + b.length] = 0;
  return buf;
}

export interface RconPacket {
  id: number;
  type: number;
  body: string;
  totalSize: number;
}

export function decodePkt(buf: Buffer): RconPacket | null {
  if (buf.length < 14) return null;
  const length = buf.readInt32LE(0);
  // A-09: reject negative lengths and absurdly large values. A valid RCON
  // packet is at minimum 10 bytes of payload (4 id + 4 type + 2 terminators)
  // and in practice never exceeds 4 KB. A corrupt or hostile packet with a
  // negative length would pass the next check (4 + -1 = 3 ≤ buf.length) and
  // produce a silent empty body instead of being discarded.
  if (length < 10 || length > 4096) return null;
  if (buf.length < 4 + length) return null;
  return {
    id: buf.readInt32LE(4),
    type: buf.readInt32LE(8),
    body: buf.toString("utf-8", 12, 4 + length - 2),
    totalSize: 4 + length,
  };
}
