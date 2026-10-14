// Packs the built wrapper into the release tarball the setup suite installs
// (minecraft-server-setup: src/setup/management/install_api_server.js).
//
//   npm run build && node scripts/pack-release.mjs [--expect-version <v>]
//
// Writes to release/:
//   mc-api-server-<v>.tar.gz         mc-api-server-<v>/{dist/, index.js, package.json, lockfile, ...}
//   mc-api-server-<v>.tar.gz.sha256  "<sha256>  mc-api-server-<v>.tar.gz"
//   notes.md                         this version's CHANGELOG.md section
//
// The tarball holds what a host runs and nothing it builds from: no src/, no
// tests, no dev tooling. The host runs `npm ci --omit=dev` against the lockfile.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "release");
const SHIPPED = [
  "dist",
  "index.js",
  "package.json",
  "package-lock.json",
  "openapi.json",
  "ecosystem.config.cjs",
  "api-server-config.example.json",
  "variables.example.txt",
  ".env.example",
  "README.md",
  "CHANGELOG.md",
];

function fail(message) {
  console.error(`pack-release: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const expectIdx = args.indexOf("--expect-version");
const expected = expectIdx >= 0 ? args[expectIdx + 1] : null;

const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
if (expected !== null && expected !== version) {
  fail(`the tag says ${expected} but package.json says ${version}; bump package.json first.`);
}
if (!fs.existsSync(path.join(ROOT, "dist", "index.js"))) fail("dist/index.js is missing; run npm run build first.");

/** The "## [<version>] - <date>" section of CHANGELOG.md, without its heading. */
function changelogSection(v) {
  const lines = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8").split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## [${v}]`));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## ["));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
}
const notes = changelogSection(version);
if (!notes) fail(`CHANGELOG.md has no "## [${version}]" section.`);

const name = `mc-api-server-${version}`;
const stage = path.join(OUT, name);
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
for (const entry of SHIPPED) {
  const from = path.join(ROOT, entry);
  if (!fs.existsSync(from)) fail(`${entry} is missing.`);
  fs.cpSync(from, path.join(stage, entry), { recursive: true });
}

const tarball = path.join(OUT, `${name}.tar.gz`);
// Fixed owner and mode bits, so the archive does not carry the builder's uid.
execFileSync("tar", ["-czf", tarball, "--owner=0", "--group=0", "--numeric-owner", "-C", OUT, name], { stdio: "inherit" });
fs.rmSync(stage, { recursive: true, force: true });

const sha = createHash("sha256").update(fs.readFileSync(tarball)).digest("hex");
fs.writeFileSync(`${tarball}.sha256`, `${sha}  ${name}.tar.gz\n`);
fs.writeFileSync(path.join(OUT, "notes.md"), notes + "\n");

console.log(`version=${version}`);
console.log(`tarball=${tarball}`);
console.log(`sha256=${sha}`);
