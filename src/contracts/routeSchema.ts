/**
 * Helpers for the `schema` every route carries.
 *
 * Only `params`, `querystring` and `response` are real Fastify schemas. The
 * wrapper validates bodies, ids and query values itself so that every failure
 * keeps the historical `{ error }` shape; a Fastify body or pattern schema
 * would replace those messages with its own. The request-side documentation
 * therefore travels in `requestBody`, which Fastify ignores and openapi.ts
 * reads.
 */
import { ErrorBody, NotOfflineBody, type JsonSchema } from "./schemas.js";

export interface RequestBodyDoc {
  description?: string;
  required?: boolean;
  schema: JsonSchema;
}

declare module "fastify" {
  interface FastifySchema {
    summary?: string;
    description?: string;
    tags?: string[];
    /** Served without the API key. */
    public?: boolean;
    /** Documentation only: body validation stays in the route handler. */
    requestBody?: RequestBodyDoc;
    /** Documentation only: request headers a route reads. */
    requestHeaders?: Record<string, { description: string; required: boolean }>;
    /** Media type per status for replies that are not JSON. */
    produces?: Record<number, string>;
  }
}

/** Path parameters: every one is a plain string; the handler checks its shape. */
export function pathParams(descriptions: Record<string, string>): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const [name, description] of Object.entries(descriptions)) {
    properties[name] = { type: "string", description };
  }
  return {
    type: "object",
    properties,
    required: Object.keys(descriptions),
  };
}

export const INSTANCE_ID_DOC = "Instance id from `GET /instances`.";

/** `/instances/:id` plus any extra path parameters. */
export function instanceParams(extra: Record<string, string> = {}): JsonSchema {
  return pathParams({ id: INSTANCE_ID_DOC, ...extra });
}

/** Query values stay strings; the handler parses and clamps them. */
export function queryParams(descriptions: Record<string, string>): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const [name, description] of Object.entries(descriptions)) {
    properties[name] = { type: "string", description };
  }
  return { type: "object", properties };
}

const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: "Invalid input",
  404: "Not found",
  409: "Conflict",
  412: "Precondition failed",
  413: "Payload too large",
  416: "Range not satisfiable",
  428: "Precondition required",
  429: "Too many requests",
  500: "Internal server error",
  502: "Command could not be delivered",
  503: "Unavailable",
};

/** `{ error }` response schemas for the listed status codes. */
export function errors(...codes: number[]): Record<number, JsonSchema> {
  const out: Record<number, JsonSchema> = {};
  for (const code of codes) {
    out[code] = code === 409 ? NotOfflineBody : ErrorBody;
  }
  return out;
}

export function describeStatus(code: number): string {
  return ERROR_DESCRIPTIONS[code] ?? `Status ${code}`;
}
