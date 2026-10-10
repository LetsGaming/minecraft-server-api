/**
 * Writes (or with --check, verifies) openapi.json at the package root.
 *
 *   npm run openapi:generate   rebuild and rewrite the file
 *   npm run openapi:check      fail when the committed file is stale
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { buildApp } from "../http/app.js";
import { REPO_ROOT } from "../platform/paths.js";
import { buildOpenApi } from "./openapi.js";
import { WRAPPER_VERSION } from "./version.js";

export const OPENAPI_PATH = path.join(REPO_ROOT, "openapi.json");

/** The document for this checkout's router, as it is committed. */
export async function renderOpenApi(): Promise<string> {
  const { app, logStreamAPI, routeSpecs } = await buildApp({
    config: { PORT: 0, API_KEY: "openapi-generation", instances: {} },
    allowNoAuth: false,
  });
  try {
    await app.ready();
    return `${JSON.stringify(buildOpenApi(routeSpecs, WRAPPER_VERSION), null, 2)}\n`;
  } finally {
    logStreamAPI.dispose();
    await app.close();
  }
}

async function main(): Promise<void> {
  const rendered = await renderOpenApi();
  if (process.argv.includes("--check")) {
    const committed = fs.existsSync(OPENAPI_PATH)
      ? fs.readFileSync(OPENAPI_PATH, "utf-8").replace(/\r\n/g, "\n")
      : "";
    if (committed !== rendered) {
      process.stderr.write(
        "openapi.json is out of date. Run `npm run openapi:generate`.\n",
      );
      process.exit(1);
    }
    process.stdout.write("openapi.json is up to date.\n");
    return;
  }
  fs.writeFileSync(OPENAPI_PATH, rendered);
  process.stdout.write(`Wrote ${OPENAPI_PATH}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
