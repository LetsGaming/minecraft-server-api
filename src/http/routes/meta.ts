/**
 * Routes that describe the wrapper itself rather than serve an instance.
 *
 * The two are registered at different points in app.ts and that ordering is
 * load-bearing: /health must precede the auth hook to stay public, and
 * /manifest must follow every other registration so the route census it
 * reports is complete.
 */
import type { FastifyInstance } from "fastify";

import { buildManifest } from "../../contracts/manifest.js";
import { WRAPPER_VERSION } from "../../contracts/version.js";

/** Public. Registered before the auth hook. */
export function registerHealthRoute(app: FastifyInstance): void {
  app.get("/health", async () => ({ ok: true, version: WRAPPER_VERSION }));
}

/** Authenticated: a route census is reconnaissance. Registered last. */
export function registerManifestRoute(
  app: FastifyInstance,
  routes: readonly string[],
): void {
  app.get("/manifest", async () => buildManifest(routes));
}
