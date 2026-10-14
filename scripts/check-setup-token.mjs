#!/usr/bin/env node
// Checks the SETUP_REPO_TOKEN secret before something depends on it.
//
//   GH_TOKEN=<token> node scripts/check-setup-token.mjs [--repo owner/name] [--warn-days 30] [--fail-days 0]
//
// The release workflow uses the token to open the pin bump in
// minecraft-server-setup. It is a fine-grained token, and those expire: the
// longest lifetime allowed is one year, so a token without an expiry date, or
// with one further out than that, is not one we issued and fails here too. An
// expired token would only show up as a failed release, after the tag is
// already published, so this runs before that step and on a weekly schedule
// (.github/workflows/setup-token.yml).
//
// It fails (exit 1, ::error) when the token is missing, rejected (401: expired,
// revoked or mistyped), cannot see the repository (404), belongs to an account
// without write access to it, has no expiry or one more than a year out, or
// expires within --fail-days. It warns (::warning, exit 0) within --warn-days.
//
// GitHub reports a token's expiry in the GitHub-Authentication-Token-Expiration
// response header, e.g. "2027-10-14 13:00:00 UTC" or "2027-10-14 13:00:00 +0200".

const MAX_LIFETIME_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseArgs(argv) {
  const opts = {
    repo: process.env.SETUP_REPO || "LetsGaming/minecraft-server-setup",
    warnDays: 30,
    failDays: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--repo") opts.repo = value;
    else if (arg === "--warn-days") opts.warnDays = Number(value);
    else if (arg === "--fail-days") opts.failDays = Number(value);
    else throw new Error(`unknown argument: ${arg}`);
    i++;
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) throw new Error(`--repo must be owner/name, got ${opts.repo}`);
  for (const key of ["warnDays", "failDays"]) {
    if (!Number.isFinite(opts[key]) || opts[key] < 0) throw new Error(`--${key === "warnDays" ? "warn" : "fail"}-days must be a number >= 0`);
  }
  return opts;
}

/** "2027-10-14 13:00:00 UTC" / "2027-10-14 13:00:00 +0200" -> Date, or null. */
export function parseExpiration(header) {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (UTC|[+-]\d{4})$/.exec(String(header ?? "").trim());
  if (!m) return null;
  const zone = m[3] === "UTC" ? "Z" : `${m[3].slice(0, 3)}:${m[3].slice(3)}`;
  const date = new Date(`${m[1]}T${m[2]}${zone}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function fail(message) {
  console.log(`::error title=SETUP_REPO_TOKEN::${message}`);
  process.exitCode = 1;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const token = process.env.GH_TOKEN;
  const renew = `Create a new fine-grained token (Contents and Pull requests: read and write, only ${opts.repo}, expiry at most one year) and replace the SETUP_REPO_TOKEN secret.`;

  if (!token) return fail(`The secret is not set. ${renew}`);

  const res = await fetch(`https://api.github.com/repos/${opts.repo}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "mc-api-server-token-check",
    },
  });

  if (res.status === 401) return fail(`GitHub rejects the token (401): it has expired, was revoked or is mistyped. ${renew}`);
  if (res.status === 404) return fail(`The token cannot see ${opts.repo} (404). Give it access to that repository. ${renew}`);
  if (!res.ok) return fail(`GitHub answered ${res.status} ${res.statusText} for ${opts.repo}.`);

  const repo = await res.json();
  // For a fine-grained token this is the owning account's role; the token's
  // own grants are only exercised when the release pushes.
  if (repo.permissions && repo.permissions.push !== true) {
    return fail(`The token's account cannot push to ${opts.repo}. ${renew}`);
  }

  const header = res.headers.get("github-authentication-token-expiration");
  if (!header) return fail(`The token has no expiry date. Tokens for this secret expire within one year. ${renew}`);
  const expires = parseExpiration(header);
  if (!expires) return fail(`Unreadable expiry date from GitHub: "${header}".`);

  const daysLeft = (expires.getTime() - Date.now()) / DAY_MS;
  const when = `${expires.toISOString().slice(0, 10)} (${Math.floor(daysLeft)} days)`;
  if (daysLeft > MAX_LIFETIME_DAYS) return fail(`The token expires ${when}, more than one year out, which this secret does not allow. ${renew}`);
  if (daysLeft <= 0) return fail(`The token expired on ${expires.toISOString().slice(0, 10)}. ${renew}`);
  if (daysLeft <= opts.failDays) return fail(`The token expires ${when}. ${renew}`);
  if (daysLeft <= opts.warnDays) {
    console.log(`::warning title=SETUP_REPO_TOKEN::The token expires ${when}. ${renew}`);
    return;
  }
  console.log(`SETUP_REPO_TOKEN can reach ${opts.repo} and expires ${when}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    fail(err instanceof Error ? err.message : String(err));
  });
}
