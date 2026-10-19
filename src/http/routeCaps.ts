/**
 * Concurrency caps for routes that cost more than their rate-limit price:
 * the GET routes that spawn a script, and the archive downloads that hold a
 * file open for minutes. Without them one key holder can use the whole
 * read budget and every in-flight slot on a handful of slow requests.
 */
import type { FastifyReply } from "fastify";

/** A counted set of slots; entering never waits. */
export class ConcurrencyCap {
  private active = 0;

  constructor(readonly max: number) {}

  /** A function that gives the slot back (once), or null when the cap is reached. */
  tryEnter(): (() => void) | null {
    if (this.active >= this.max) return null;
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
    };
  }
}

/** One cap per key (an instance id), created on first use. */
export function capsPerKey(max: number): (key: string) => ConcurrencyCap {
  const caps = new Map<string, ConcurrencyCap>();
  return (key) => {
    let cap = caps.get(key);
    if (!cap) {
      cap = new ConcurrencyCap(max);
      caps.set(key, cap);
    }
    return cap;
  };
}

/** Spawning GET routes allowed at once per instance (a tile page asks for several). */
const SPAWN_READS_PER_INSTANCE = 6;
/** Archive downloads allowed at once per instance. */
const DOWNLOADS_PER_INSTANCE = 2;

const spawnReadCap = capsPerKey(SPAWN_READS_PER_INSTANCE);
const downloadCap = capsPerKey(DOWNLOADS_PER_INSTANCE);

function tooMany(reply: FastifyReply): FastifyReply {
  void reply.header("Retry-After", "1");
  return reply.status(429).send({ error: "Too many concurrent requests for this instance" });
}

/** Run a script-spawning GET handler body under the instance's cap, or answer 429. */
export async function withSpawnReadCap<T>(
  instanceId: string,
  reply: FastifyReply,
  run: () => Promise<T>,
): Promise<T | FastifyReply> {
  const release = spawnReadCap(instanceId).tryEnter();
  if (!release) return tooMany(reply);
  try {
    return await run();
  } finally {
    release();
  }
}

/** Take a download slot, or answer 429 and return null. The caller releases it. */
export function enterDownload(instanceId: string, reply: FastifyReply): (() => void) | null {
  const release = downloadCap(instanceId).tryEnter();
  if (!release) {
    tooMany(reply);
    return null;
  }
  return release;
}
