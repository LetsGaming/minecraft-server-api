"use strict";

const net = require("net");

// ── Packet encoding/decoding ──────────────────────────────────────────────

function encodePkt(id, type, body) {
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

function decodePkt(buf) {
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

// ── RconClient ────────────────────────────────────────────────────────────

class RconClient {
  constructor(host, port, password) {
    this.host = host;
    this.port = port;
    this.password = password;
    this._socket = null;
    this._auth = false;
    this._connecting = false;
    this._cmdId = 10;
    this._pending = new Map();
    this._buf = Buffer.alloc(0);
    this._authResolve = null;
    this._authReject = null;
    // F-004: waiter queue replaces the 50ms poll-loop for concurrent callers
    this._waiters = [];
    this.lastSuccessTime = 0;
  }

  _cleanup() {
    this._auth = false;
    this._connecting = false;
    if (this._socket) {
      this._socket.removeAllListeners();
      this._socket.destroy();
      this._socket = null;
    }
    for (const [, cb] of this._pending) {
      clearTimeout(cb.timer);
      cb.reject(new Error("RCON lost"));
    }
    this._pending.clear();
    this._buf = Buffer.alloc(0);
    if (this._authReject) {
      this._authReject(new Error("RCON lost"));
      this._authResolve = null;
      this._authReject = null;
    }
    // F-004: reject any concurrent callers waiting on auth
    for (const w of this._waiters) w.reject(new Error("RCON lost"));
    this._waiters = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      if (this._auth && this._socket && !this._socket.destroyed)
        return resolve();

      // F-004: instead of a 50ms poll-loop, queue the caller and resolve/
      // reject it alongside the primary auth promise. No setTimeout leak.
      if (this._connecting) {
        this._waiters.push({ resolve, reject });
        return;
      }

      this._cleanup();
      this._connecting = true;
      this._authResolve = resolve;
      this._authReject = reject;
      this._socket = new net.Socket();
      this._socket.setKeepAlive(true, 30000);

      const authTimeout = setTimeout(() => {
        this._cleanup();
        reject(new Error("RCON auth timeout"));
      }, 10000);

      this._socket.connect(this.port, this.host, () => {
        this._socket.write(encodePkt(1, 3, this.password));
      });

      this._socket.on("data", (data) => {
        this._buf = Buffer.concat([this._buf, data]);
        for (;;) {
          const pkt = decodePkt(this._buf);
          if (!pkt) break;
          this._buf = this._buf.subarray(pkt.totalSize);

          if (!this._auth) {
            clearTimeout(authTimeout);
            if (pkt.id === -1) {
              this._connecting = false;
              const err = new Error("RCON auth failed");
              // reject waiters before _cleanup clears the lists
              for (const w of this._waiters) w.reject(err);
              this._waiters = [];
              this._cleanup();
              reject(err);
              return;
            }
            if (pkt.id === 1) {
              this._auth = true;
              this._connecting = false;
              this._authResolve();
              this._authResolve = null;
              this._authReject = null;
              // F-004: wake all concurrent callers
              for (const w of this._waiters) w.resolve();
              this._waiters = [];
            }
            continue;
          }

          const cb = this._pending.get(pkt.id);
          if (cb) {
            clearTimeout(cb.timer);
            this._pending.delete(pkt.id);
            this.lastSuccessTime = Date.now();
            cb.resolve(pkt.body);
          }
        }
      });

      this._socket.on("error", () => this._cleanup());
      this._socket.on("close", () => this._cleanup());
    });
  }

  async send(command, timeoutMs = 5000) {
    await this.connect();
    const id = this._cmdId++;
    if (this._cmdId > 2e9) this._cmdId = 10;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error("RCON timeout"));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      this._socket.write(encodePkt(id, 2, command));
    });
  }
}

module.exports = { RconClient, encodePkt, decodePkt };
