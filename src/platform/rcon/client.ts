/**
 * Minimal RCON client — one instance per configured Minecraft server.
 * Reconnects lazily on send(); concurrent callers during a connect are
 * queued (F-004) instead of poll-looping. The packet codec lives in
 * packet.ts.
 */
import net from "net";

import { decodePkt, encodePkt } from "./packet.js";

// ── RconClient ────────────────────────────────────────────────────────────

interface Pending {
  resolve: (body: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
}

export class RconClient {
  readonly host: string;
  readonly port: number;
  private readonly password: string;

  private _socket: net.Socket | null = null;
  private _auth = false;
  private _connecting = false;
  private _cmdId = 10;
  private readonly _pending = new Map<number, Pending>();
  private _buf = Buffer.alloc(0);
  private _authResolve: (() => void) | null = null;
  private _authReject: ((err: Error) => void) | null = null;
  // F-004: waiter queue replaces the 50ms poll-loop for concurrent callers
  private _waiters: Waiter[] = [];
  /** Timestamp of the last successful command round-trip (isRunning fast path). */
  lastSuccessTime = 0;

  constructor(host: string, port: number, password: string) {
    this.host = host;
    this.port = port;
    this.password = password;
  }

  private _cleanup(): void {
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

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this._auth && this._socket && !this._socket.destroyed) {
        resolve();
        return;
      }

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
      const socket = new net.Socket();
      this._socket = socket;
      socket.setKeepAlive(true, 30_000);

      const authTimeout = setTimeout(() => {
        this._cleanup();
        reject(new Error("RCON auth timeout"));
      }, 10_000);

      socket.connect(this.port, this.host, () => {
        socket.write(encodePkt(1, 3, this.password));
      });

      socket.on("data", (data) => {
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
              this._authResolve?.();
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

      socket.on("error", () => this._cleanup());
      socket.on("close", () => this._cleanup());
    });
  }

  async send(command: string, timeoutMs = 5_000): Promise<string> {
    await this.connect();
    const id = this._cmdId++;
    if (this._cmdId > 2e9) this._cmdId = 10;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error("RCON timeout"));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      this._socket?.write(encodePkt(id, 2, command));
    });
  }
}
