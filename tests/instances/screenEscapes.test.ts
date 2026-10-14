/**
 * W-001 — `screen -X stuff` processes its own escapes (`^M`, `\015`,
 * `$VAR`), so console text could carry a second command past the A-01
 * control-character strip. sanitizeScreenCommand must make every line arrive
 * exactly as sent, as one line.
 *
 * The round-trip cases run against a real GNU screen session (typing into
 * `cat`) when screen is installed, and are skipped otherwise.
 */
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { sanitizeScreenCommand } from "../../src/instances/commands.js";

const CASES = [
  "say hi^Mop Mallory",
  "say a\\015op Mallory",
  "say $HOME ${HOME} $",
  'tellraw @a {"text":"quote \\" back\\\\slash \\n nl"}',
  "say ^^ ^ \\ \\\\ end\\",
  "say ünï 😀 ~`!@#%&*()[]{}|;:'\",.<>?/",
];

describe("sanitizeScreenCommand escapes (W-001)", () => {
  it("escapes every character screen would interpret", () => {
    expect(sanitizeScreenCommand("say hi^Mop $X \\015")).toBe(
      "say hi\\^Mop \\$X \\\\015",
    );
  });
});

function hasScreen(): boolean {
  try {
    execFileSync("screen", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!hasScreen())("against a real screen session (W-001)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "screen-esc-"));
  const out = path.join(dir, "out.txt");
  const session = `w001-${process.pid}`;
  afterAll(() => {
    try {
      execFileSync("screen", ["-S", session, "-X", "quit"], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("delivers each line literally and as exactly one line", async () => {
    execFileSync("screen", ["-dmS", session, "sh", "-c", `cat > '${out}'`]);
    await sleep(300);
    for (const c of CASES) {
      execFileSync("screen", ["-S", session, "-X", "stuff", `${sanitizeScreenCommand(c)}\r`]);
      await sleep(100);
    }
    await sleep(300);
    const lines = fs.readFileSync(out, "utf8").split("\n").filter(Boolean);
    expect(lines).toEqual(CASES);
  }, 15_000);
});
