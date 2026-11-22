/**
 * #7056 (safe interim for #7009): `directive upgrade` names the vbrief→xbrief
 * data migration and runs it only with `--migrate-xbrief` or an interactive
 * yes. `--yes` alone never runs it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectLegacyVbriefTree,
  MIGRATE_XBRIEF_FLAG,
  runInstall,
  runUpgrade,
  type UpgradeDeps,
} from "./bookends.js";
import type { InvokeResult } from "./contract-invoke.js";
import { readProjectInstallState } from "./pin.js";

const TEMPS: string[] = [];

afterEach(() => {
  while (TEMPS.length > 0) {
    const p = TEMPS.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

function tempProject(): string {
  const root = mkdtempSync(join(tmpdir(), "w7056-"));
  TEMPS.push(root);
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "t", version: "0.0.0", private: true }, null, 2)}\n`,
  );
  return root;
}

function installRuntime(root: string, version: string): void {
  const pkgPath = join(root, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
  pkg.devDependencies = { "@deftai/directive-runtime": version };
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  const nm = join(root, "node_modules", "@deftai", "directive-runtime");
  mkdirSync(join(nm, "dist"), { recursive: true });
  writeFileSync(
    join(nm, "package.json"),
    `${JSON.stringify({ name: "@deftai/directive-runtime", version, directive: { contract: 1 } })}\n`,
  );
  writeFileSync(join(nm, "dist", "bin.js"), "#!/usr/bin/env node\nprocess.exit(0);\n");
  writeFileSync(
    join(root, "package-lock.json"),
    `${JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "t", devDependencies: { "@deftai/directive-runtime": version } },
        "node_modules/@deftai/directive-runtime": { version },
      },
    })}\n`,
  );
}

function markWiringCurrent(root: string, version: string): void {
  mkdirSync(join(root, ".deft", "directive"), { recursive: true });
  writeFileSync(
    join(root, ".deft", "GENERATION.json"),
    `${JSON.stringify({ runtimeVersion: version, packageManager: "npm", ownership: [] })}\n`,
  );
  writeFileSync(
    join(root, ".deft", "directive", `wiring-ready.${version}.json`),
    `${JSON.stringify({ runtimeVersion: version })}\n`,
  );
}

/** A legacy tree: two briefs plus the deprecation marker (three files). */
function seedVbrief(root: string): void {
  mkdirSync(join(root, "vbrief", "completed"), { recursive: true });
  writeFileSync(join(root, "vbrief", "completed", "a.vbrief.json"), "{}\n");
  writeFileSync(join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"), "{}\n");
  writeFileSync(join(root, "vbrief", "DEPRECATED.md"), "moved\n");
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

const OK_SETUP: InvokeResult = {
  exitCode: 0,
  stdout: JSON.stringify({
    contract: 1,
    entry: "setup",
    operation: "upgrade",
    created: [],
    modified: [".deft/GENERATION.json"],
    removed: [],
    conflicts: [],
  }),
  stderr: "",
  spawned: true,
  message: null,
};

const OK_MIGRATE: InvokeResult = {
  exitCode: 0,
  stdout: JSON.stringify({
    contract: 1,
    entry: "migrate",
    migrated: ["xbrief/completed/a.xbrief.json"],
    created: ["xbrief/completed/a.xbrief.json"],
    modified: [],
    removed: ["vbrief/completed/a.vbrief.json"],
    conflicts: [],
  }),
  stderr: "",
  spawned: true,
  message: null,
};

/** Version-change seams: PM add installs W; setup and migrate are recorded. */
function versionChangeDeps(calls: { setup: number; migrate: number }): UpgradeDeps {
  return {
    resolvePublishedContract: () => ({ ok: true as const, contract: 1 }),
    checkPmAvailable: () => ({ ok: true as const }),
    runPmAdd: ({ projectRoot, version }) => {
      installRuntime(projectRoot, version);
      return { ok: true as const };
    },
    invokeSetup: () => {
      calls.setup++;
      return OK_SETUP;
    },
    invokeMigrate: () => {
      calls.migrate++;
      return OK_MIGRATE;
    },
  };
}

/** Equal-version seams: wiring current, data behind (migration-only work). */
function migrationOnlyDeps(calls: { setup: number; migrate: number }): UpgradeDeps {
  return {
    resolvePublishedContract: () => ({ ok: true as const, contract: 1 }),
    invokeDoctorDataStatus: () => ({ ok: true as const, dataStatus: "migration_needed" as const }),
    invokeSetup: () => {
      calls.setup++;
      return OK_SETUP;
    },
    invokeMigrate: () => {
      calls.migrate++;
      return OK_MIGRATE;
    },
  };
}

function upgrade(root: string, argv: string[], deps: UpgradeDeps) {
  const c = capture();
  const code = runUpgrade(root, readProjectInstallState(root), argv, "0.0.0-test", c.io, deps);
  return { code, text: c.text() };
}

describe("detectLegacyVbriefTree (#7056)", () => {
  it("returns null with no vbrief/ or an empty one", () => {
    const root = tempProject();
    expect(detectLegacyVbriefTree(root)).toBeNull();
    mkdirSync(join(root, "vbrief", "empty"), { recursive: true });
    expect(detectLegacyVbriefTree(root)).toBeNull();
  });

  it("counts every file, markers included, and reports 0 tracked without a Git repo", () => {
    const root = tempProject();
    seedVbrief(root);
    expect(detectLegacyVbriefTree(root)).toEqual({ files: 3, tracked: 0 });
  });

  it("counts the files Git tracks", () => {
    const root = tempProject();
    seedVbrief(root);
    const git = (args: string[]) =>
      spawnSync("git", ["-C", root, ...args], { encoding: "utf8" }).status;
    if (git(["init", "-q"]) !== 0) return; // no git on this machine
    git(["add", "vbrief/completed/a.vbrief.json"]);
    expect(detectLegacyVbriefTree(root)).toEqual({ files: 3, tracked: 1 });
  });

  it("does not count tracked paths already deleted from disk", () => {
    const root = tempProject();
    seedVbrief(root);
    const git = (args: string[]) =>
      spawnSync("git", ["-C", root, ...args], { encoding: "utf8" }).status;
    if (git(["init", "-q"]) !== 0) return; // no git on this machine
    git(["add", "vbrief"]);
    rmSync(join(root, "vbrief", "completed", "a.vbrief.json"));
    rmSync(join(root, "vbrief", "DEPRECATED.md"));
    expect(detectLegacyVbriefTree(root)).toEqual({ files: 1, tracked: 1 });
  });
});

describe("upgrade asks before the vbrief→xbrief migration (#7056)", () => {
  it("--yes alone: setup runs, migrate is not invoked, vbrief/ stays, notice and pending lines print", () => {
    const root = tempProject();
    installRuntime(root, "1.2.3");
    seedVbrief(root);
    const calls = { setup: 0, migrate: 0 };
    const r = upgrade(root, ["--yes", "--target-version", "2.0.0"], versionChangeDeps(calls));
    expect(r.code).toBe(0);
    expect(calls.setup).toBe(1);
    expect(calls.migrate).toBe(0);
    expect(existsSync(join(root, "vbrief", "completed", "a.vbrief.json"))).toBe(true);
    expect(r.text).toContain("vbrief → xbrief");
    expect(r.text).toContain("3 files found under vbrief/");
    expect(r.text).toContain("deletes vbrief/");
    expect(r.text).toContain("Git restores only committed contents");
    expect(r.text).toContain("--yes alone does not run it");
    expect(r.text).toContain("Not done");
    expect(r.text).toContain("deft migrate:xbrief");
    expect(r.text).toContain("directive upgrade --target-version 2.0.0 --migrate-xbrief --yes");
    expect(readProjectInstallState(root).pin.version).toBe("2.0.0");
  });

  it("--migrate-xbrief --yes: migrate runs as today and the summary names it", () => {
    const root = tempProject();
    installRuntime(root, "1.2.3");
    seedVbrief(root);
    const calls = { setup: 0, migrate: 0 };
    const r = upgrade(
      root,
      ["--yes", MIGRATE_XBRIEF_FLAG, "--target-version", "2.0.0"],
      versionChangeDeps(calls),
    );
    expect(r.code).toBe(0);
    expect(calls.migrate).toBe(1);
    expect(r.text).toContain("Ran the vbrief → xbrief migration");
    expect(r.text).not.toContain("Not done");
  });

  it("interactive yes to the migration question runs migrate", () => {
    const root = tempProject();
    installRuntime(root, "1.2.3");
    seedVbrief(root);
    const calls = { setup: 0, migrate: 0 };
    const prompts: string[] = [];
    const r = upgrade(root, ["--target-version", "2.0.0"], {
      ...versionChangeDeps(calls),
      stdinIsTTY: true,
      confirm: (prompt) => {
        prompts.push(prompt);
        return true;
      },
    });
    expect(r.code).toBe(0);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatch(/vbrief → xbrief migration/);
    expect(calls.migrate).toBe(1);
  });

  it("interactive no to the migration question keeps vbrief/ and reports it pending", () => {
    const root = tempProject();
    installRuntime(root, "1.2.3");
    seedVbrief(root);
    const calls = { setup: 0, migrate: 0 };
    const r = upgrade(root, ["--target-version", "2.0.0"], {
      ...versionChangeDeps(calls),
      stdinIsTTY: true,
      confirm: (prompt) => !/migration/.test(prompt),
    });
    expect(r.code).toBe(0);
    expect(calls.setup).toBe(1);
    expect(calls.migrate).toBe(0);
    expect(r.text).toContain("Not done");
  });

  it("--yes in a TTY never asks the migration question", () => {
    const root = tempProject();
    installRuntime(root, "1.2.3");
    seedVbrief(root);
    const calls = { setup: 0, migrate: 0 };
    const prompts: string[] = [];
    const r = upgrade(root, ["--yes", "--target-version", "2.0.0"], {
      ...versionChangeDeps(calls),
      stdinIsTTY: true,
      confirm: (prompt) => {
        prompts.push(prompt);
        return true;
      },
    });
    expect(r.code).toBe(0);
    expect(prompts).toHaveLength(0);
    expect(calls.migrate).toBe(0);
  });

  it("equal version, migration the only work, --yes: no changes, exit 0, pending reported", () => {
    const root = tempProject();
    installRuntime(root, "1.2.3");
    markWiringCurrent(root, "1.2.3");
    seedVbrief(root);
    const calls = { setup: 0, migrate: 0 };
    const r = upgrade(root, ["--yes", "--target-version", "1.2.3"], migrationOnlyDeps(calls));
    expect(r.code).toBe(0);
    expect(calls.setup).toBe(0);
    expect(calls.migrate).toBe(0);
    expect(r.text).toContain("Not done");
    expect(r.text).toContain("directive upgrade --target-version 1.2.3 --migrate-xbrief --yes");
    expect(r.text).toContain("No project files were changed");
  });

  it("equal version, migration only, non-interactive without --yes: exit 0, no changes", () => {
    const root = tempProject();
    installRuntime(root, "1.2.3");
    markWiringCurrent(root, "1.2.3");
    seedVbrief(root);
    const calls = { setup: 0, migrate: 0 };
    const r = upgrade(root, ["--target-version", "1.2.3"], {
      ...migrationOnlyDeps(calls),
      stdinIsTTY: false,
    });
    expect(r.code).toBe(0);
    expect(calls.migrate).toBe(0);
  });

  it("equal version, migration only, --migrate-xbrief --yes: migrate runs", () => {
    const root = tempProject();
    installRuntime(root, "1.2.3");
    markWiringCurrent(root, "1.2.3");
    seedVbrief(root);
    const calls = { setup: 0, migrate: 0 };
    const r = upgrade(
      root,
      ["--yes", MIGRATE_XBRIEF_FLAG, "--target-version", "1.2.3"],
      migrationOnlyDeps(calls),
    );
    expect(r.code).toBe(0);
    expect(calls.migrate).toBe(1);
    expect(r.text).toContain("Ran the vbrief → xbrief migration");
  });

  it("a marker-only vbrief/ still gets the notice with its file count", () => {
    const root = tempProject();
    installRuntime(root, "1.2.3");
    mkdirSync(join(root, "vbrief"), { recursive: true });
    writeFileSync(join(root, "vbrief", "DEPRECATED.md"), "moved\n");
    const calls = { setup: 0, migrate: 0 };
    const r = upgrade(root, ["--yes", "--target-version", "2.0.0"], versionChangeDeps(calls));
    expect(r.code).toBe(0);
    expect(calls.migrate).toBe(0);
    expect(r.text).toContain("1 file found under vbrief/");
  });

  it("--dry-run shows the notice and changes nothing", () => {
    const root = tempProject();
    installRuntime(root, "1.2.3");
    seedVbrief(root);
    const calls = { setup: 0, migrate: 0 };
    const r = upgrade(root, ["--dry-run", "--target-version", "2.0.0"], versionChangeDeps(calls));
    expect(r.code).toBe(0);
    expect(calls.migrate).toBe(0);
    expect(r.text).toContain("3 files found under vbrief/");
    expect(readProjectInstallState(root).pin.version).toBe("1.2.3");
  });

  it("a project without vbrief/ upgrades exactly as today: migrate runs under --yes, no notice", () => {
    const root = tempProject();
    installRuntime(root, "1.2.3");
    const calls = { setup: 0, migrate: 0 };
    const r = upgrade(root, ["--yes", "--target-version", "2.0.0"], versionChangeDeps(calls));
    expect(r.code).toBe(0);
    expect(calls.migrate).toBe(1);
    expect(r.text).not.toContain("Legacy data migration");
    expect(r.text).not.toContain("Not done");
    expect(r.text).not.toContain("Ran the vbrief → xbrief migration");
  });

  it("files that appear in vbrief/ after the plan stay pending without the flag", () => {
    const root = tempProject();
    installRuntime(root, "1.2.3");
    const calls = { setup: 0, migrate: 0 };
    const deps = versionChangeDeps(calls);
    const r = upgrade(root, ["--yes", "--target-version", "2.0.0"], {
      ...deps,
      invokeSetup: (argv) => {
        seedVbrief(root); // legacy files land after the plan was shown
        return deps.invokeSetup?.(argv) ?? OK_SETUP;
      },
    });
    expect(r.code).toBe(0);
    expect(calls.migrate).toBe(0);
    expect(existsSync(join(root, "vbrief", "completed", "a.vbrief.json"))).toBe(true);
    expect(r.text).toContain("Not done");
    expect(r.text).toContain("3 files found under vbrief/");
  });

  it("files that appear after the plan still migrate with --migrate-xbrief, and the summary names it", () => {
    const root = tempProject();
    installRuntime(root, "1.2.3");
    const calls = { setup: 0, migrate: 0 };
    const deps = versionChangeDeps(calls);
    const r = upgrade(root, ["--yes", MIGRATE_XBRIEF_FLAG, "--target-version", "2.0.0"], {
      ...deps,
      invokeSetup: (argv) => {
        seedVbrief(root);
        return deps.invokeSetup?.(argv) ?? OK_SETUP;
      },
    });
    expect(r.code).toBe(0);
    expect(calls.migrate).toBe(1);
    expect(r.text).toContain("Ran the vbrief → xbrief migration");
  });

  it("install rejects --migrate-xbrief", () => {
    const root = tempProject();
    const c = capture();
    const code = runInstall(
      root,
      readProjectInstallState(root),
      [MIGRATE_XBRIEF_FLAG, "--yes"],
      "0.0.0-test",
      c.io,
      {},
    );
    expect(code).toBe(2);
    expect(c.text()).toContain(MIGRATE_XBRIEF_FLAG);
  });
});
