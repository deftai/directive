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

  it("hand-added @deftai/directive alone does not block first install (AC14.51)", () => {
    const root = tempProject();
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    pkg.devDependencies = { "@deftai/directive": "0.200.0" };
    writeFileSync(join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    const before = readFileSync(join(root, "package.json"), "utf8");
    expect(stateFor(root).pin.kind).toBe("none");

    let pmCalled = false;
    let setupOp: string | null = null;
    const c = capture();
    const code = runInstall(
      root,
      stateFor(root),
      ["--yes", "--target-version", "1.2.3"],
      "0.0.0-test",
      c.io,
      {
        runPmAdd: (_opts) => {
          pmCalled = true;
          const cur = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<
            string,
            unknown
          >;
          const deps = {
            ...((cur.devDependencies as Record<string, string> | undefined) ?? {}),
            "@deftai/directive-runtime": "1.2.3",
          };
          cur.devDependencies = deps;
          writeFileSync(join(root, "package.json"), `${JSON.stringify(cur, null, 2)}\n`);
          writeFileSync(
            join(root, "package-lock.json"),
            `${JSON.stringify(
              {
                lockfileVersion: 3,
                packages: {
                  "": { name: "t", devDependencies: deps },
                  "node_modules/@deftai/directive-runtime": { version: "1.2.3" },
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
            `${JSON.stringify(
              { name: "@deftai/directive-runtime", version: "1.2.3", directive: { contract: 1 } },
              null,
              2,
            )}\n`,
          );
          mkdirSync(join(nm, "dist"), { recursive: true });
          writeFileSync(join(nm, "dist", "bin.js"), "#!/usr/bin/env node\nprocess.exit(0);\n");
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
    expect(setupOp).toBe("install");
    expect(c.err() + c.out()).not.toMatch(/already configured/i);
    // Launcher project dep left alone (AC14.51)
    const after = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
    };
    expect(after.devDependencies["@deftai/directive"]).toBe("0.200.0");
    expect(after.devDependencies["@deftai/directive-runtime"]).toBe("1.2.3");
    expect(before).toMatch(/@deftai\/directive/);
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

  it("npm exact-add argv includes --include=dev (AC5.11 / AC14.48 / INIT-13)", () => {
    const root = tempProject();
    const args = buildPmExactAddArgs("npm", "1.2.3", root);
    expect(args).toContain("--include=dev");
    expect(args).toContain("--save-dev");
    expect(args).toContain("--save-exact");
    expect(formatPmExactAddCommand("npm", "1.2.3", root)).toMatch(
      /npm install --save-dev --save-exact --ignore-scripts --include=dev /,
    );
    const c = capture();
    const code = runInstall(
      root,
      stateFor(root),
      ["--dry-run", "--package-manager", "npm", "--target-version", "1.2.3"],
      "0.0.0-test",
      c.io,
    );
    expect(code).toBe(0);
    expect(c.out()).toMatch(/--include=dev/);
  });

  it("pnpm exact-add argv forces non-production so -D is physically installed (AC14.48)", () => {
    const root = tempProject();
    const args = buildPmExactAddArgs("pnpm", "1.2.3", root);
    expect(args).toContain("-D");
    expect(args).toContain("--save-exact");
    // pnpm equivalent of npm --include=dev under NODE_ENV=production
    expect(args).toContain("--config.production=false");
  });

  it("pnpm workspace root plan and argv include -w", () => {
    const root = tempProject();
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    expect(isPnpmWorkspaceRoot(root)).toBe(true);
    const args = buildPmExactAddArgs("pnpm", "1.2.3", root);
    expect(args).toContain("-w");
    expect(formatPmExactAddCommand("pnpm", "1.2.3", root)).toMatch(
      /pnpm add -D --save-exact --ignore-scripts --config\.production=false -w /,
    );
    const c = capture();
    const code = runInstall(
      root,
      stateFor(root),
      ["--dry-run", "--package-manager", "pnpm", "--target-version", "1.2.3"],
      "0.0.0-test",
      c.io,
    );
    expect(code).toBe(0);
    expect(c.out()).toMatch(/pnpm add -D --save-exact --ignore-scripts --config\.production=false -w /);
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

describe("interactive approval + Repair/Cancel menu (UX-INT / AC5.2 / AC6.4 / AC14.1 / AC14.39)", () => {
  function pinExact(root: string, version = "1.2.3"): void {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      devDependencies?: Record<string, string>;
    };
    pkg.devDependencies = { ...(pkg.devDependencies ?? {}), "@deftai/directive-runtime": version };
    writeFileSync(join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  }

  function writeInstalledRuntime(root: string, version: string): void {
    const nm = join(root, "node_modules", "@deftai", "directive-runtime");
    mkdirSync(nm, { recursive: true });
    writeFileSync(
      join(nm, "package.json"),
      `${JSON.stringify(
        { name: "@deftai/directive-runtime", version, directive: { contract: 1 } },
        null,
        2,
      )}\n`,
    );
    mkdirSync(join(nm, "dist"), { recursive: true });
    writeFileSync(join(nm, "dist", "bin.js"), "#!/usr/bin/env node\nprocess.exit(0);\n");
  }

  function writeGeneration(root: string): void {
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(
      join(root, ".deft", "GENERATION.json"),
      `${JSON.stringify({ runtimeVersion: "1.2.3", contract: 1 }, null, 2)}\n`,
    );
  }

  it("first-install decline → Cancelled message, exit 0, no PM (AC14.39)", () => {
    const root = tempProject("wave2m-decline");
    const before = readFileSync(join(root, "package.json"), "utf8");
    const c = capture();
    let pmCalled = false;
    let confirmPrompt: string | null = null;
    const code = runInstall(
      root,
      stateFor(root),
      ["--target-version", "1.2.3"],
      "0.0.0-test",
      c.io,
      {
        stdinIsTTY: true,
        confirm: (prompt) => {
          confirmPrompt = prompt;
          return false;
        },
        runPmAdd: () => {
          pmCalled = true;
          return { ok: true as const };
        },
        invokeSetup: () => {
          throw new Error("setup must not run after cancel");
        },
      },
    );
    expect(code).toBe(0);
    expect(pmCalled).toBe(false);
    expect(confirmPrompt).toMatch(/Set up Directive in this project\?/i);
    const text = c.out() + c.err();
    expect(text).toMatch(/\[y\/N\]/);
    expect(text).toContain("Cancelled. No project files were changed.");
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(before);
  });

  it("first-install approve via confirm proceeds to PM + setup (AC5.2)", () => {
    const root = tempProject("wave2m-approve");
    const c = capture();
    let pmCalled = false;
    let setupOp: string | null = null;
    const code = runInstall(
      root,
      stateFor(root),
      ["--target-version", "1.2.3"],
      "0.0.0-test",
      c.io,
      {
        stdinIsTTY: true,
        confirm: () => true,
        runPmAdd: ({ projectRoot, version }) => {
          pmCalled = true;
          const pkgPath = join(projectRoot, "package.json");
          const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
            devDependencies?: Record<string, string>;
          };
          pkg.devDependencies = {
            ...(pkg.devDependencies ?? {}),
            "@deftai/directive-runtime": version,
          };
          writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
          writeInstalledRuntime(projectRoot, version);
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
    expect(setupOp).toBe("install");
    expect(c.out() + c.err()).not.toContain("Cancelled. No project files were changed.");
  });

  it("configured interactive Cancel → Cancelled, exit 0, no repair (AC6.4 / AC14.39)", () => {
    const root = tempProject("wave2m-menu-cancel");
    pinExact(root, "1.2.3");
    writeInstalledRuntime(root, "1.2.3");
    writeGeneration(root);
    const before = readFileSync(join(root, "package.json"), "utf8");
    const c = capture();
    let menuDefault: string | null = null;
    let pmCalled = false;
    const code = runInstall(root, stateFor(root), [], "0.0.0-test", c.io, {
      stdinIsTTY: true,
      chooseMenu: (opts) => {
        menuDefault = opts.defaultChoice;
        return "cancel";
      },
      runPmAdd: () => {
        pmCalled = true;
        return { ok: true as const };
      },
      invokeSetup: () => {
        throw new Error("setup must not run after menu cancel");
      },
    });
    expect(code).toBe(0);
    expect(pmCalled).toBe(false);
    expect(menuDefault).toBe("cancel");
    const text = c.out() + c.err();
    expect(text).toMatch(/already configured/i);
    expect(text).toMatch(/Repair 1\.2\.3/);
    expect(text).toMatch(/Cancel/);
    expect(text).toContain("Cancelled. No project files were changed.");
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(before);
  });

  it("fresh-clone shape (pin, no node_modules) defaults menu to Repair (AC14.1 / INIT-15)", () => {
    const root = tempProject("wave2m-fresh-clone");
    pinExact(root, "1.2.3");
    writeGeneration(root); // travels with clone; installed package does not
    const c = capture();
    let menuDefault: string | null = null;
    let repairConfirmSeen = false;
    let setupOp: string | null = null;
    const code = runInstall(root, stateFor(root), [], "0.0.0-test", c.io, {
      stdinIsTTY: true,
      chooseMenu: (opts) => {
        menuDefault = opts.defaultChoice;
        expect(opts.pinVersion).toBe("1.2.3");
        return "repair";
      },
      confirm: (prompt) => {
        repairConfirmSeen = /Repair Directive 1\.2\.3/i.test(prompt);
        return true;
      },
      runPmAdd: ({ projectRoot, version }) => {
        writeInstalledRuntime(projectRoot, version);
        writeFileSync(
          join(projectRoot, "package-lock.json"),
          `${JSON.stringify(
            {
              lockfileVersion: 3,
              packages: {
                "": { name: "t", devDependencies: { "@deftai/directive-runtime": version } },
                "node_modules/@deftai/directive-runtime": { version },
              },
            },
            null,
            2,
          )}\n`,
        );
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
    expect(menuDefault).toBe("repair");
    expect(repairConfirmSeen).toBe(true);
    expect(setupOp).toBe("repair");
    expect(code).toBe(0);
  });

  it("healthy configured project defaults menu to Cancel (INIT-15 / INIT-16)", () => {
    const root = tempProject("wave2m-healthy-default");
    pinExact(root, "2.0.0");
    writeInstalledRuntime(root, "2.0.0");
    writeGeneration(root);
    const c = capture();
    let menuDefault: string | null = null;
    const code = runInstall(root, stateFor(root), [], "0.0.0-test", c.io, {
      stdinIsTTY: true,
      chooseMenu: (opts) => {
        menuDefault = opts.defaultChoice;
        return "cancel";
      },
    });
    expect(code).toBe(0);
    expect(menuDefault).toBe("cancel");
  });

  it("menu Repair then approval decline → Cancelled, exit 0", () => {
    const root = tempProject("wave2m-repair-decline");
    pinExact(root, "1.2.3");
    const before = readFileSync(join(root, "package.json"), "utf8");
    const c = capture();
    let pmCalled = false;
    const code = runInstall(root, stateFor(root), [], "0.0.0-test", c.io, {
      stdinIsTTY: true,
      chooseMenu: () => "repair",
      confirm: () => false,
      runPmAdd: () => {
        pmCalled = true;
        return { ok: true as const };
      },
    });
    expect(code).toBe(0);
    expect(pmCalled).toBe(false);
    expect(c.out() + c.err()).toContain("Cancelled. No project files were changed.");
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(before);
  });

  it("--yes still skips interactive confirm (AC5.3)", () => {
    const root = tempProject("wave2m-yes-skip");
    const c = capture();
    let confirmCalled = false;
    let pmCalled = false;
    const code = runInstall(
      root,
      stateFor(root),
      ["--yes", "--target-version", "1.2.3"],
      "0.0.0-test",
      c.io,
      {
        stdinIsTTY: true,
        confirm: () => {
          confirmCalled = true;
          return false;
        },
        runPmAdd: ({ projectRoot, version }) => {
          pmCalled = true;
          const pkgPath = join(projectRoot, "package.json");
          const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
            devDependencies?: Record<string, string>;
          };
          pkg.devDependencies = {
            ...(pkg.devDependencies ?? {}),
            "@deftai/directive-runtime": version,
          };
          writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
          writeInstalledRuntime(projectRoot, version);
          return { ok: true as const };
        },
        invokeSetup: () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            contract: 1,
            entry: "setup",
            created: [],
            modified: [],
            removed: [],
            conflicts: [],
          }),
          stderr: "",
          spawned: true,
          message: null,
        }),
      },
    );
    expect(code).toBe(0);
    expect(confirmCalled).toBe(false);
    expect(pmCalled).toBe(true);
  });

  it("--dry-run never prompts for approval (AC5.4)", () => {
    const root = tempProject("wave2m-dry");
    const c = capture();
    let confirmCalled = false;
    const code = runInstall(
      root,
      stateFor(root),
      ["--dry-run", "--target-version", "1.2.3"],
      "0.0.0-test",
      c.io,
      {
        stdinIsTTY: true,
        confirm: () => {
          confirmCalled = true;
          return true;
        },
      },
    );
    expect(code).toBe(0);
    expect(confirmCalled).toBe(false);
    expect(c.out()).toMatch(/dry-run/i);
  });
});
