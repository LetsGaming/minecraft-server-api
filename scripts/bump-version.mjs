#!/usr/bin/env node
/**
 * Bump the version everywhere and (optionally) cut a release.
 *
 * Usage:
 *   node scripts/bump-version.mjs <version|major|minor|patch> [flags]
 *   npm run bump-version -- <version|major|minor|patch> [flags]
 *
 * Version argument:
 *   1.2.3              an explicit semver
 *   major|minor|patch  bump that part of the current version
 *
 * Flags:
 *   --dry-run   show what would change; write nothing, tag nothing
 *   --tag       commit the version files and create the git tag v<version>.
 *               Re-running with --tag once the files are already committed
 *               only creates the tag.
 *   --push      push main and the tag. release.yml runs on v* tags, packs the
 *               release and publishes it. Implies --tag.
 *   --retag     the tag already exists (for example a release that failed
 *               before it published): delete it locally and on origin, then
 *               create it again on the new commit. Implies --tag.
 *   --yes       skip the confirmation prompt
 *
 * Updates: package.json, package-lock.json (root entry), the `v=` install line
 * in README.md, CHANGELOG.md (renames [Unreleased] to the new version with
 * today's date and opens a fresh [Unreleased]) and openapi.json (regenerated,
 * it carries the version). Then it dry-runs scripts/pack-release.mjs against
 * the new version, the same check release.yml makes first. The test suite is
 * not run here: release.yml runs it on the tag.
 *
 * Tagging needs a clean tree on main that is not behind origin/main.
 */
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const event of ["uncaughtException", "unhandledRejection"]) {
  process.on(event, (err) => {
    console.error(`\n! ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}

// ── Parse args ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const [bumpArg] = argv.filter((a) => !a.startsWith("--"));

const known = new Set(["--dry-run", "--tag", "--push", "--retag", "--yes"]);
for (const f of flags) {
  if (!known.has(f)) {
    console.error(`Unknown flag ${f}`);
    process.exit(1);
  }
}

const dryRun = flags.has("--dry-run");
const doRetag = flags.has("--retag");
const doPush = flags.has("--push");
const doTag = flags.has("--tag") || doPush || doRetag;
const assumeYes = flags.has("--yes");

if (!bumpArg) {
  console.error(
    "Usage: node scripts/bump-version.mjs <version|major|minor|patch> " +
      "[--dry-run] [--tag] [--push] [--retag] [--yes]",
  );
  process.exit(1);
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
// Windows checkouts may hold CRLF files; keep each file's own line endings.
const eolOf = (text) => (text.includes("\r\n") ? "\r\n" : "\n");
const writeJson = (p, o) => {
  const eol = eolOf(fs.readFileSync(p, "utf8"));
  fs.writeFileSync(p, (JSON.stringify(o, null, 2) + "\n").replace(/\n/g, eol));
};

// ── Resolve the target version ────────────────────────────────────────────
const pkgPath = path.join(root, "package.json");
const pkg = readJson(pkgPath);
const current = pkg.version;

function resolveVersion(cur, arg) {
  if (/^\d+\.\d+\.\d+$/.test(arg)) return arg;
  const m = cur.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) throw new Error(`Current version "${cur}" is not x.y.z`);
  let [maj, min, pat] = m.slice(1).map(Number);
  if (arg === "major") [maj, min, pat] = [maj + 1, 0, 0];
  else if (arg === "minor") [min, pat] = [min + 1, 0];
  else if (arg === "patch") pat += 1;
  else throw new Error(`Invalid bump "${arg}": use major|minor|patch or X.Y.Z`);
  return `${maj}.${min}.${pat}`;
}

let version;
try {
  version = resolveVersion(current, bumpArg);
} catch (err) {
  console.error(`! ${err.message}`);
  process.exit(1);
}
const tag = `v${version}`;

// ── Collect the edits (compute first, write once) ─────────────────────────
const edits = [];

if (pkg.version !== version) {
  edits.push({ rel: "package.json", write: () => writeJson(pkgPath, { ...pkg, version }) });
}

const lockPath = path.join(root, "package-lock.json");
if (fs.existsSync(lockPath)) {
  const lock = readJson(lockPath);
  const rootEntry = lock.packages?.[""];
  if (lock.version !== version || (rootEntry && rootEntry.version !== version)) {
    lock.version = version;
    if (rootEntry) rootEntry.version = version;
    edits.push({ rel: "package-lock.json", write: () => writeJson(lockPath, lock) });
  }
}

const readmePath = path.join(root, "README.md");
if (fs.existsSync(readmePath)) {
  const readme = fs.readFileSync(readmePath, "utf8");
  const found = readme.match(/^v=(\d+\.\d+\.\d+)\s*$/m);
  if (!found) {
    console.warn("! README.md has no 'v=x.y.z' install line, skipping it.");
  } else if (found[1] !== version) {
    edits.push({
      rel: "README.md",
      write: () => fs.writeFileSync(readmePath, readme.replace(/^v=\d+\.\d+\.\d+/m, `v=${version}`)),
    });
  }
}

const clPath = path.join(root, "CHANGELOG.md");
if (fs.existsSync(clPath)) {
  const cl = fs.readFileSync(clPath, "utf8");
  const today = new Date().toISOString().slice(0, 10);

  if (cl.includes(`## [${version}]`)) {
    // already released in the changelog: leave it
  } else if (/^## \[Unreleased\]\s*$/m.test(cl)) {
    const header = cl.match(/^## \[Unreleased\]\s*$/m);
    const afterUnreleased = header.index + header[0].length;
    const next = cl.slice(afterUnreleased).match(/\n##\s+\[/);
    const bodyEnd = next ? afterUnreleased + next.index : cl.length;
    if (cl.slice(afterUnreleased, bodyEnd).trim() === "") {
      console.error("! The [Unreleased] section of CHANGELOG.md is empty: there would be no release notes.");
      process.exit(1);
    }
    const eol = eolOf(cl);
    const updated =
      cl.slice(0, header.index) +
      `## [Unreleased]${eol}${eol}## [${version}] - ${today}${eol}` +
      cl.slice(afterUnreleased);
    edits.push({ rel: "CHANGELOG.md", write: () => fs.writeFileSync(clPath, updated) });
  } else {
    console.error(`! CHANGELOG.md has no [Unreleased] section and no [${version}] section: release.yml needs one.`);
    process.exit(1);
  }
}

// openapi.json carries the version and is generated, so it is not computed here.
const regenerateOpenApi = current !== version || edits.length > 0;

// ── Report ────────────────────────────────────────────────────────────────
console.log(`\nBump ${current} → ${version}${dryRun ? "  (dry run)" : ""}\n`);
if (edits.length === 0) {
  console.log("Everything is already at this version.");
} else {
  for (const e of edits) console.log(`  ${dryRun ? "would update" : "update"}  ${e.rel}`);
}
if (regenerateOpenApi) console.log(`  ${dryRun ? "would regenerate" : "regenerate"}  openapi.json`);
console.log(`  ${dryRun ? "would check" : "check"}  scripts/pack-release.mjs --expect-version ${version}`);
if (doTag) {
  console.log(
    `  ${dryRun ? "would tag" : "tag"}       ${tag}${doRetag ? "  (replacing an existing tag)" : ""}${doPush ? "  (+ push)" : ""}`,
  );
}

const git = (...a) => {
  try {
    return execFileSync("git", a, { cwd: root, stdio: "pipe" }).toString().trimEnd();
  } catch (err) {
    const detail = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
    throw new Error(`git ${a.join(" ")} failed:${detail ? `\n${detail}` : ` exit ${err.status}`}`);
  }
};

// A command string, not an argument array: npm is npm.cmd on Windows, which
// only runs through a shell. The arguments are fixed strings, never user input.
const npm = (...a) => execSync(`npm ${a.join(" ")}`, { cwd: root, stdio: "inherit" });

// ── Tag preconditions ─────────────────────────────────────────────────────
let localTag = false;
let remoteTag = false;
if (doTag) {
  try {
    const branch = git("rev-parse", "--abbrev-ref", "HEAD");
    if (branch !== "main") {
      console.error(`\n! On branch ${branch}: release.yml refuses a tag that is not on main.`);
      process.exit(1);
    }
    git("fetch", "--quiet", "origin", "main", "--tags");
    try {
      git("merge-base", "--is-ancestor", "origin/main", "HEAD");
    } catch {
      console.error("\n! main is behind origin/main. Pull first.");
      process.exit(1);
    }

    localTag = git("tag", "--list", tag) !== "";
    remoteTag = git("ls-remote", "--tags", "origin", `refs/tags/${tag}`) !== "";
    if ((localTag || remoteTag) && !doRetag) {
      console.error(
        `\n! Tag ${tag} already exists${remoteTag ? " on origin" : ""}. Pass --retag to replace it, or pick another version.`,
      );
      process.exit(1);
    }

    const dirty = git("status", "--porcelain")
      .split("\n")
      .map((l) => l.slice(3))
      .filter(Boolean)
      .filter((f) => !edits.some((e) => e.rel === f) && f !== "openapi.json");
    if (dirty.length > 0) {
      console.error(
        "\n! Uncommitted changes other than the version files:\n" +
          dirty.map((f) => `    ${f}`).join("\n") +
          "\n  Commit or stash them first so the release tag is clean.",
      );
      process.exit(1);
    }
  } catch (err) {
    console.error(`\n! Cannot prepare the tag: ${err.message}`);
    process.exit(1);
  }
}

if (dryRun) process.exit(0);

// ── Confirm ───────────────────────────────────────────────────────────────
async function confirm() {
  if (assumeYes || (edits.length === 0 && !doTag)) return true;
  if (!process.stdin.isTTY) {
    console.error("\n! Not a terminal: pass --yes to proceed without asking.");
    process.exit(1);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((res) => rl.question("\nProceed? [y/N] ", res));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

if (!(await confirm())) {
  console.log("Aborted.");
  process.exit(1);
}

// ── Apply ─────────────────────────────────────────────────────────────────
const touched = [...edits.map((e) => e.rel), "openapi.json"];
try {
  for (const e of edits) {
    e.write();
    console.log(`  updated ${e.rel}`);
  }
  // Also rebuilds dist/, which pack-release.mjs needs to be fresh.
  if (regenerateOpenApi) npm("run", "openapi:generate");
  execFileSync("node", ["scripts/pack-release.mjs", "--expect-version", version], {
    cwd: root,
    stdio: "inherit",
  });
} catch (err) {
  console.error(`\n! ${err.message}`);
  if (doTag) {
    // The tree was clean apart from these files (checked above), so this loses nothing.
    git("checkout", "--", ...touched.filter((f) => fs.existsSync(path.join(root, f))));
    console.error("  Restored the version files.");
  }
  process.exit(1);
}

if (!doTag) {
  console.log(
    `\nDone. ${edits.length > 0 ? "Commit these, then release with:" : "Release with:"}\n` +
      `  node scripts/bump-version.mjs ${version} --tag --push`,
  );
  process.exit(0);
}

// ── Commit + tag (+ push) ─────────────────────────────────────────────────
const changed = git("status", "--porcelain", "--", ...touched)
  .split("\n")
  .map((l) => l.slice(3))
  .filter(Boolean);
if (changed.length > 0) {
  git("add", ...changed);
  git("commit", "-m", `chore: release ${version}`);
  console.log(`\n  committed ${changed.length} version file(s)`);
}
if (localTag) git("tag", "-d", tag);
git("tag", tag);
console.log(`  tagged ${tag}`);

if (doPush) {
  // main first: release.yml refuses a tag whose commit is not on origin/main.
  execFileSync("git", ["push", "origin", "main"], { cwd: root, stdio: "inherit" });
  if (remoteTag) execFileSync("git", ["push", "origin", `:refs/tags/${tag}`], { cwd: root, stdio: "inherit" });
  execFileSync("git", ["push", "origin", tag], { cwd: root, stdio: "inherit" });
  console.log(`  pushed main + ${tag}. release.yml will build the release.`);
} else {
  console.log(
    `  push it to trigger the release:\n    git push origin main${remoteTag ? `\n    git push origin :refs/tags/${tag}` : ""}\n    git push origin ${tag}`,
  );
}
