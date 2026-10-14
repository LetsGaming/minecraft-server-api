/**
 * Reading files the instance user owns (W-007).
 *
 * The wrapper runs as `apiuser`; the server, its mods and the suite's
 * scripts run as the instance user and own the files the wrapper reads
 * back: logs, prune tiles and maps, config files, backups. Code running as
 * that user can replace any of them with a symlink to something only
 * `apiuser` may read (the wrapper's own config, with the API key and every
 * RCON password) between our check and our read.
 *
 * So every open here refuses a symlink in the last component (O_NOFOLLOW)
 * and everything after it — size, type, contents — comes from the opened
 * descriptor, never from a second lookup of the path. Callers check the
 * directories on the way for links that leave where they should be.
 */
import { constants } from "fs";
import fsp, { type FileHandle } from "fs/promises";
import path from "path";

/** True when `real` is `base` or below it. Both must already be realpaths. */
export function isInside(real: string, base: string): boolean {
  return real === base || real.startsWith(base + path.sep);
}

/** The file is larger than the caller allows. */
export class FileTooLargeError extends Error {
  constructor(readonly size: number) {
    super(`file is too large (${size} bytes)`);
    this.name = "FileTooLargeError";
  }
}

/** Open a regular file for reading without following a final symlink. */
export async function openNoFollow(file: string): Promise<FileHandle> {
  const fh = await fsp.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await fh.stat()).isFile()) throw new Error(`not a regular file: ${file}`);
    return fh;
  } catch (err) {
    await fh.close();
    throw err;
  }
}

/** Read a whole regular file, refusing a symlink and anything over `maxBytes`. */
export async function readFileNoFollow(file: string, maxBytes: number): Promise<Buffer> {
  const fh = await openNoFollow(file);
  try {
    const { size } = await fh.stat();
    if (size > maxBytes) throw new FileTooLargeError(size);
    return await fh.readFile();
  } finally {
    await fh.close();
  }
}

/**
 * The last `lines` lines of a text file, reading at most `maxBytes` from its
 * end. Refuses a symlink like every other read here.
 */
export async function tailNoFollow(
  file: string,
  lines: number,
  maxBytes: number,
): Promise<string> {
  const fh = await openNoFollow(file);
  try {
    const { size } = await fh.stat();
    const length = Math.min(size, maxBytes);
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, size - length);
    let text = buf.toString("utf-8");
    // A read that started mid-file starts mid-line; drop that partial line.
    if (length < size) text = text.slice(text.indexOf("\n") + 1);
    const all = text.split("\n");
    if (all[all.length - 1] === "") all.pop();
    const kept = all.slice(-lines);
    return kept.length > 0 ? `${kept.join("\n")}\n` : "";
  } finally {
    await fh.close();
  }
}
