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
