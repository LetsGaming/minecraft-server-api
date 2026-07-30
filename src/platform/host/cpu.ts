/**
 * CPU and memory sampling from /proc.
 *
 * /proc is read directly rather than shelling out to top/free: no child
 * process, no locale-dependent output to parse, and it is the same source
 * those tools read. Every parser here is pure and takes file content, so the
 * formats can be tested without a Linux host.
 */
import fs from "fs/promises";

export const CPU_SAMPLE_MS = 250;

/** USER_HZ. Constant at 100 on every Linux target this runs on. */
export const CLOCK_TICKS_PER_SEC = 100;

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function readProc(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf-8");
  } catch {
    return null; // non-Linux, or the process exited between samples
  }
}

// ── Whole-machine CPU and memory ─────────────────────────────────────────

export interface CpuTotals {
  idle: number;
  total: number;
}

/** First line of /proc/stat: aggregate jiffies across all cores. */
export function parseProcStat(content: string): CpuTotals | null {
  const line = content.split("\n").find((l) => l.startsWith("cpu "));
  if (!line) return null;
  const fields = line.trim().split(/\s+/).slice(1).map(Number);
  if (fields.length < 5 || fields.some((n) => !Number.isFinite(n))) return null;
  // user nice system idle iowait irq softirq steal …
  // iowait counts as idle: the CPU is not doing work during it.
  const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
  const total = fields.reduce((sum, n) => sum + n, 0);
  return { idle, total };
}

/** MemTotal / MemAvailable in bytes, from /proc/meminfo. */
export function parseMemInfo(
  content: string,
): { totalBytes: number; availableBytes: number } | null {
  const read = (key: string): number | null => {
    const match = new RegExp(`^${key}:\\s+(\\d+) kB$`, "m").exec(content);
    return match ? Number(match[1]) * 1024 : null;
  };
  const totalBytes = read("MemTotal");
  const availableBytes = read("MemAvailable");
  if (totalBytes === null || availableBytes === null) return null;
  return { totalBytes, availableBytes };
}

/** Utilisation between two /proc/stat samples, as a 0–100 percentage. */
export function cpuPercentBetween(a: CpuTotals, b: CpuTotals): number {
  const totalDelta = b.total - a.total;
  const idleDelta = b.idle - a.idle;
  if (totalDelta <= 0) return 0;
  const busy = ((totalDelta - idleDelta) / totalDelta) * 100;
  return Math.min(100, Math.max(0, Number(busy.toFixed(1))));
}

// ── Per-process CPU ──────────────────────────────────────────────────────

/** utime + stime from /proc/<pid>/stat, in jiffies. */
export function parsePidCpuJiffies(content: string): number | null {
  // The comm field is parenthesised and may contain spaces or brackets, so
  // split after the last ')' rather than on whitespace from the start.
  const close = content.lastIndexOf(")");
  if (close === -1) return null;
  const fields = content.slice(close + 1).trim().split(/\s+/);
  // fields[0] is state; utime/stime are man-page fields 14/15, i.e. 11/12 here.
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return utime + stime;
}

/**
 * CPU share over CPU_SAMPLE_MS, normalised the way `top` reports it: a
 * process saturating two cores reads 200%.
 */
export async function sampleProcessCpu(pid: number): Promise<number | null> {
  const first = await readProc(`/proc/${pid}/stat`);
  const a = first ? parsePidCpuJiffies(first) : null;
  if (a === null) return null;

  await sleep(CPU_SAMPLE_MS);

  const second = await readProc(`/proc/${pid}/stat`);
  const b = second ? parsePidCpuJiffies(second) : null;
  if (b === null) return null;

  const seconds = CPU_SAMPLE_MS / 1000;
  const percent = ((b - a) / CLOCK_TICKS_PER_SEC / seconds) * 100;
  return Math.max(0, Number(percent.toFixed(1)));
}
