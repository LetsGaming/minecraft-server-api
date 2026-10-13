import { describe, it, expect } from "vitest";

import { createOperationSlot, OperationBusyError } from "../../src/instances/operationSlot.js";

describe("operation slot", () => {
  it("is free until something takes it", () => {
    const slot = createOperationSlot();
    expect(slot.current()).toBeNull();
    const release = slot.begin("backup")!;
    expect(slot.current()).toEqual({ kind: "backup" });
    release();
    expect(slot.current()).toBeNull();
  });

  it("refuses a second operation and names the holder", () => {
    const slot = createOperationSlot();
    slot.begin("upgrade", "job-1");
    expect(slot.begin("restore")).toBeNull();
    expect(slot.current()).toEqual({ kind: "upgrade", jobId: "job-1" });
  });

  it("lets mod writes overlap with each other but with nothing else", () => {
    const slot = createOperationSlot();
    const a = slot.begin("mods")!;
    const b = slot.begin("mods")!;
    expect(b).not.toBeNull();
    expect(slot.begin("backup")).toBeNull();
    a();
    expect(slot.current()).toEqual({ kind: "mods" });
    b();
    expect(slot.current()).toBeNull();
  });

  it("does not let two upgrades or two backups share", () => {
    const slot = createOperationSlot();
    slot.begin("backup");
    expect(slot.begin("backup")).toBeNull();
  });

  it("releases once even when called twice", () => {
    const slot = createOperationSlot();
    const first = slot.begin("mods")!;
    const second = slot.begin("mods")!;
    first();
    first();
    expect(slot.current()).toEqual({ kind: "mods" });
    second();
    expect(slot.current()).toBeNull();
  });

  it("run frees the slot after success and after failure", async () => {
    const slot = createOperationSlot();
    await expect(slot.run("stop", async () => 5)).resolves.toBe(5);
    expect(slot.current()).toBeNull();
    await expect(
      slot.run("stop", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(slot.current()).toBeNull();
  });

  it("run throws a busy error while the slot is held", async () => {
    const slot = createOperationSlot();
    slot.begin("restore");
    await expect(slot.run("stop", async () => 1)).rejects.toBeInstanceOf(OperationBusyError);
    await expect(slot.run("stop", async () => 1)).rejects.toMatchObject({ busy: { kind: "restore" } });
  });
});
