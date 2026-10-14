/**
 * Request validation applied at the HTTP boundary, before any value reaches
 * an operation. Console command validation is its own module
 * (consoleCommand.ts) because it carries the transport's byte ceiling.
 */

// F-001: strict UUID allowlist
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// F-001: safe args pattern — no forward-slash to prevent relative-path
// traversal (e.g. "../../evil.sh") in script arguments. Scripts that
// legitimately need a path argument should receive it via instance config.
const SAFE_ARG = /^[\w.@-]{1,128}$/;

/**
 * W-014: the flags each script action may receive. Anything else that starts
 * with `-` is refused, so a client cannot switch a script into a mode its
 * action was not meant to have (`--file`, `--y`). The bot sends `--archive`
 * for an archived backup and nothing else.
 */
const ALLOWED_FLAGS: Readonly<Record<string, readonly string[]>> = {
  backup: ["--archive"],
};

export function validateArgs(args: unknown, action?: string): args is string[] | undefined {
  if (args === undefined || args === null) return true;
  const flags = (action !== undefined && Object.hasOwn(ALLOWED_FLAGS, action) ? ALLOWED_FLAGS[action] : undefined) ?? [];
  return (
    Array.isArray(args) &&
    args.length <= 5 &&
    args.every(
      (a) =>
        typeof a === "string" &&
        SAFE_ARG.test(a) &&
        (!a.startsWith("-") || flags.includes(a)),
    )
  );
}

// F-009: parseInt blocks "1e6" bypass; clamp to [1, 500]
export function sanitizeLines(raw: unknown): number {
  const parsed = parseInt(String(raw ?? "10"), 10);
  return Number.isNaN(parsed) ? 10 : Math.min(Math.max(parsed, 1), 500);
}
