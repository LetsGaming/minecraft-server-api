/**
 * Telling which of a user's processes is one instance's server.
 *
 * Several instances can run as the same Linux user, so "the biggest java
 * process of the user" names the wrong server as soon as two of them exist.
 * The working directory is what identifies the instance, but /proc/<pid>/cwd
 * is only readable by the process's own user (or root); the wrapper usually
 * runs as someone else, so it falls back on where the process sits in the
 * process tree: below the screen session named after the instance, or below
 * the instance's systemd main process. These helpers are pure and work on
 * `ps` output so they can be tested without a Linux host.
 */
import path from "path";

export interface PsRow {
  pid: number;
  ppid: number;
  rssKb: number;
  args: string;
}

/** Rows of `ps -o pid=,ppid=,rss=,args=`; lines that do not fit are skipped. */
export function parsePsRows(stdout: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), rssKb: Number(m[3]), args: m[4]! });
  }
  return rows;
}

export function isJavaRow(row: PsRow): boolean {
  const program = row.args.split(/\s+/)[0] ?? "";
  return path.posix.basename(program).toLowerCase().includes("java");
}

/** Is `pid` below `ancestor` in the process tree (or `ancestor` itself)? */
export function isDescendantOf(rows: readonly PsRow[], pid: number, ancestor: number): boolean {
  const parentOf = new Map(rows.map((r) => [r.pid, r.ppid]));
  const seen = new Set<number>();
  for (let cur: number | undefined = pid; cur !== undefined && !seen.has(cur); cur = parentOf.get(cur)) {
    if (cur === ancestor) return true;
    seen.add(cur);
  }
  return false;
}

/** The screen processes started with `-S <instanceId>` (the suite names a session after its instance). */
export function screenAnchors(rows: readonly PsRow[], instanceId: string): number[] {
  const escaped = instanceId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const named = new RegExp(`(?:^|\\s)-[A-Za-z]*S\\s+(?:\\d+\\.)?${escaped}(?:\\s|$)`);
  return rows
    .filter((r) => /(?:^|\/)screen\b/i.test(r.args.split(/\s+/)[0] ?? "") && named.test(r.args))
    .map((r) => r.pid);
}

/** Pick the process belonging to the instance, or null when none can be tied to it. */
export function pickServerProcess(
  rows: readonly PsRow[],
  matchedByCwd: readonly PsRow[],
  unresolved: readonly PsRow[],
  anchors: readonly number[],
): PsRow | null {
  const matched = [...matchedByCwd];
  if (matched.length === 0) {
    for (const row of unresolved) {
      if (anchors.some((a) => isDescendantOf(rows, row.pid, a))) matched.push(row);
    }
  }
  let best: PsRow | null = null;
  for (const row of matched) if (best === null || row.rssKb > best.rssKb) best = row;
  return best;
}
