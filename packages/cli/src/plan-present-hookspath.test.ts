/**
 * #4960 / #5846 (ledger Problem 20): install and install --repair disclose a Git
 * hooks takeover inside their one plan, pass --take-over-hooks-path to setup only
 * after that approval, and state the takeover afterwards. Upgrade never does.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectHooksTakeover, runInstall } from "./bookends.js";
import type { InvokeResult } from "./contract-invoke.js";
import { setupArgv } from "./contract-invoke.js";
import { readProjectInstallState } from "./pin.js";
import {
  foreignHooksInactiveFromSummary,
  HOOK_MANAGER_TIP_LINE,
  presentRepairSuccess,
  presentUpgradeSuccess,
  tryParseSetupSummary,
} from "./plan-present.js";

const TEMPS: string[] = [];
const SAVED: Record<string, string | undefined> = {};
let globalConfig = "";
const VERSION = "1.2.3";

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TEMPS.push(dir);
  return dir;
}

function gitOrNull(root: string, ...args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      writeOut: (t: string) => {
        out.push(t);
      },
      writeErr: (t: string) => {
        err.push(t);
      },
    },
    text: () => out.join("") + err.join(""),
  };
}

/** Git repo with an exact runtime pin, lockfile and installed package (repair-ready). */
function configuredRepo(): string {
  const root = temp("hooks-takeover-");
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "t",
        version: "0.0.0",
        private: true,
        devDependencies: { "@deftai/directive-runtime": VERSION },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(root, "package-lock.json"),
    `${JSON.stringify(
      {
        lockfileVersion: 3,
        packages: {
          "": { name: "t", devDependencies: { "@deftai/directive-runtime": VERSION } },
          "node_modules/@deftai/directive-runtime": { version: VERSION },
        },
      },
      null,
      2,
    )}\n`,
  );
  const nm = join(root, "node_modules", "@deftai", "directive-runtime");
  mkdirSync(join(nm, "dist"), { recursive: true });
  writeFileSync(
    join(nm, "package.json"),
    `${JSON.stringify({ name: "@deftai/directive-runtime", version: VERSION, directive: { contract: 1 } }, null, 2)}\n`,
  );
  writeFileSync(join(nm, "dist", "bin.js"), "#!/usr/bin/env node\nprocess.exit(0);\n");
  return root;
}

function setupStub(calls: string[][], extra: Record<string, unknown> = {}) {
  return (argv: readonly string[]): InvokeResult => {
    calls.push([...argv]);
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        contract: 1,
        entry: "setup",
        created: [],
        modified: [".deft/GENERATION.json"],
        removed: [],
        conflicts: [],
        message: "setup repair completed",
        ...extra,
      }),
      stderr: "",
      spawned: true,
      message: null,
    };
  };
}

const TAKEN_GLOBAL = { hooksPathTakenOver: { previous: "/opt/global-hooks", scope: "global" } };

