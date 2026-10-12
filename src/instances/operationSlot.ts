/**
 * The one slot per instance for work that changes the server's files or its
 * running state: stop, restart, rollback, backup, restore, mod writes and the
 * version upgrade.
 *
 * Why: nothing stopped the dashboard from pressing Restore while a backup was
 * still archiving, or Stop in the middle of an upgrade. Each action is safe
 * alone; the overlap is what corrupts a world. This is the in-process half of
 * the exclusion. The setup suite's scripts take the matching file lock
 * (`acquire_operation_lock`), so an SSH run and a wrapper run exclude each
 * other too, and a wrapper restart in the middle of a job does not reopen the
 * slot for a second one.
 */

/** Kinds that may hold the slot more than once at the same time. */
const SHAREABLE: ReadonlySet<string> = new Set(["mods"]);

export interface RunningOperation {
  kind: string;
  /** Set when the holder is a background job a client can poll. */
  jobId?: string;
}

/** Thrown when an action needs the slot and something else holds it. */
export class OperationBusyError extends Error {
  readonly busy: RunningOperation;
  constructor(busy: RunningOperation) {
    super(`Another operation is running: ${busy.kind}`);
    this.busy = busy;
  }
}

export interface OperationSlot {
  /** The holder, or null when the slot is free. */
  current(): RunningOperation | null;
  /** Takes the slot; returns the release function, or null when it is held. */
  begin(kind: string, jobId?: string): (() => void) | null;
  /** Runs `fn` holding the slot; throws OperationBusyError when it is taken. */
  run<T>(kind: string, fn: () => Promise<T>): Promise<T>;
}

export function createOperationSlot(): OperationSlot {
  let holder: (RunningOperation & { count: number }) | null = null;

  function begin(kind: string, jobId?: string): (() => void) | null {
    if (holder) {
      if (holder.kind !== kind || !SHAREABLE.has(kind)) return null;
      holder.count++;
    } else {
      holder = { kind, count: 1, ...(jobId ? { jobId } : {}) };
    }
    const mine = holder;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      mine.count--;
      if (mine.count <= 0 && holder === mine) holder = null;
    };
  }

  return {
    current: () => (holder ? { kind: holder.kind, ...(holder.jobId ? { jobId: holder.jobId } : {}) } : null),
    begin,
    async run(kind, fn) {
      const release = begin(kind);
      if (!release) throw new OperationBusyError(this.current()!);
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}
