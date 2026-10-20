/**
 * Path matching for the routes exempt from auth and the throttles. The match
 * is on the pathname only, so `/health?probe=1` is exempt like `/health`,
 * while `/health/x` and `/healthz` are not.
 */
function pathnameOf(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

export function isPublicPath(url: string): boolean {
  return pathnameOf(url) === "/health";
}

export function isUnthrottledPath(url: string): boolean {
  const path = pathnameOf(url);
  return path === "/health" || path === "/metrics";
}
