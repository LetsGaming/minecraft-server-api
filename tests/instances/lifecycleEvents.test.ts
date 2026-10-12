import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import path from "path";

import { makeFixture, touch, type Fixture } from "../helpers/instanceFixture.js";
import { createLifecycleEvents, EVENTS_FILE } from "../../src/instances/lifecycleEvents.js";

let fx: Fixture;
afterEach(() => fx?.cleanup());

const line = (o: object) => JSON.stringify(o) + "\n";

function setup(content?: string) {
  fx = makeFixture();
  const file = path.join(fx.cfg.serverPath, EVENTS_FILE);
  if (content !== undefined) touch(file, content);
  return { file, events: createLifecycleEvents(fx.cfg) };
}

describe("readLifecycleEvents", () => {
  it("is empty when start.sh has written nothing yet", async () => {
    const { events } = setup();
    expect(await events.readLifecycleEvents(0)).toEqual({ events: [], next: 0, reset: false });
  });

  it("returns every event and a cursor at the end", async () => {
    const text = line({ ts: 1, type: "jvm_start" }) + line({ ts: 2, type: "jvm_exit", exit_code: 1 });
    const { events } = setup(text);
    const r = await events.readLifecycleEvents(0);
    expect(r.events.map((e) => e.type)).toEqual(["jvm_start", "jvm_exit"]);
    expect(r.next).toBe(Buffer.byteLength(text));
    expect(r.reset).toBe(false);
  });

  it("returns only what came after the cursor", async () => {
    const first = line({ ts: 1, type: "jvm_start" });
    const { file, events } = setup(first);
    const a = await events.readLifecycleEvents(0);
    fs.appendFileSync(file, line({ ts: 2, type: "crash_loop_gave_up", rapid_crashes: 5 }));
    const b = await events.readLifecycleEvents(a.next);
    expect(b.events).toEqual([{ ts: 2, type: "crash_loop_gave_up", rapid_crashes: 5 }]);
    expect((await events.readLifecycleEvents(b.next)).events).toEqual([]);
  });

  it("waits for a half-written last line", async () => {
    const whole = line({ ts: 1, type: "jvm_start" });
    const { events } = setup(whole + '{"ts":2,"type":"jvm_ex');
    const r = await events.readLifecycleEvents(0);
    expect(r.events).toHaveLength(1);
    expect(r.next).toBe(Buffer.byteLength(whole));
  });

  it("skips a damaged line instead of failing", async () => {
    const { events } = setup("garbage\n" + line({ ts: 1, type: "jvm_start" }) + "[1,2]\n");
    const r = await events.readLifecycleEvents(0);
    expect(r.events).toEqual([{ ts: 1, type: "jvm_start" }]);
  });

  it("reports a rotation when the cursor is past the end of the file", async () => {
    const { events } = setup(line({ ts: 9, type: "jvm_start" }));
    const r = await events.readLifecycleEvents(100_000);
    expect(r.reset).toBe(true);
    expect(r.next).toBeGreaterThan(0);
  });

  it("counts bytes, not characters, for the cursor", async () => {
    const text = line({ ts: 1, type: "x", note: "ä€" });
    const { events } = setup(text + line({ ts: 2, type: "y" }));
    const first = await events.readLifecycleEvents(0);
    const again = await events.readLifecycleEvents(first.next);
    expect(first.events).toHaveLength(2);
    expect(again.events).toEqual([]);
  });
});
