/**
 * Owner-boundary tests for install / install --repair bookend (Wave 2a / R5–R6).
 * Unit matrix avoids network; optional Verdaccio cases skip when registry is down.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInstall } from "./bookends.js";
import { classifyPinVersion, readProjectInstallState, type ProjectInstallState } from "./pin.js";
import {
  buildPmExactAddArgs,
  detectPackageManager,
  formatPmExactAddCommand,
  isExactSemver,
  isPrereleaseVersion,
  isPnpmWorkspaceRoot,
  lockfileRecordsExactPin,
} from "./pm.js";
import { validateTargetVersionSpec } from "./registry.js";

const TEMPS: string[] = [];

function tempProject(name = "wave2a"): string {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  TEMPS.push(root);
  // Minimal git-ish marker not required for bookend unit tests (root passed in).
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "t", version: "0.0.0", private: true }, null, 2)}\n`);
  return root;
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
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

function stateFor(root: string): ProjectInstallState {
  return readProjectInstallState(root);
}

afterEach(() => {
  while (TEMPS.length > 0) {
    const p = TEMPS.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

describe("target version validation (AC6.1)", () => {
  it("accepts exact versions", () => {
    expect(validateTargetVersionSpec("1.2.3")).toEqual({ ok: true, version: "1.2.3" });
    expect(validateTargetVersionSpec("0.0.0-yolo.cp-wave2a.1")).toEqual({
      ok: true,
      version: "0.0.0-yolo.cp-wave2a.1",
    });
  });

  it("rejects ranges and tags", () => {
    expect(validateTargetVersionSpec("^1.2.3").ok).toBe(false);
    expect(validateTargetVersionSpec("latest").ok).toBe(false);
    expect(validateTargetVersionSpec("~1.0.0").ok).toBe(false);
  });

  it("detects prerelease for latest-stable gate", () => {
    expect(isPrereleaseVersion("1.2.3")).toBe(false);
    expect(isPrereleaseVersion("1.2.3-beta.1")).toBe(true);
    expect(isExactSemver("1.2.3")).toBe(true);
  });
});

describe("PM selection (AC5.7)", () => {
  it("selects npm from package-lock.json", () => {
    const root = tempProject();
    writeFileSync(join(root, "package-lock.json"), "{}\n");
    const pm = detectPackageManager(root, null);
    expect(pm.ok).toBe(true);
    if (pm.ok) {
      expect(pm.pm).toBe("npm");
      expect(pm.evidence).toMatch(/package-lock/);
    }
  });

  it("selects pnpm from pnpm-lock.yaml", () => {
    const root = tempProject();
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const pm = detectPackageManager(root, null);
    expect(pm.ok).toBe(true);
    if (pm.ok) expect(pm.pm).toBe("pnpm");
  });

  it("refuses yarn.lock", () => {
    const root = tempProject();
    writeFileSync(join(root, "yarn.lock"), "# yarn\n");
    const pm = detectPackageManager(root, null);
    expect(pm.ok).toBe(false);
    if (!pm.ok) expect(pm.message).toMatch(/yarn/i);
  });

  it("refuses bun.lock", () => {
    const root = tempProject();
    writeFileSync(join(root, "bun.lock"), "{}\n");
    const pm = detectPackageManager(root, null);
    expect(pm.ok).toBe(false);
    if (!pm.ok) expect(pm.message).toMatch(/bun/i);
  });

  it("refuses explicit Yarn packageManager without lockfile", () => {
    const root = tempProject();
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    pkg.packageManager = "yarn@1.22.0";
    writeFileSync(join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    const pm = detectPackageManager(root, null);
    expect(pm.ok).toBe(false);
    if (!pm.ok) expect(pm.message).toMatch(/yarn/i);
  });

  it("refuses explicit Bun packageManager without lockfile", () => {
    const root = tempProject();
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    pkg.packageManager = "bun@1.1.0";
    writeFileSync(join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    const pm = detectPackageManager(root, null);
    expect(pm.ok).toBe(false);
    if (!pm.ok) expect(pm.message).toMatch(/bun/i);
  });

  it("honours --package-manager when no lockfile", () => {
    const root = tempProject();
    const pm = detectPackageManager(root, "pnpm");
    expect(pm.ok).toBe(true);
    if (pm.ok) {
      expect(pm.pm).toBe("pnpm");
      expect(pm.evidence).toMatch(/--package-manager/);
    }
  });

  it("defaults to npm with evidence when no lockfile / packageManager", () => {
    const root = tempProject();
    const pm = detectPackageManager(root, null);
    expect(pm.ok).toBe(true);
    if (pm.ok) {
      expect(pm.pm).toBe("npm");
      expect(pm.evidence).toMatch(/default/i);
    }
  });
});

describe("lockfile pin consistency (AC6.10)", () => {
  it("reports usable when npm lock records root request + resolved version", () => {
    const root = tempProject();
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    pkg.devDependencies = { "@deftai/directive-runtime": "1.2.3" };
    writeFileSync(join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    writeFileSync(
      join(root, "package-lock.json"),
      `${JSON.stringify(
        {
          lockfileVersion: 3,
          packages: {
            "": {
              name: "t",
              devDependencies: { "@deftai/directive-runtime": "1.2.3" },
            },
            "node_modules/@deftai/directive-runtime": { version: "1.2.3" },
          },
        },
        null,
        2,
      )}\n`,
    );
    expect(lockfileRecordsExactPin(root, "1.2.3", "npm")).toBe(true);
  });

  it("reports unusable when npm lock has resolved version but no root request", () => {
    const root = tempProject();
    writeFileSync(
      join(root, "package-lock.json"),
      `${JSON.stringify(
        {
          lockfileVersion: 3,
          packages: {
            "node_modules/@deftai/directive-runtime": { version: "1.2.3" },
          },
        },
        null,
        2,
      )}\n`,
    );
    expect(lockfileRecordsExactPin(root, "1.2.3", "npm")).toBe(false);
  });

  it("reports usable for pnpm root importer exact specifier+version", () => {
    const root = tempProject();
    writeFileSync(
      join(root, "pnpm-lock.yaml"),
      [
        "lockfileVersion: '9.0'",
        "",
        "importers:",
        "",
        "  .:",
        "    devDependencies:",
        "      '@deftai/directive-runtime':",
        "        specifier: 1.2.3",
        "        version: 1.2.3",
        "",
        "packages:",
        "",
        "  '@deftai/directive-runtime@1.2.3':",
        "    resolution: {integrity: sha512-test}",
        "",
      ].join("\n"),
    );
    expect(lockfileRecordsExactPin(root, "1.2.3", "pnpm")).toBe(true);
  });

  it("ignores non-root workspace importer matches for pnpm", () => {
    const root = tempProject();
    writeFileSync(
      join(root, "pnpm-lock.yaml"),
      [
        "lockfileVersion: '9.0'",
        "",
        "importers:",
        "",
        "  .:",
        "    dependencies:",
        "      leftpad:",
        "        specifier: 1.0.0",
        "        version: 1.0.0",
        "",
        "  packages/other:",
        "    devDependencies:",
        "      '@deftai/directive-runtime':",
        "        specifier: 1.2.3",
        "        version: 1.2.3",
        "",
        "packages:",
        "",
        "  '@deftai/directive-runtime@1.2.3':",
        "    resolution: {integrity: sha512-test}",
        "",
      ].join("\n"),
    );
    expect(lockfileRecordsExactPin(root, "1.2.3", "pnpm")).toBe(false);
  });

  it("reports unusable when lockfile missing", () => {
    const root = tempProject();
    expect(lockfileRecordsExactPin(root, "1.2.3", "npm")).toBe(false);
  });
});

describe("install bookend flag matrix (AC5 / AC6)", () => {
  it("trailing --target-version without value exits 2 before registry", () => {
    const root = tempProject();
    const c = capture();
    let resolveCalled = false;
    const code = runInstall(root, stateFor(root), ["--yes", "--target-version"], "0.0.0-test", c.io, {
      resolveLatest: () => {
        resolveCalled = true;
        return { ok: true as const, version: "1.2.3" };
      },
      runPmAdd: () => {
        throw new Error("PM must not run");
      },
    });
    expect(code).toBe(2);
    expect(resolveCalled).toBe(false);
    expect(c.err()).toMatch(/--target-version requires a value/);
  });

  it("unknown leftover argv (e.g. --dryrun) exits 2 before registry/PM", () => {
    const root = tempProject();
    const c = capture();
    let resolveCalled = false;
    let pmCalled = false;
    const code = runInstall(
      root,
      stateFor(root),
      ["--yes", "--dryrun", "--target-version", "1.2.3"],
      "0.0.0-test",
      c.io,
      {
        resolveLatest: () => {
          resolveCalled = true;
          return { ok: true as const, version: "1.2.3" };
        },
        runPmAdd: () => {
          pmCalled = true;
          return { ok: true };
        },
      },
    );
    expect(code).toBe(2);
    expect(resolveCalled).toBe(false);
    expect(pmCalled).toBe(false);
    expect(c.err()).toMatch(/Unknown argument/);
    expect(c.err()).toMatch(/--dryrun/);
  });

  it("trailing --package-manager without value exits 2 before PM detect mutation", () => {
    const root = tempProject();
    const c = capture();
    const code = runInstall(
      root,
      stateFor(root),
      ["--yes", "--target-version", "1.2.3", "--package-manager"],
      "0.0.0-test",
      c.io,
      {
        runPmAdd: () => {
          throw new Error("PM must not run");
        },
      },
    );
    expect(code).toBe(2);
    expect(c.err()).toMatch(/--package-manager requires a value/);
  });

  it("--repair + --target-version exits 2 (AC6.5)", () => {
    const root = tempProject();
    const c = capture();
    const code = runInstall(root, stateFor(root), ["--repair", "--target-version", "1.2.3", "--yes"], "0.0.0-test", c.io);
    expect(code).toBe(2);
    expect(c.err() + c.out()).toMatch(/--target-version/);
  });

  it("configured pin + --yes without --repair exits 2 with choose commands (AC6.6 / INIT-20)", () => {
    const root = tempProject();
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    pkg.devDependencies = { "@deftai/directive-runtime": "1.2.3" };
    writeFileSync(join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    const c = capture();
    const code = runInstall(root, stateFor(root), ["--yes"], "0.0.0-test", c.io);
    expect(code).toBe(2);
    const text = c.err() + c.out();
    expect(text).toMatch(/install --repair/);
    expect(text).toMatch(/upgrade/);
  });

  it("mutating install without --yes in non-interactive exits 2 (AC5.5)", () => {
    const root = tempProject();
    const c = capture();
    const code = runInstall(
      root,
      stateFor(root),
      ["--target-version", "1.2.3"],
      "0.0.0-test",
      c.io,
      { stdinIsTTY: false, resolveLatest: () => ({ ok: true as const, version: "1.2.3" }) },
    );
    expect(code).toBe(2);
    expect(c.err() + c.out()).toMatch(/--yes/);
  });

  it("--dry-run prints plan and does not create pin (AC5.4)", () => {
    const root = tempProject();
    const before = readFileSync(join(root, "package.json"), "utf8");
    const c = capture();
    const code = runInstall(
      root,
      stateFor(root),
      ["--dry-run", "--target-version", "9.9.9"],
      "0.0.0-test",
      c.io,
      {
        stdinIsTTY: false,
        resolveLatest: () => ({ ok: true as const, version: "9.9.9" }),
        runPmAdd: () => {
          throw new Error("PM must not run on dry-run");
        },
        invokeSetup: () => {
          throw new Error("setup must not run on dry-run");
        },
      },
    );
    expect(code).toBe(0);
    expect(c.out()).toMatch(/dry-run|Plan:/i);
    expect(c.out()).toMatch(/9\.9\.9/);
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(before);
  });

  it("pnpm plan discloses --save-exact", () => {
    const root = tempProject();
    const c = capture();
    const code = runInstall(
      root,
      stateFor(root),
      ["--dry-run", "--package-manager", "pnpm", "--target-version", "1.2.3"],
      "0.0.0-test",
      c.io,
    );
    expect(code).toBe(0);
    expect(c.out()).toMatch(/pnpm add -D --save-exact/);
  });

  it("pnpm workspace root plan and argv include -w", () => {
    const root = tempProject();
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    expect(isPnpmWorkspaceRoot(root)).toBe(true);
    const args = buildPmExactAddArgs("pnpm", "1.2.3", root);
    expect(args).toContain("-w");
    expect(formatPmExactAddCommand("pnpm", "1.2.3", root)).toMatch(/pnpm add -D --save-exact --ignore-scripts -w /);
    const c = capture();
    const code = runInstall(
      root,
      stateFor(root),
      ["--dry-run", "--package-manager", "pnpm", "--target-version", "1.2.3"],
      "0.0.0-test",
      c.io,
    );
    expect(code).toBe(0);
    expect(c.out()).toMatch(/pnpm add -D --save-exact --ignore-scripts -w /);
  });

  it("rejects range --target-version before mutation", () => {
    const root = tempProject();
    const c = capture();
    const code = runInstall(root, stateFor(root), ["--yes", "--target-version", "^1.2.3"], "0.0.0-test", c.io);
    expect(code).toBe(2);
    expect(c.err() + c.out()).toMatch(/exact/i);
  });

  it("repair with ranged pin errors without changing pin (AC6.3)", () => {
    const root = tempProject();
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    pkg.devDependencies = { "@deftai/directive-runtime": "^1.2.3" };
    writeFileSync(join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    const before = readFileSync(join(root, "package.json"), "utf8");
    const c = capture();
    const code = runInstall(root, stateFor(root), ["--repair", "--yes"], "0.0.0-test", c.io);
    expect(code).toBe(1);
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(before);
    expect(classifyPinVersion("^1.2.3").kind).toBe("range");
  });

  it("creates {private:true} when package.json missing (AC6.12) on dry-run disclosure", () => {
    const root = mkdtempSync(join(tmpdir(), "wave2a-nopkg-"));
    TEMPS.push(root);
    const c = capture();
    const code = runInstall(
      root,
      stateFor(root),
      ["--dry-run", "--target-version", "1.0.0"],
      "0.0.0-test",
      c.io,
    );
    expect(code).toBe(0);
    expect(c.out()).toMatch(/private:\s*true|package\.json/i);
    // dry-run must not write
    expect(existsSync(join(root, "package.json"))).toBe(false);
  });

  it("first install with --yes runs PM add then setup (happy path, mocked)", () => {
    const root = tempProject();
    let pmCalled = false;
    let setupCalled: string[] | null = null;
    const c = capture();
    const code = runInstall(
      root,
      stateFor(root),
      ["--yes", "--target-version", "1.2.3"],
      "0.0.0-test",
      c.io,
      {
        stdinIsTTY: false,
        runPmAdd: ({ projectRoot, version }) => {
          pmCalled = true;
          const pkgPath = join(projectRoot, "package.json");
          const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
          pkg.devDependencies = { ...(pkg.devDependencies as object), "@deftai/directive-runtime": version };
          writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
          const nm = join(projectRoot, "node_modules", "@deftai", "directive-runtime");
          mkdirSync(nm, { recursive: true });
          writeFileSync(
            join(nm, "package.json"),
            `${JSON.stringify({ name: "@deftai/directive-runtime", version, directive: { contract: 1 } }, null, 2)}\n`,
          );
          mkdirSync(join(nm, "dist"), { recursive: true });
          writeFileSync(join(nm, "dist", "bin.js"), "#!/usr/bin/env node\nprocess.exit(0);\n");
          return { ok: true as const };
        },
        invokeSetup: (argv) => {
          setupCalled = [...argv];
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              contract: 1,
              entry: "setup",
              created: [".deft/GENERATION.json"],
              modified: [],
              removed: [],
              conflicts: [],
            }),
            stderr: "",
            spawned: true,
            message: null,
          };
        },
      },
    );
    expect(code).toBe(0);
    expect(pmCalled).toBe(true);
    expect(setupCalled).not.toBeNull();
    expect(setupCalled![0]).toBe("setup");
    expect(setupCalled).toContain("--operation");
    expect(setupCalled).toContain("install");
    expect(setupCalled).toContain("--from");
    expect(setupCalled).toContain("none");
    const pin = readProjectInstallState(root).pin;
    expect(pin.kind).toBe("exact");
    expect(pin.version).toBe("1.2.3");
  });

  it("repair preserves pin and hands off setup --operation repair", () => {
    const root = tempProject();
    const version = "1.2.3";
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    pkg.devDependencies = { "@deftai/directive-runtime": version };
    writeFileSync(join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    writeFileSync(
      join(root, "package-lock.json"),
      `${JSON.stringify(
        {
          lockfileVersion: 3,
          packages: {
            "": {
              name: "t",
              devDependencies: { "@deftai/directive-runtime": version },
            },
            "node_modules/@deftai/directive-runtime": { version },
          },
        },
        null,
        2,
      )}\n`,
    );
    const nm = join(root, "node_modules", "@deftai", "directive-runtime");
    mkdirSync(nm, { recursive: true });
    writeFileSync(
      join(nm, "package.json"),
      `${JSON.stringify({ name: "@deftai/directive-runtime", version, directive: { contract: 1 } }, null, 2)}\n`,
    );
    mkdirSync(join(nm, "dist"), { recursive: true });
    writeFileSync(join(nm, "dist", "bin.js"), "#!/usr/bin/env node\nprocess.exit(0);\n");

    let pmCalled = false;
    let setupOp: string | null = null;
    const c = capture();
    const code = runInstall(root, stateFor(root), ["--repair", "--yes"], "0.0.0-test", c.io, {
      runPmAdd: () => {
        pmCalled = true;
        return { ok: true as const };
      },
      invokeSetup: (argv) => {
        const i = argv.indexOf("--operation");
        setupOp = i >= 0 ? (argv[i + 1] ?? null) : null;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            contract: 1,
            entry: "setup",
            created: [],
            modified: [".deft/GENERATION.json"],
            removed: [],
            conflicts: [],
          }),
          stderr: "",
          spawned: true,
          message: null,
        };
      },
    });
    expect(code).toBe(0);
    // Lockfile already records pin → no PM reinstall required
    expect(pmCalled).toBe(false);
    expect(setupOp).toBe("repair");
    const after = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
    };
    expect(after.devDependencies["@deftai/directive-runtime"]).toBe(version);
  });
});
