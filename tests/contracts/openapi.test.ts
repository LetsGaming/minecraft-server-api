/**
 * openapi.json is generated from the router, never edited. These checks fail
 * when the committed file is stale, when a route has no documented reply, or
 * when the document names something the router does not serve.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";

import { buildApp } from "../../src/http/app.js";
import {
  OPENAPI_PATH,
  renderOpenApi,
} from "../../src/contracts/generateOpenApi.js";
import { WRAPPER_VERSION } from "../../src/contracts/version.js";
import type { AppConfig } from "../../src/config/types.js";

interface Operation {
  operationId: string;
  summary?: string;
  tags?: string[];
  security?: unknown[];
  responses: Record<string, { content?: Record<string, { schema: unknown }> }>;
}
interface Document {
  info: { version: string };
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, unknown> };
}

let rendered: string;
let doc: Document;
let routeKeys: string[];

beforeAll(async () => {
  rendered = await renderOpenApi();
  doc = JSON.parse(rendered) as Document;

  const config = { PORT: 0, API_KEY: "k", instances: {} } as AppConfig;
  const { app, logStreamAPI, routeSpecs } = await buildApp({
    config,
    allowNoAuth: false,
  });
  await app.ready();
  routeKeys = routeSpecs.map((r) => `${r.method} ${r.url}`);
  logStreamAPI.dispose();
  await app.close();
});

function documentedRoutes(): string[] {
  return Object.entries(doc.paths).flatMap(([path, verbs]) =>
    Object.keys(verbs).map(
      (verb) => `${verb.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ":$1")}`,
    ),
  );
}

describe("openapi.json", () => {
  it("is exactly what the router generates (run npm run openapi:generate)", () => {
    const committed = fs
      .readFileSync(OPENAPI_PATH, "utf-8")
      .replace(/\r\n/g, "\n");
    expect(committed).toBe(rendered);
  });

  it("documents every route the router serves and invents none", () => {
    expect(documentedRoutes().sort()).toEqual([...routeKeys].sort());
  });

  it("reports the package version", () => {
    expect(doc.info.version).toBe(WRAPPER_VERSION);
  });

  it("gives every operation a summary, a tag, a unique id and a success reply", () => {
    const ids = new Set<string>();
    for (const [path, verbs] of Object.entries(doc.paths)) {
      for (const [verb, op] of Object.entries(verbs)) {
        const where = `${verb.toUpperCase()} ${path}`;
        expect(op.summary, `${where} has no summary`).toBeTruthy();
        expect(op.tags?.length, `${where} has no tag`).toBeGreaterThan(0);
        expect(op.responses["200"] ?? op.responses["202"], `${where} has no success reply`).toBeDefined();
        expect(ids.has(op.operationId), `${where} repeats an operationId`).toBe(
          false,
        );
        ids.add(op.operationId);
      }
    }
  });

  it("requires the API key everywhere except GET /health", () => {
    for (const [path, verbs] of Object.entries(doc.paths)) {
      for (const [verb, op] of Object.entries(verbs)) {
        const isPublic = Array.isArray(op.security) && op.security.length === 0;
        expect(isPublic, `${verb} ${path}`).toBe(path === "/health");
      }
    }
  });

  it("resolves every $ref to a component", () => {
    const refs = [
      ...rendered.matchAll(/"\$ref": "#\/components\/schemas\/(\w+)"/g),
    ];
    expect(refs.length).toBeGreaterThan(0);
    for (const [, name] of refs) {
      expect(
        doc.components.schemas[name!],
        `dangling $ref ${name}`,
      ).toBeDefined();
    }
  });
});
