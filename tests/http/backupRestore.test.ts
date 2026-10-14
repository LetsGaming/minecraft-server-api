/**
 * POST /instances/:id/backups/files/:fileId/restore refuses to run unless the
 * server is offline. The instance bundle is stubbed so each health state can
 * be driven directly.
 */
import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";

import { registerBackupFileRoutes } from "../../src/http/routes/instance/backups.js";
import type { InstanceEntry } from "../../src/http/routes/instance/shared.js";
import type { ServerState } from "../../src/contracts/wire.js";

const FILE_ID = "A".repeat(22);
const RESTORE_URL = `/instances/survival/backups/files/${FILE_ID}/restore`;

function build(opts: {
  state: ServerState | "throw";
  /** What the cached health answer claims; defaults to a stale "offline". */
  cached?: ServerState;
  found?: boolean;
}) {
  // Mirrors instances/restore.ts: the offline probe runs inside the slot,
  // before the script; `ran` says whether the script would have started.
  const ran = vi.fn();
  const restore = vi.fn(async (_abs: string, beforeRun?: () => Promise<void>) => {
    await beforeRun?.();
    ran();
    return { output: "done", stderr: "", exitCode: 0 };
  });
  const entry = {
    getHealth: vi.fn(async () => ({ state: opts.cached ?? "offline" })),
    getFreshHealth: vi.fn(async () => {
      if (opts.state === "throw") throw new Error("probe exploded");
      return { state: opts.state };
    }),
    resolveBackupFile: vi.fn(async () =>
      opts.found === false ? null : { absPath: "/backups/hourly/a.tar.zst" },
    ),
    restore,
  } as unknown as InstanceEntry;

  const app = Fastify();
  registerBackupFileRoutes(app, (id, reply) => {
    if (id !== "survival") {
      void reply.status(404).send({ error: "Instance not found" });
      return null;
    }
    return entry;
  });
  return { app, restore: ran, restoreCall: restore };
}

describe("restore route online guard", () => {
  it.each<ServerState>(["online", "unresponsive"])(
    "409s without running the script while the server is %s",
    async (state) => {
      const { app, restore } = build({ state });
      const res = await app.inject({ method: "POST", url: RESTORE_URL });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error: "Server must be offline to restore a backup. Stop it first.",
        state,
      });
      expect(restore).not.toHaveBeenCalled();
    },
  );

  it("runs the restore with the resolved absolute path when offline", async () => {
    const { app, restoreCall } = build({ state: "offline" });
    const res = await app.inject({ method: "POST", url: RESTORE_URL });
    expect(res.statusCode).toBe(200);
    expect(restoreCall).toHaveBeenCalledWith("/backups/hourly/a.tar.zst", expect.any(Function));
  });

  it("still 404s an unknown archive before probing health", async () => {
    const { app, restore } = build({ state: "online", found: false });
    const res = await app.inject({ method: "POST", url: RESTORE_URL });
    expect(res.statusCode).toBe(404);
    expect(restore).not.toHaveBeenCalled();
  });

  it("trusts the fresh probe over a stale cached offline", async () => {
    const { app, restore } = build({ state: "online", cached: "offline" });
    const res = await app.inject({ method: "POST", url: RESTORE_URL });
    expect(res.statusCode).toBe(409);
    expect(restore).not.toHaveBeenCalled();
  });

  it("fails closed with 503 when the fresh probe cannot complete", async () => {
    const { app, restore } = build({ state: "throw", cached: "offline" });
    const res = await app.inject({ method: "POST", url: RESTORE_URL });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/Could not verify/);
    expect(restore).not.toHaveBeenCalled();
  });

  it("rejects a malformed id with 400 before anything else", async () => {
    const { app } = build({ state: "offline" });
    const res = await app.inject({
      method: "POST",
      url: "/instances/survival/backups/files/short/restore",
    });
    expect(res.statusCode).toBe(400);
  });
});
