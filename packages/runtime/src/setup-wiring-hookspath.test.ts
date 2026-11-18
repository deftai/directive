/**
 * #4960 / #5846 (ledger Problem 20): another core.hooksPath is "inactive", not a
 * conflict; install/repair take it over only with the plan's approval
 * (`takeOverHooksPath`); doctor names `directive install --repair`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INSTALLATION_RECOVERY_GUIDANCE,
  RUNTIME_PIN_PACKAGE,
} from "@deftai/directive-core/dist/install-health/constants.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FOREIGN_HOOKS_PATH_RECOVERY_GUIDANCE,
  formatDoctorReport,
  runDoctorDiagnosis,
} from "./doctor-diagnose.js";
import { CURRENT_DATA_SCHEMA_VERSION, DATA_SCHEMA_MARKER_REL } from "./migrate.js";
import { runSetup } from "./setup.js";
import { ensureGitHooks, isOurHooksPathValue, readHooksPathState } from "./setup-wiring.js";

const TEMPS: string[] = [];
const SAVED: Record<string, string | undefined> = {};
let globalConfig = "";

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TEMPS.push(dir);
  return dir;
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function gitOrNull(root: string, ...args: string[]): string | null {
  try {
    return git(root, ...args);
  } catch {
    return null;
  }
}

function repo(): string {
  const root = temp("hookspath-");
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "t", version: "0.0.0", private: true }, null, 2)}\n`,
  );
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

function setGlobalHooksPath(value: string): void {
  writeFileSync(globalConfig, `[core]\n\thooksPath = ${value}\n`);
}

function readinessPath(root: string, version: string): string {
  return join(root, ".deft", "directive", `wiring-ready.${version}.json`);
}

/** Pin + lockfile + installed package + data schema so only readiness can fail. */
function makeOtherwiseHealthy(root: string, version: string): void {
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "t",
        version: "0.0.0",
        private: true,
        devDependencies: { [RUNTIME_PIN_PACKAGE]: version },
      },
      null,
      2,
    )}\n`,
  );
  const runtimePkg = join(root, "node_modules", "@deftai", "directive-runtime");
  mkdirSync(runtimePkg, { recursive: true });
  writeFileSync(
    join(runtimePkg, "package.json"),
    `${JSON.stringify({ name: RUNTIME_PIN_PACKAGE, version }, null, 2)}\n`,
  );
  writeFileSync(
    join(root, "package-lock.json"),
    `${JSON.stringify(
      {
        name: "t",
        lockfileVersion: 3,
        packages: {
          "": { name: "t", version: "0.0.0" },
          [`node_modules/${RUNTIME_PIN_PACKAGE}`]: {
            version,
            resolved: `https://example.test/${RUNTIME_PIN_PACKAGE}-${version}.tgz`,
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  mkdirSync(join(root, ".deft", "directive"), { recursive: true });
  writeFileSync(
    join(root, DATA_SCHEMA_MARKER_REL),
    `${JSON.stringify({ schemaVersion: CURRENT_DATA_SCHEMA_VERSION }, null, 2)}\n`,
  );
}

beforeEach(() => {
  for (const k of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]) SAVED[k] = process.env[k];
  const home = temp("hookspath-global-");
  globalConfig = join(home, "gitconfig");
  writeFileSync(globalConfig, "");
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  while (TEMPS.length > 0) {
    const p = TEMPS.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

describe("readHooksPathState (#4960)", () => {
  it("reports unset, ours and foreign with the config scope", () => {
    const root = repo();
    expect(readHooksPathState(root)).toEqual({ kind: "unset", value: null, scope: null });

    setGlobalHooksPath("/opt/global-hooks");
    expect(readHooksPathState(root)).toEqual({
      kind: "foreign",
      value: "/opt/global-hooks",
      scope: "global",
    });

    git(root, "config", "--local", "core.hooksPath", ".githooks");
    expect(readHooksPathState(root)).toEqual({ kind: "ours", value: ".githooks", scope: "local" });
  });

  it("treats an absolute path to <root>/.githooks as ours", () => {
    const root = repo();
    mkdirSync(join(root, ".githooks"), { recursive: true });
    expect(isOurHooksPathValue(root, join(root, ".githooks"))).toBe(true);
    expect(isOurHooksPathValue(root, ".githooks/")).toBe(true);
    expect(isOurHooksPathValue(root, "custom-hooks")).toBe(false);
    git(root, "config", "--local", "core.hooksPath", join(root, ".githooks"));
    expect(readHooksPathState(root).kind).toBe("ours");
    expect(ensureGitHooks(root).hooksPathActive).toBe(true);
  });
});

describe("ensureGitHooks with another core.hooksPath (#4960 / #5846)", () => {
  it("global hooksPath without consent: inactive, no conflict, Git config unchanged", () => {
    const root = repo();
    setGlobalHooksPath("/opt/global-hooks");
    const result = ensureGitHooks(root);
    expect(result.conflicts).toEqual([]);
    expect(result.hooksPathActive).toBe(false);
    expect(result.hooksPathTakenOver).toBeNull();
    expect(result.inactiveDisclosure).toContain("core.hooksPath is '/opt/global-hooks'");
    expect(result.inactiveDisclosure).toContain("your global Git config");
    expect(result.inactiveDisclosure).toContain("directive install --repair");
    expect(gitOrNull(root, "config", "--local", "--get", "core.hooksPath")).toBeNull();
    expect(git(root, "config", "--global", "--get", "core.hooksPath")).toBe("/opt/global-hooks");
  });

  it("global hooksPath with takeOverHooksPath: local .githooks, global untouched", () => {
    const root = repo();
    setGlobalHooksPath("/opt/global-hooks");
    const result = ensureGitHooks(root, { takeOverHooksPath: true });
    expect(result.conflicts).toEqual([]);
    expect(result.hooksPathActive).toBe(true);
    expect(result.inactiveDisclosure).toBeNull();
    expect(result.hooksPathTakenOver).toEqual({ previous: "/opt/global-hooks", scope: "global" });
    expect(git(root, "config", "--local", "--get", "core.hooksPath")).toBe(".githooks");
    expect(git(root, "config", "--global", "--get", "core.hooksPath")).toBe("/opt/global-hooks");
  });

  it("local foreign hooksPath with takeOverHooksPath: replaced, scope local", () => {
    const root = repo();
    git(root, "config", "--local", "core.hooksPath", "custom-hooks");
    const result = ensureGitHooks(root, { takeOverHooksPath: true });
    expect(result.hooksPathTakenOver).toEqual({ previous: "custom-hooks", scope: "local" });
    expect(git(root, "config", "--get", "core.hooksPath")).toBe(".githooks");
  });

  it("unset hooksPath: activates as before and reports no takeover", () => {
    const root = repo();
    const result = ensureGitHooks(root, { takeOverHooksPath: true });
    expect(result.hooksPathActive).toBe(true);
    expect(result.hooksPathTakenOver).toBeNull();
  });
});

describe("runSetup with another core.hooksPath (#4960 / #5846)", { timeout: 30_000 }, () => {
  it("upgrade/automatic setup: exits clean, discloses inactive, never writes readiness", () => {
    const root = repo();
    setGlobalHooksPath("/opt/global-hooks");
    const result = runSetup({ operation: "repair", from: "0.0.0", root });
    expect(result.conflicts).toEqual([]);
    expect(result.gitHooksInactive).toContain("core.hooksPath is '/opt/global-hooks'");
    expect(result.message).toContain("directive install --repair");
    expect(result.hooksPathTakenOver).toBeUndefined();
    expect(existsSync(readinessPath(root, result.runtimeVersion))).toBe(false);
    expect(gitOrNull(root, "config", "--local", "--get", "core.hooksPath")).toBeNull();
  });

  it("install with takeOverHooksPath: writes readiness and reports the takeover", () => {
    const root = repo();
    setGlobalHooksPath("/opt/global-hooks");
    const result = runSetup({
      operation: "install",
      from: "none",
      root,
      takeOverHooksPath: true,
    });
    expect(result.conflicts).toEqual([]);
    expect(result.hooksPathTakenOver).toEqual({ previous: "/opt/global-hooks", scope: "global" });
    expect(result.gitHooksInactive).toBeUndefined();
    expect(existsSync(readinessPath(root, result.runtimeVersion))).toBe(true);
    expect(git(root, "config", "--local", "--get", "core.hooksPath")).toBe(".githooks");
    expect(git(root, "config", "--global", "--get", "core.hooksPath")).toBe("/opt/global-hooks");
  });
});

describe("doctor with another core.hooksPath (#4960 / #5846)", { timeout: 30_000 }, () => {
  it("names directive install --repair and the scope; no global-install line", () => {
    const root = repo();
    setGlobalHooksPath("/opt/global-hooks");
    const setup = runSetup({ operation: "install", from: "none", root });
    makeOtherwiseHealthy(root, setup.runtimeVersion);

    const diag = runDoctorDiagnosis(root, { launcherPresent: true, probeHooks: false });
    expect(diag.exitCode).toBe(1);
    expect(diag.remedy).toBe(FOREIGN_HOOKS_PATH_RECOVERY_GUIDANCE);
    expect(diag.remedy).not.toBe(INSTALLATION_RECOVERY_GUIDANCE);
    expect(diag.surfaces.readiness.ok).toBe(false);
    expect(diag.surfaces.readiness.detail).toContain("/opt/global-hooks");
    expect(diag.surfaces.readiness.detail).toContain("your global Git config");

    const report = formatDoctorReport(diag);
    expect(report).toContain("Recovery: directive install --repair");
    expect(report).not.toContain("npm i -g @deftai/directive");
    // Doctor never writes Git config.
    expect(gitOrNull(root, "config", "--local", "--get", "core.hooksPath")).toBeNull();
  });
});
