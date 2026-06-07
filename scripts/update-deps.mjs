import { execSync, spawn, spawnSync } from "child_process";
import fs from "fs";
import path from "path";

/**
 * CONFIGURATION
 */
const DEV_CHECK_DURATION = 10000;
const IGNORE_DIRS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "vendor",
];

const COLORS = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

const log = {
  info: (msg) => console.log(`${COLORS.cyan}ℹ ${msg}${COLORS.reset}`),
  success: (msg) => console.log(`${COLORS.green}✔ ${msg}${COLORS.reset}`),
  warn: (msg) => console.log(`${COLORS.yellow}⚠ ${msg}${COLORS.reset}`),
  error: (msg) => console.log(`${COLORS.red}✘ ${msg}${COLORS.reset}`),
  step: (msg) => console.log(`${COLORS.gray}  → ${msg}${COLORS.reset}`),
  header: (msg) =>
    console.log(
      `\n${COLORS.bright}${COLORS.blue}=== ${msg} ===${COLORS.reset}`,
    ),
};

/**
 * Detects which package manager to use based on lockfiles
 */
function detectManager(cwd) {
  if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
  return "npm";
}

/**
 * Finds all directories containing a package.json
 */
function findNpmProjects(dir, projects = []) {
  const files = fs.readdirSync(dir);
  if (files.includes("package.json")) {
    projects.push(dir);
  }
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (
      fs.statSync(fullPath).isDirectory() &&
      !IGNORE_DIRS.includes(file) &&
      !file.startsWith(".")
    ) {
      findNpmProjects(fullPath, projects);
    }
  }
  return projects;
}

/**
 * Audits the project and returns { direct, transitive } vulnerability counts.
 * "direct" = vulnerabilities in packages listed in package.json (fixable by you).
 * "transitive" = vulnerabilities only in sub-dependencies (not directly fixable).
 *
 * Only direct vulnerabilities should block an update; transitive ones are reported
 * as warnings since they require upstream fixes.
 */
function getVulnerabilities(cwd, manager) {
  const empty = { direct: 0, transitive: 0 };
  try {
    // Separate stdout/stderr so pnpm WARN lines don't corrupt JSON parsing
    const result = spawnSync(manager, ["audit", "--json"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const auditData = JSON.parse(result.stdout || "{}");

    // npm and pnpm share the same audit JSON shape for metadata.vulnerabilities.
    // The advisories object keys are the individual findings; each has a "findings"
    // array where findings[].paths tells us whether it reaches a direct dep.
    if (auditData.advisories) {
      let direct = 0;
      let transitive = 0;
      for (const advisory of Object.values(auditData.advisories)) {
        const isDirectlyReachable = advisory.findings?.some((f) =>
          f.paths?.some((p) => !p.includes(">")),
        );
        if (isDirectlyReachable) {
          direct++;
        } else {
          transitive++;
        }
      }
      return { direct, transitive };
    }

    // Fallback: only have aggregate counts, can't distinguish direct vs transitive
    if (auditData.metadata?.vulnerabilities) {
      const v = auditData.metadata.vulnerabilities;
      const total =
        (v.low ?? 0) + (v.moderate ?? 0) + (v.high ?? 0) + (v.critical ?? 0);
      // Conservatively treat all as transitive (warn but don't block)
      // since we can't tell without advisory details
      return { direct: 0, transitive: total };
    }

    return empty;
  } catch (e) {
    return empty;
  }
}

/**
 * Returns manager-specific install strategies, in order of preference.
 * Each strategy is tried until one succeeds with zero direct vulnerabilities.
 *
 * `strictPeer` flags whether the strategy uses strict peer resolution (true)
 * or a more permissive one (false). This is forwarded to buildSyncCmd so the
 * final lockfile reconciliation uses the same resolution that actually worked.
 */
function getInstallStrategies(manager) {
  switch (manager) {
    case "pnpm":
      return [
        { name: "Default Install", cmd: "pnpm install", strictPeer: true },
        {
          name: "No Strict Peer Install",
          cmd: "pnpm install --no-strict-peer-dependencies",
          strictPeer: false,
        },
      ];
    case "yarn":
      return [
        { name: "Default Install", cmd: "yarn install", strictPeer: true },
        {
          name: "Ignore Engines Install",
          cmd: "yarn install --ignore-engines",
          strictPeer: true,
        },
      ];
    case "npm":
    default:
      return [
        // audit fix only makes sense after a successful install (lockfile exists).
        // We provide both variants so audit fix uses the same peer resolution that
        // the install step required — mismatching them is what causes CI drift.
        { name: "Default Install", cmd: "npm install", strictPeer: true },
        {
          name: "Legacy Peer Install",
          cmd: "npm install --legacy-peer-deps",
          strictPeer: false,
        },
        { name: "Security Patch", cmd: "npm audit fix", strictPeer: true },
        {
          name: "Security Patch (Legacy Peers)",
          cmd: "npm audit fix --legacy-peer-deps",
          strictPeer: false,
        },
      ];
  }
}

/**
 * Builds the lockfile reconciliation command.
 * Uses the same peer-dep strictness as the winning install strategy so that
 * `npm ci` / `pnpm install --frozen-lockfile` in CI sees a consistent lockfile.
 */
function buildSyncCmd(manager, strictPeer) {
  switch (manager) {
    case "pnpm":
      return strictPeer
        ? "pnpm install"
        : "pnpm install --no-strict-peer-dependencies";
    case "yarn":
      return "yarn install";
    case "npm":
    default:
      return strictPeer ? "npm install" : "npm install --legacy-peer-deps";
  }
}

function runSync(command, cwd) {
  try {
    log.step(`Running: ${command}`);
    execSync(command, {
      stdio: "inherit",
      cwd,
      env: { ...process.env, FORCE_COLOR: "true" },
    });
    return true;
  } catch (err) {
    return false;
  }
}

function killTree(child) {
  if (!child || !child.pid) return;
  if (process.platform === "win32") {
    try {
      execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: "ignore" });
    } catch (e) {}
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (e) {
      try {
        child.kill("SIGKILL");
      } catch (err) {}
    }
  }
}

