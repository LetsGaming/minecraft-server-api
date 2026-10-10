import fs from "fs";
import os from "os";
import path from "path";
import type { InstanceConfig } from "../../src/config/types.js";

export interface Fixture {
  root: string;
  cfg: InstanceConfig;
  cleanup(): void;
}

export function makeFixture(overrides: Partial<InstanceConfig> = {}): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wrp-fx-"));
  const serverPath = path.join(root, "server");
  const scriptsDir = path.join(root, "scripts");
  fs.mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });
  return {
    root,
    cfg: {
      id: "fx",
      serverPath,
      linuxUser: "minecraft",
      useRcon: false,
      rconHost: "localhost",
      rconPort: 25575,
      rconPassword: "",
      backupsPath: "",
      scriptsDir,
      ...overrides,
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

export function touch(file: string, content = ""): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
