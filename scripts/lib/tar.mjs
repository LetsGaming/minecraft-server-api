// A small ustar writer, so the release tarball is built the same way on Linux,
// macOS and Windows without depending on which `tar` the machine has (GNU tar,
// bsdtar and the Windows one disagree about ownership flags). Output is
// deterministic: sorted entries, uid/gid 0, fixed mtime, no gzip timestamp.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const BLOCK = 512;

function octal(value, width) {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

function putString(buf, offset, width, text) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > width) throw new Error(`tar field too long: ${text}`);
  bytes.copy(buf, offset);
}

/** Split a path that does not fit the 100-byte name field into ustar prefix and name. */
function splitName(name) {
  if (Buffer.byteLength(name) <= 100) return { prefix: "", name };
  const slashes = [];
  for (let i = 0; i < name.length; i++) if (name[i] === "/") slashes.push(i);
  for (const at of slashes) {
    const prefix = name.slice(0, at);
    const rest = name.slice(at + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100) return { prefix, name: rest };
  }
  throw new Error(`path too long for a tar entry: ${name}`);
}

function header({ name, size, mode, mtime, type }) {
  const buf = Buffer.alloc(BLOCK);
  const split = splitName(name);
  putString(buf, 0, 100, split.name);
  putString(buf, 100, 8, octal(mode, 8));
  putString(buf, 108, 8, octal(0, 8));
  putString(buf, 116, 8, octal(0, 8));
  putString(buf, 124, 12, octal(size, 12));
  putString(buf, 136, 12, octal(mtime, 12));
  buf.fill(0x20, 148, 156);
  buf[156] = type.charCodeAt(0);
  putString(buf, 257, 6, "ustar\0");
  putString(buf, 263, 2, "00");
  putString(buf, 345, 155, split.prefix);
  let sum = 0;
  for (const byte of buf) sum += byte;
  putString(buf, 148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
  return buf;
}

/** Every file and directory below `dir`, as paths relative to it, parents first, sorted. */
function walk(dir, rel = "") {
  const out = [];
  const entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`refusing to pack a symbolic link: ${child}`);
    if (entry.isDirectory()) {
      out.push({ rel: child, dir: true });
      out.push(...walk(dir, child));
    } else if (entry.isFile()) {
      out.push({ rel: child, dir: false });
    }
  }
  return out;
}

/**
 * Pack `<parent>/<name>` into a gzip-compressed tar whose single top-level
 * directory is `name`. Files are owned by root and 0644 (0755 for directories
 * and for files that were executable); mtimes are `mtimeSeconds`.
 */
export function createTarGz({ parent, name, outFile, mtimeSeconds }) {
  const root = path.join(parent, name);
  const chunks = [header({ name: `${name}/`, size: 0, mode: 0o755, mtime: mtimeSeconds, type: "5" })];
  for (const entry of walk(root)) {
    const full = path.join(root, ...entry.rel.split("/"));
    if (entry.dir) {
      chunks.push(header({ name: `${name}/${entry.rel}/`, size: 0, mode: 0o755, mtime: mtimeSeconds, type: "5" }));
      continue;
    }
    const data = fs.readFileSync(full);
    const executable = (fs.statSync(full).mode & 0o111) !== 0;
    chunks.push(
      header({
        name: `${name}/${entry.rel}`,
        size: data.length,
        mode: executable ? 0o755 : 0o644,
        mtime: mtimeSeconds,
        type: "0",
      }),
      data,
      Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK),
    );
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  fs.writeFileSync(outFile, zlib.gzipSync(Buffer.concat(chunks), { level: 9 }));
}