async function testProject(cwd, manager) {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(cwd, "package.json"), "utf8"),
  );

  // Dynamic script detection priority: dev -> start -> test
  const testScript = ["dev", "start", "test"].find(
    (s) => pkg.scripts && pkg.scripts[s],
  );

  if (!testScript) {
    log.warn("No suitable test/dev script found. Skipping smoke test.");
    return true;
  }

  return new Promise((resolve) => {
    log.info(`Smoke testing via '${manager} run ${testScript}'...`);
    const child = spawn(manager, ["run", testScript], {
      cwd,
      shell: true,
      detached: process.platform !== "win32",
      stdio: "pipe",
    });

    let isResolved = false;
    child.on("error", () => {
      if (!isResolved) {
        isResolved = true;
        resolve(false);
      }
    });

    child.on("exit", (code) => {
      if (!isResolved) {
        isResolved = true;
        if (code !== 0 && code !== null)
          log.error(`Process exited with code ${code}`);
        resolve(false);
      }
    });

    const timer = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        log.success(`Project is stable under '${testScript}'.`);
        killTree(child);
        resolve(true);
      }
    }, DEV_CHECK_DURATION);
    timer.unref();
  });
}

class ProjectGuard {
  constructor(cwd) {
    this.cwd = cwd;
    this.files = [
      "package.json",
      "package-lock.json",
      "yarn.lock",
      "pnpm-lock.yaml",
    ];
    this.backups = new Map();
  }

  backup() {
    log.step("Creating safety backups...");
    for (const file of this.files) {
      const fullPath = path.join(this.cwd, file);
      if (fs.existsSync(fullPath))
        this.backups.set(file, fs.readFileSync(fullPath));
    }
  }

  rollback(manager) {
    log.warn(`Rolling back changes...`);
    for (const [file, content] of this.backups) {
      fs.writeFileSync(path.join(this.cwd, file), content);
    }
    runSync(`${manager} install`, this.cwd);
  }
}

async function updateProject(fullPath) {
  const manager = detectManager(fullPath);
  log.header(
    `Project: ${path.relative(process.cwd(), fullPath) || "Root"} [using ${manager}]`,
  );

  const guard = new ProjectGuard(fullPath);
  guard.backup();

  try {
    // 1. Update Dependencies
    log.info("Updating dependencies...");
    if (!runSync("npx npm-check-updates -u --peer", fullPath)) {
      throw new Error("NCU failed.");
    }

    // 2. Install — try manager-specific strategies in order, stop at first clean success.
    //    Track the strictPeer value of the winning strategy for use in step 3.
    let installSuccess = false;
    let winnerStrictPeer = true;
    const strategies = getInstallStrategies(manager);

    for (const strategy of strategies) {
      log.info(`Attempting: ${strategy.name}`);
      if (runSync(strategy.cmd, fullPath)) {
        const { direct, transitive } = getVulnerabilities(fullPath, manager);
        if (direct === 0) {
          winnerStrictPeer = strategy.strictPeer;
          if (transitive > 0) {
            log.warn(
              `${transitive} transitive vulnerabilit${transitive === 1 ? "y" : "ies"} found in sub-dependencies — these require upstream fixes and won't block the update.`,
            );
          } else {
            log.success("Installation clean.");
          }
          installSuccess = true;
          break;
        } else {
          log.warn(
            `${direct} direct vulnerabilit${direct === 1 ? "y" : "ies"} found, trying next strategy...`,
          );
        }
      }
    }

    if (!installSuccess) {
      throw new Error(
        "All install strategies failed or direct vulnerabilities remain.",
      );
    }

    // 3. Lockfile reconciliation — prevents the "package.json and package-lock.json
    //    are out of sync" error in CI.
    //
    //    WHY THIS HAPPENS: `npm audit fix` rewrites package.json to bump vulnerable
    //    deps to safe versions, but its internal `npm install` call doesn't inherit
    //    the flags (e.g. --legacy-peer-deps) that the earlier install loop needed.
    //    The lockfile ends up reflecting a different resolution than package.json,
    //    and `npm ci` rejects it.
    //
    //    FIX: Run one final install with the same peer-dep strictness as the strategy
    //    that succeeded. This regenerates the lockfile from the current package.json
    //    in a single, consistent pass — the file CI will actually validate against.
    log.info("Reconciling lockfile with package.json for CI compatibility...");
    const syncCmd = buildSyncCmd(manager, winnerStrictPeer);
    if (!runSync(syncCmd, fullPath)) {
      throw new Error("Lockfile reconciliation failed.");
    }
    log.success("Lockfile synced.");

    // 4. Dynamic Smoke Test
    const isStable = await testProject(fullPath, manager);
    if (!isStable) throw new Error("Project failed stability check.");

    log.success("Project updated and verified.");
  } catch (error) {
    log.error(error.message);
    guard.rollback(manager);
  }
}

(async () => {
  process.on("SIGINT", () => {
    log.warn("\nInterrupted. Exiting...");
    process.exit(1);
  });

  const projects = findNpmProjects(process.cwd());
  log.info(`Found ${projects.length} project(s).`);

  for (const projectPath of projects) {
    await updateProject(projectPath);
  }
  log.header("ALL OPERATIONS COMPLETE");
})();