beforeEach(() => {
  for (const k of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]) SAVED[k] = process.env[k];
  globalConfig = join(temp("hooks-takeover-global-"), "gitconfig");
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

describe("detectHooksTakeover (#4960)", () => {
  it("null without .git, with hooks unset and only sample hooks, or when already ours", () => {
    const noGit = temp("hooks-takeover-nogit-");
    expect(detectHooksTakeover(noGit)).toBeNull();
    const root = configuredRepo();
    expect(detectHooksTakeover(root)).toBeNull();
    execFileSync("git", ["-C", root, "config", "core.hooksPath", ".githooks"]);
    expect(detectHooksTakeover(root)).toBeNull();
    execFileSync("git", ["-C", root, "config", "core.hooksPath", join(root, ".githooks")]);
    expect(detectHooksTakeover(root)).toBeNull();
  });

  it("names a global core.hooksPath and its scope", () => {
    const root = configuredRepo();
    writeFileSync(globalConfig, "[core]\n\thooksPath = /opt/global-hooks\n");
    expect(detectHooksTakeover(root)).toEqual({
      previous: "/opt/global-hooks",
      scope: "global",
      hooks: [],
    });
  });

  it("names non-sample hooks in Git's default hooks folder", () => {
    const root = configuredRepo();
    writeFileSync(join(root, ".git", "hooks", "commit-msg"), "#!/bin/sh\nexit 0\n");
    const t = detectHooksTakeover(root);
    expect(t?.scope).toBe("default");
    expect(t?.hooks).toEqual(["commit-msg"]);
  });
});

describe("install --repair with another hooks folder (#4960 / #5846)", () => {
  it("--yes: one plan with the warning, flag passed, takeover stated afterwards", () => {
    const root = configuredRepo();
    writeFileSync(globalConfig, "[core]\n\thooksPath = /opt/global-hooks\n");
    const calls: string[][] = [];
    const c = capture();
    const code = runInstall(
      root,
      readProjectInstallState(root),
      ["--repair", "--yes"],
      "0.0.0-test",
      c.io,
      { invokeSetup: setupStub(calls, TAKEN_GLOBAL) },
    );
    expect(code).toBe(0);
    const text = c.text();
    expect(text).toContain("Repair Directive");
    expect(text).toContain("/opt/global-hooks (set in your global Git config)");
    expect(text).toContain("To keep things as they are, decline.");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--take-over-hooks-path");
    expect(text).toContain("This repository now uses Directive's .githooks folder.");
    expect(text).toContain(HOOK_MANAGER_TIP_LINE);
  });

  it("declining the one plan changes nothing and runs no setup", () => {
    const root = configuredRepo();
    writeFileSync(globalConfig, "[core]\n\thooksPath = /opt/global-hooks\n");
    const calls: string[][] = [];
    let prompts = 0;
    const c = capture();
    const code = runInstall(root, readProjectInstallState(root), ["--repair"], "0.0.0-test", c.io, {
      stdinIsTTY: true,
      confirm: () => {
        prompts += 1;
        return false;
      },
      invokeSetup: setupStub(calls),
    });
    expect(code).toBe(0);
    expect(prompts).toBe(1); // no second question for hooks
    expect(calls).toHaveLength(0);
    expect(c.text()).toContain("Cancelled. No project files were changed.");
    expect(gitOrNull(root, "config", "--local", "--get", "core.hooksPath")).toBeNull();
  });

  it("--dry-run shows the warning and writes no Git config", () => {
    const root = configuredRepo();
    writeFileSync(globalConfig, "[core]\n\thooksPath = /opt/global-hooks\n");
    const calls: string[][] = [];
    const c = capture();
    const code = runInstall(
      root,
      readProjectInstallState(root),
      ["--repair", "--dry-run"],
      "0.0.0-test",
      c.io,
      { invokeSetup: setupStub(calls) },
    );
    expect(code).toBe(0);
    expect(c.text()).toContain("Git runs hooks from one folder only.");
    expect(calls).toHaveLength(0);
    expect(gitOrNull(root, "config", "--local", "--get", "core.hooksPath")).toBeNull();
  });

  it("no other hooks: no warning and no flag", () => {
    const root = configuredRepo();
    const calls: string[][] = [];
    const c = capture();
    const code = runInstall(
      root,
      readProjectInstallState(root),
      ["--repair", "--yes"],
      "0.0.0-test",
      c.io,
      { invokeSetup: setupStub(calls) },
    );
    expect(code).toBe(0);
    expect(c.text()).not.toContain("Git runs hooks from one folder only.");
    expect(calls[0]).not.toContain("--take-over-hooks-path");
    expect(c.text()).not.toContain(HOOK_MANAGER_TIP_LINE);
  });

  it(".git/hooks/pre-commit with hooksPath unset: warning names the hook", () => {
    const root = configuredRepo();
    writeFileSync(join(root, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n");
    const calls: string[][] = [];
    const c = capture();
    const code = runInstall(
      root,
      readProjectInstallState(root),
      ["--repair", "--yes"],
      "0.0.0-test",
      c.io,
      { invokeSetup: setupStub(calls) },
    );
    expect(code).toBe(0);
    expect(c.text()).toMatch(/this repository's own hooks folder \([^)]*pre-commit\)/);
    expect(c.text()).toContain("This repository now uses Directive's .githooks folder.");
  });
});

describe("first install with a global hooks folder (#4960)", () => {
  it("--yes: warning in the plan and flag on setup", () => {
    const root = temp("hooks-takeover-first-");
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify({ name: "t", version: "0.0.0", private: true }, null, 2)}\n`,
    );
    writeFileSync(globalConfig, "[core]\n\thooksPath = /opt/global-hooks\n");
    const calls: string[][] = [];
    const c = capture();
    const code = runInstall(
      root,
      readProjectInstallState(root),
      ["--yes", "--target-version", VERSION],
      "0.0.0-test",
      c.io,
      {
        runPmAdd: () => {
          // Reuse the configured fixture's pin/lock/installed package.
          const src = configuredRepo();
          for (const f of ["package.json", "package-lock.json"]) {
            writeFileSync(join(root, f), readFileSync(join(src, f), "utf8"));
          }
          const nm = join(root, "node_modules", "@deftai", "directive-runtime");
          mkdirSync(join(nm, "dist"), { recursive: true });
          writeFileSync(
            join(nm, "package.json"),
            readFileSync(
              join(src, "node_modules", "@deftai", "directive-runtime", "package.json"),
              "utf8",
            ),
          );
          writeFileSync(join(nm, "dist", "bin.js"), "process.exit(0);\n");
          return { ok: true as const };
        },
        invokeSetup: setupStub(calls, TAKEN_GLOBAL),
      },
    );
    expect(code).toBe(0);
    expect(c.text()).toContain("Set up Deft Directive");
    expect(c.text()).toContain("Git runs hooks from one folder only.");
    expect(calls[0]).toContain("--take-over-hooks-path");
    expect(c.text()).toContain("This repository now uses Directive's .githooks folder.");
  });
});

describe("takeover that did not take effect (#4960)", () => {
  it("repair names the setting to remove, not git init", () => {
    const disclosure =
      "Git hooks inactive: core.hooksPath is still 'included-hooks' after setting .githooks, because file:/x/extra.gitconfig sets it. Directive does not edit that file: remove the core.hooksPath setting there to use Directive's .githooks.";
    const summary = tryParseSetupSummary(
      JSON.stringify({
        created: [],
        modified: [],
        removed: [],
        conflicts: [],
        gitHooksInactive: disclosure,
        message: `setup repair completed; ${disclosure}`,
      }),
    );
    expect(foreignHooksInactiveFromSummary(summary)).toBe(disclosure);
    const c = capture();
    presentRepairSuccess(c.io, {
      version: VERSION,
      restoredPackage: false,
      summary,
      verbosity: 0,
    });
    const text = c.text().replace(/\s+/g, " ");
    expect(text).toContain("remove the core.hooksPath setting there");
    expect(text).not.toContain("git init");
    expect(text).not.toContain("This repository now uses Directive's .githooks folder.");
  });
});

describe("upgrade never takes over (#4960 / #5846)", () => {
  it("setupArgv never adds the flag for upgrade", () => {
    expect(setupArgv("upgrade", "1.0.0", "/r", { takeOverHooksPath: true })).not.toContain(
      "--take-over-hooks-path",
    );
    expect(setupArgv("repair", "1.0.0", "/r", { takeOverHooksPath: true })).toContain(
      "--take-over-hooks-path",
    );
    expect(setupArgv("install", "none", "/r")).not.toContain("--take-over-hooks-path");
  });

  it("upgrade success shows the inactive disclosure and names directive install --repair", () => {
    const disclosure =
      "Git hooks inactive: core.hooksPath is '/opt/global-hooks', set by your global Git config. Run directive install --repair to review and approve using Directive's .githooks.";
    const summary = tryParseSetupSummary(
      JSON.stringify({
        created: [],
        modified: [],
        removed: [],
        conflicts: [],
        gitHooksInactive: disclosure,
        message: `setup upgrade completed for 1.2.3; ${disclosure}`,
      }),
    );
    const c = capture();
    presentUpgradeSuccess(c.io, {
      version: VERSION,
      versionChange: false,
      pm: "npm",
      summary,
      migrateSummary: null,
      verbosity: 0,
    });
    const text = c.text().replace(/\s+/g, " ");
    expect(text).toContain("core.hooksPath is '/opt/global-hooks'");
    expect(text).toContain("Next: directive install --repair");
    expect(text).not.toContain("is ready.");
    expect(text).not.toContain("Git runs hooks from one folder only.");
  });
});
