/**
 * Bounded-concurrency `Promise.all`. libuv's threadpool is 4 threads by
 * default, and every `fs/promises` call queues into it — an unbounded
 * `Promise.all` over hundreds of files starves everything else on the
 * process (including `/health`'s own filesystem read) until it drains.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * A promise-chain lock: tasks passed to `run` execute one at a time, in call
 * order. A task that rejects releases the lock for the next one and still
 * rejects its own caller.
 */
export function createMutex(): { run<T>(task: () => Promise<T>): Promise<T> } {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const result = tail.then(task);
      tail = result.catch(() => undefined);
      return result;
    },
  };
}
