/**
 * The feature manifest, and the checks that keep it honest.
 *
 * The manifest only has value if it cannot lie, so most of this file is
 * about that rather than about the endpoint: routes come from the real
 * router, every feature must be served by routes that exist, every route
 * must belong to a feature, and openapi.yaml must agree with all of it.
 *
 * That last one is the reason the manifest is generated instead of being
 * openapi.yaml itself: the 2.x spec described four routes that never
 * existed and omitted half the real ones. Now the spec is checked against
 * the router rather than trusted.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { buildApp } from "../src/app.js";
import { FEATURES, META_ROUTES, MANIFEST_VERSION } from "../src/manifest.js";
import { SCRIPT_MAP } from "../src/operations.js";
import { WRAPPER_VERSION } from "../src/version.js";
import type { AppConfig } from "../src/types.js";
import type { FastifyInstance } from "fastify";

const KEY = "test-key-0123456789";

let root: string;
let app: FastifyInstance;
let dispose: () => void;

interface ManifestBody {
  wrapper: string;
  manifest: number;
  routes: string[];
  features: Record<string, { version: number; summary: string }>;
  scriptActions: string[];
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-"));
  const serverPath = path.join(root, "server");
  fs.mkdirSync(path.join(serverPath, "logs"), { recursive: true });

  const config: AppConfig = {
    API_KEY: KEY,
    API_SERVER_PORT: 8125,
    API_SERVER_HOST: "127.0.0.1",
    instances: {
      smp: {
        id: "smp",
        serverPath,
        scriptsDir: path.join(root, "scripts"),
        backupsPath: path.join(root, "backups"),
        linuxUser: "mc",
        screenSession: "smp",
        rconHost: "127.0.0.1",
        rconPort: 25575,
        rconPassword: "pw",
      },
    },
  } as unknown as AppConfig;

  const built = await buildApp({ config, allowNoAuth: false });
  app = built.app;
  dispose = () => built.logStreamAPI.dispose();
  await app.ready();
});

afterAll(async () => {
  dispose();
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function getManifest(): Promise<ManifestBody> {
  const res = await app.inject({
    method: "GET",
    url: "/manifest",
    headers: { "x-api-key": KEY },
  });
  expect(res.statusCode).toBe(200);
  return res.json<ManifestBody>();
}

describe("GET /manifest", () => {
  it("requires the API key — a route census is reconnaissance", async () => {
    const res = await app.inject({ method: "GET", url: "/manifest" });
    expect(res.statusCode).toBe(401);
  });

  it("reports the wrapper version and the envelope version", async () => {
    const body = await getManifest();
    expect(body.wrapper).toBe(WRAPPER_VERSION);
    expect(body.manifest).toBe(MANIFEST_VERSION);
  });

  it("lists itself — the census sees routes registered after the hook", async () => {
    const body = await getManifest();
    expect(body.routes).toContain("GET /manifest");
    expect(body.routes).toContain("GET /health");
    expect(body.routes).toContain("GET /instances/:id/info");
  });

  it("reports the script actions the runner actually accepts", async () => {
    const body = await getManifest();
    expect(body.scriptActions).toEqual(Object.keys(SCRIPT_MAP).sort());
  });

  it("carries a version and a summary for every feature", async () => {
    const body = await getManifest();
    expect(Object.keys(body.features).sort()).toEqual(
      Object.keys(FEATURES).sort(),
    );
    for (const f of Object.values(body.features)) {
      expect(f.version).toBeGreaterThanOrEqual(1);
      expect(f.summary.length).toBeGreaterThan(0);
    }
  });
});

describe("the manifest cannot lie about this wrapper", () => {
  it("invents no route — every entry resolves in the real router", async () => {
    const body = await getManifest();
    for (const entry of body.routes) {
      const [method, url] = entry.split(" ") as [string, string];
      expect(
        app.hasRoute({ method: method as "GET", url }),
        `manifest lists ${entry}, which the router does not have`,
      ).toBe(true);
    }
  });

  it("declares no feature whose routes it does not serve", async () => {
    const body = await getManifest();
    const served = new Set(body.routes);
    for (const [name, spec] of Object.entries(FEATURES)) {
      for (const route of spec.routes) {
        expect(served, `feature "${name}" declares an unserved route`).toContain(
          route,
        );
      }
    }
  });

  it("serves no instance route that belongs to no feature", async () => {
    const body = await getManifest();
    const claimed = new Set(
      Object.values(FEATURES).flatMap((f) => f.routes as string[]),
    );
    const meta = new Set<string>(META_ROUTES);
    const orphans = body.routes.filter((r) => !claimed.has(r) && !meta.has(r));
    // A new route with no feature is a capability the bot can never learn
    // about — which is the whole failure this manifest exists to prevent.
    expect(orphans).toEqual([]);
  });
});

describe("openapi.yaml agrees with the router", () => {
  // The spec is documentation, so it drifts; this is the check that stops
  // it. It compares path sets only — response shapes are not asserted here.
  function specRoutes(): string[] {
    const yaml = fs.readFileSync(
      path.resolve(import.meta.dirname, "..", "openapi.yaml"),
      "utf-8",
    );
    const out: string[] = [];
    let current: string | null = null;
    for (const line of yaml.split("\n")) {
      const pathLine = /^ {2}(\/[^\s:]*):\s*$/.exec(line);
      if (pathLine) {
        // OpenAPI writes {id}; Fastify writes :id.
        current = pathLine[1]!.replace(/\{(\w+)\}/g, ":$1");
        continue;
      }
      if (!current) continue;
      const verb = /^ {4}(get|post|put|patch|delete):\s*$/.exec(line);
      if (verb) out.push(`${verb[1]!.toUpperCase()} ${current}`);
      // A non-indented line ends the paths block.
      if (/^\S/.test(line)) current = null;
    }
    return out;
  }

  it("documents every route and invents none", async () => {
    const body = await getManifest();
    expect(specRoutes().sort()).toEqual(body.routes.sort());
  });
});
