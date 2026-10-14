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

/**
 * Largest packet length accepted. Minecraft splits a reply into packets of
 * at most 4096 body bytes, so a full one is 4106 bytes long (id, type and
 * the two terminators on top); the margin allows for servers that pack more.
 */
export const MAX_PACKET_LENGTH = 64 * 1024;

/** The stream can no longer be split into packets; the connection is unusable. */
export class RconFramingError extends Error {
  constructor(length: number) {
    super(`RCON framing error (packet length ${length})`);
    this.name = "RconFramingError";
  }
}

/**
 * Decode the packet at the start of `buf`; null when it has not fully
 * arrived yet.
 *
 * A-09: a negative or absurd length is never a packet. W-003: it is not
 * "nothing yet" either — returning null for it left the bytes at the head
 * of the buffer, so every later reply queued behind them and every command
 * timed out. Throwing lets the client drop the connection and start clean.
 */
export function decodePkt(buf: Buffer): RconPacket | null {
  if (buf.length < 4) return null;
  const length = buf.readInt32LE(0);
  if (length < 10 || length > MAX_PACKET_LENGTH) {
    throw new RconFramingError(length);
  }
  if (buf.length < 4 + length) return null;
  return {
    id: buf.readInt32LE(4),
    type: buf.readInt32LE(8),
    body: buf.toString("utf-8", 12, 4 + length - 2),
    totalSize: 4 + length,
  };
}
