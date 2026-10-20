/**
 * Builds the OpenAPI document from the routes the router actually registered.
 *
 * Why in-house rather than @fastify/swagger: the route census in app.ts
 * already collects every registered route, and this module only has to turn
 * the schemas attached to them into a document. A runtime plugin would add a
 * dependency to every deployment to produce a file that is committed anyway.
 *
 * The output is deterministic (sorted paths and components) so the committed
 * `openapi.json` can be drift-checked byte for byte.
 */
import { describeStatus } from "./routeSchema.js";
import { ErrorBody, componentNameOf, type JsonSchema } from "./schemas.js";

export interface RouteSpec {
  method: string;
  url: string;
  schema?: unknown;
}

interface DocumentedSchema {
  summary?: string;
  description?: string;
  tags?: string[];
  public?: boolean;
  params?: JsonSchema;
  querystring?: JsonSchema;
  requestBody?: {
    description?: string;
    required?: boolean;
    schema: JsonSchema;
  };
  requestHeaders?: Record<string, { description: string; required: boolean }>;
  produces?: Record<number, string>;
  response?: Record<number, JsonSchema>;
}

type Json = Record<string, unknown>;

const JSON_MEDIA = "application/json";

const INFO_DESCRIPTION = [
  "Lightweight HTTP wrapper for managing Minecraft server instances, the",
  "remote backend for minecraft-bot.",
  "",
  "Generated from the router by `npm run openapi:generate`. Do not edit by hand.",
  "",
  "Every route except `GET /health` requires the `x-api-key` header. Every",
  'non-2xx body carries `error` (`{ "error": "<message>" }`); a 423 also',
  "carries `busy`. Clients negotiate by the feature names and versions in",
  "`GET /manifest`, not by wrapper version.",
].join("\n");

export function buildOpenApi(
  specs: readonly RouteSpec[],
  version: string,
): Json {
  const components = new Map<string, Json>();

  const convert = (node: unknown, isDefinitionRoot = false): unknown => {
    if (Array.isArray(node)) return node.map((item) => convert(item));
    if (node === null || typeof node !== "object") return node;
    if (!isDefinitionRoot) {
      const name = componentNameOf(node);
      if (name) {
        register(name, node as JsonSchema);
        return { $ref: `#/components/schemas/${name}` };
      }
    }
    const out: Json = {};
    for (const [key, value] of Object.entries(node)) {
      if (value === undefined) continue;
      out[key] = convert(value);
    }
    return out;
  };

  const sources = new Map<string, JsonSchema>();
  const register = (name: string, schema: JsonSchema): void => {
    const existing = sources.get(name);
    if (existing) {
      if (existing !== schema) {
        throw new Error(`Two different schemas are both named "${name}"`);
      }
      return;
    }
    sources.set(name, schema);
    components.set(name, convert(schema, true) as Json);
  };

  const paths: Record<string, Record<string, Json>> = {};
  const ordered = [...specs].sort(
    (a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method),
  );

  for (const spec of ordered) {
    const doc = (spec.schema ?? {}) as DocumentedSchema;
    const pathKey = spec.url.replace(/:(\w+)/g, "{$1}");
    const verb = spec.method.toLowerCase();

    const operation: Json = { operationId: operationId(verb, spec.url) };
    if (doc.summary) operation.summary = doc.summary;
    if (doc.description) operation.description = doc.description;
    if (doc.tags) operation.tags = doc.tags;
    if (doc.public) operation.security = [];

    const parameters = [
      ...parametersOf(doc.params, "path", convert),
      ...parametersOf(doc.querystring, "query", convert),
      ...Object.entries(doc.requestHeaders ?? {}).map(([name, header]) => ({
        name,
        in: "header",
        required: header.required,
        description: header.description,
        schema: { type: "string" },
      })),
    ];
    if (parameters.length > 0) operation.parameters = parameters;

    if (doc.requestBody) {
      const body: Json = {
        required: doc.requestBody.required === true,
        content: { [JSON_MEDIA]: { schema: convert(doc.requestBody.schema) } },
      };
      if (doc.requestBody.description)
        body.description = doc.requestBody.description;
      operation.requestBody = body;
    }

    const responses: Record<string, Json> = {};
    for (const [status, schema] of Object.entries(doc.response ?? {})) {
      const code = Number(status);
      const media = doc.produces?.[code] ?? JSON_MEDIA;
      const isBinary = media !== JSON_MEDIA;
      const body = isBinary
        ? media === "text/event-stream"
          ? { type: "string" }
          : { type: "string", format: "binary" }
        : convert(schema);
      responses[status] = {
        description:
          code < 400 ? successDescription(code) : describeStatus(code),
        content: { [media]: { schema: body } },
      };
    }
    if (!doc.public) {
      for (const [code, description] of [
        [401, "Missing or invalid API key"],
        [429, "Rate limited"],
      ] as const) {
        responses[code] ??= {
          description,
          content: { [JSON_MEDIA]: { schema: convert(ErrorBody) } },
        };
      }
    }
    operation.responses = sortKeys(responses);

    (paths[pathKey] ??= {})[verb] = operation;
  }

  return {
    openapi: "3.0.3",
    info: {
      title: "mc-api-server",
      version,
      description: INFO_DESCRIPTION,
    },
    servers: [{ url: "http://localhost:3000" }],
    security: [{ ApiKeyAuth: [] }],
    paths,
    components: {
      securitySchemes: {
        ApiKeyAuth: { type: "apiKey", in: "header", name: "x-api-key" },
      },
      schemas: sortKeys(Object.fromEntries(components)),
    },
  };
}

function successDescription(code: number): string {
  return code === 206 ? "Partial content" : "OK";
}

function parametersOf(
  schema: JsonSchema | undefined,
  location: "path" | "query",
  convert: (node: unknown) => unknown,
): Json[] {
  const properties = (schema?.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((schema?.required ?? []) as string[]);
  return Object.entries(properties).map(([name, property]) => {
    const { description, ...rest } = property as {
      description?: string;
    } & Json;
    const parameter: Json = {
      name,
      in: location,
      required: location === "path" || required.has(name),
      schema: convert(rest),
    };
    if (description) parameter.description = description;
    return parameter;
  });
}

/** `GET /instances/:id/mods/:slug` becomes `getInstancesByIdModsBySlug`. */
function operationId(verb: string, url: string): string {
  const words = url
    .split("/")
    .filter(Boolean)
    .map((segment) =>
      segment.startsWith(":") ? `By-${segment.slice(1)}` : segment,
    )
    .join("-")
    .split("-")
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1));
  return verb + words.join("");
}

function sortKeys<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b)),
  );
}
