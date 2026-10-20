/**
 * Owner-boundary tests for Wave 2f / R10 / AC10.1–10.6 / AC10.9 (launcher side).
 * Latest supported legacy: exact pre-split @deftai/directive pin + copied-core evidence.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runUpgrade } from "./bookends.js";
import { LAUNCHER_PACKAGE_NAME, RUNTIME_PACKAGE_NAME } from "./constants.js";
import { runLauncher } from "./launcher.js";
import { readPin, readProjectInstallState } from "./pin.js";

const TEMPS: string[] = [];

function tempProject(name = "wave2f"): string {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  TEMPS.push(root);
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "legacy-t", version: "0.0.0", private: true }, null, 2)}\n`,
  );
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
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

/** Real installation evidence — not directory existence alone (AC10.1). */
function writeCopiedCoreEvidence(root: string, opts?: { edited?: boolean }): void {
  const core = join(root, ".deft", "core");
  mkdirSync(core, { recursive: true });
  writeFileSync(
    join(core, "VERSION"),
    [
      "ref: 'v0.119.2'",
      "sha: 'content-package'",
      "tag: 'v0.119.2'",
      "install_root: '.deft/core'",
      "fetched_at: '2026-09-17T20:29:29Z'",
      "fetched_by: 'directive-update'",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(core, "package.json"),
    `${JSON.stringify(
      {
        name: "@deftai/directive-content",
        version: "0.119.2",
        deftConsumerDeposit: true,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(core, "main.md"),
    opts?.edited ? "# locally edited core main\nKEEP-EDIT-MARKER\n" : "# deposited main\n",
  );
}

function pinLegacyExact(root: string, version = "0.119.2"): void {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<
    string,
    unknown
  >;
  pkg.devDependencies = { [LAUNCHER_PACKAGE_NAME]: version };
  writeFileSync(join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
}

function writeLegacyGeneration(root: string, generation = 1): void {
  mkdirSync(join(root, ".deft"), { recursive: true });
  writeFileSync(
    join(root, ".deft", "GENERATION.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generation,
        contentVersion: "0.119.2",
        stampedAt: "2026-09-17T20:29:29Z",
        stampedBy: "directive-update",
        surfaces: { payload: "0.119.2" },
      },
      null,
      2,
    )}\n`,
  );
}

function writePreservedData(root: string): void {
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(join(root, "xbrief", "USER-NOTE.txt"), "preserve-me\n");
  writeFileSync(join(root, "xbrief", ".deft-version"), "0.119.2\n");
  mkdirSync(join(root, ".deft"), { recursive: true });
  writeFileSync(
    join(root, ".deft", "settings.json"),
    `${JSON.stringify({ theme: "legacy-keep" }, null, 2)}\n`,
  );
  writeFileSync(join(root, "AGENTS.md"), "# Project\n\nFollow `.deft/core/main.md`.\n");
}

function installFakeRuntime(root: string, version: string): void {
  const nm = join(root, "node_modules", "@deftai", "directive-runtime");
  mkdirSync(nm, { recursive: true });
  writeFileSync(
    join(nm, "package.json"),
    `${JSON.stringify(
      { name: RUNTIME_PACKAGE_NAME, version, directive: { contract: 1 } },
      null,
      2,
    )}\n`,
  );
  mkdirSync(join(nm, "dist"), { recursive: true });
  writeFileSync(join(nm, "dist", "bin.js"), "#!/usr/bin/env node\nprocess.exit(0);\n");
  writeFileSync(
    join(root, "package-lock.json"),
    `${JSON.stringify(
      {
        lockfileVersion: 3,
        packages: {
          "": { name: "legacy-t", devDependencies: { [RUNTIME_PACKAGE_NAME]: version } },
          [`node_modules/${RUNTIME_PACKAGE_NAME}`]: { version },
        },
      },
      null,
      2,
    )}\n`,
  );
}

afterEach(() => {
  while (TEMPS.length > 0) {
    const p = TEMPS.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

describe("AC10.1 legacy detection (exact pin + copied-core evidence)", () => {
  it("recognises exact pre-split pin with VERSION/main/deposit evidence as oldStyle", () => {
    const root = tempProject();
    pinLegacyExact(root);
    writeCopiedCoreEvidence(root);
    writeLegacyGeneration(root, 3);
    const pin = readPin(root);
    expect(pin.oldStyle).toBe(true);
    expect(pin.kind).toBe("exact");
    expect(pin.version).toBe("0.119.2");
    expect(readProjectInstallState(root).oldStyle).toBe(true);
  });

  it("exact pin alone without copied-core evidence is NOT oldStyle", () => {
    const root = tempProject();
    pinLegacyExact(root);
    expect(readPin(root).oldStyle).toBe(false);
  });

  it("empty .deft/core directory alone is NOT oldStyle", () => {
    const root = tempProject();
    pinLegacyExact(root);
    mkdirSync(join(root, ".deft", "core"), { recursive: true });
    expect(readPin(root).oldStyle).toBe(false);
  });

  it(".deft/core evidence without pre-split pin is NOT oldStyle", () => {
    const root = tempProject();
    writeCopiedCoreEvidence(root);
    expect(readPin(root).oldStyle).toBe(false);
  });

  it("runtime pin wins over leftover legacy dep (not oldStyle)", () => {
    const root = tempProject();
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    pkg.devDependencies = {
      [LAUNCHER_PACKAGE_NAME]: "0.119.2",
      [RUNTIME_PACKAGE_NAME]: "1.2.3",
    };
    writeFileSync(join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    writeCopiedCoreEvidence(root);
    const pin = readPin(root);
    expect(pin.oldStyle).toBe(false);
    expect(pin.version).toBe("1.2.3");
  });

  it("ranged @deftai/directive pin is NOT supported oldStyle", () => {
    const root = tempProject();
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    pkg.devDependencies = { [LAUNCHER_PACKAGE_NAME]: "^0.119.2" };
    writeFileSync(join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    writeCopiedCoreEvidence(root);
    expect(readPin(root).oldStyle).toBe(false);
  });

  it("hand-added launcher dep alone is not an OVPR pin (AC14.51)", () => {
    const root = tempProject();
    pinLegacyExact(root, "0.200.0");
    const pin = readPin(root);
    expect(pin.oldStyle).toBe(false);
    expect(pin.kind).toBe("none");
    expect(pin.raw).toBeNull();
    expect(pin.version).toBeNull();
    expect(readProjectInstallState(root).pin.kind).toBe("none");
  });

  it("ranged launcher dep even with copied-core is not a configured OVPR pin (AC14.51)", () => {
    const root = tempProject();
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    pkg.devDependencies = { [LAUNCHER_PACKAGE_NAME]: "^0.119.2" };
    writeFileSync(join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    writeCopiedCoreEvidence(root);
    const pin = readPin(root);
    expect(pin.oldStyle).toBe(false);
    expect(pin.kind).toBe("none");
  });
});

describe("AC10.2 old-style command gate", () => {
  function legacyRoot(): string {
    const root = tempProject("gate");
    pinLegacyExact(root);
    writeCopiedCoreEvidence(root);
    writeLegacyGeneration(root);
    return root;
  }

  it("install / doctor / ordinary commands exit nonzero naming directive upgrade", () => {
    const root = legacyRoot();
    for (const argv of [
      ["install", "--root", root],
      ["doctor", "--root", root],
      ["check", "--root", root],
    ]) {
      const c = capture();
      const code = runLauncher(argv, c.io);
      expect(code, argv.join(" ")).not.toBe(0);
      expect(c.err() + c.out(), argv.join(" ")).toMatch(/directive upgrade/);
    }
  });

  it("--version and --help still succeed", () => {
    const root = legacyRoot();
    const v = capture();
    expect(runLauncher(["--version", "--root", root], v.io)).toBe(0);
    expect(v.out()).toMatch(/older layout|upgrade/i);
    const h = capture();
    expect(runLauncher(["--help", "--root", root], h.io)).toBe(0);
    expect(h.out()).toMatch(/install/);
  });

  it("uninstall is allowed through the gate", () => {
    const root = legacyRoot();
    const un = capture();
    expect(runLauncher(["uninstall", "--dry-run", "--root", root], un.io)).toBe(0);
  });
});

describe("AC10.3 launcher upgrade conversion (pin replace + handoff)", () => {
  it("dry-run plan discloses old-style conversion and .deft/core removal", () => {
    const root = tempProject("conv-dry");
    pinLegacyExact(root);
    writeCopiedCoreEvidence(root, { edited: true });
    writeLegacyGeneration(root, 2);
    writePreservedData(root);
    const state = readProjectInstallState(root);
    expect(state.oldStyle).toBe(true);
    const c = capture();
    const code = runUpgrade(
      root,
      state,
      ["--dry-run", "--target-version", "9.9.9"],
      "0.0.0-test",
      c.io,
      {
        resolvePublishedContract: () => ({ ok: true, contract: 1 }),
        runPmAdd: () => ({ ok: true }),
        invokeSetup: () => ({ exitCode: 0, stdout: "{}", stderr: "", message: null }),
        invokeMigrate: () => ({ exitCode: 0, stdout: "{}", stderr: "", message: null }),
      },
    );
    expect(code).toBe(0);
    const text = c.out() + c.err();
    expect(text).toMatch(/older Directive layout/);
    expect(text).toMatch(/\.deft\/core/);
    expect(text).toMatch(/switch the project to Directive/);
    expect(text).toMatch(/\[dry-run\]/);
    expect(text).not.toMatch(/Install command:/);
    expect(existsSync(join(root, ".deft", "core", "VERSION"))).toBe(true);
    expect(readFileSync(join(root, "xbrief", "USER-NOTE.txt"), "utf8")).toBe("preserve-me\n");
  });

  it("upgrade --yes removes legacy pin, adds runtime pin, hands off setup/migrate from old-style", () => {
    const root = tempProject("conv-yes");
    pinLegacyExact(root, "0.119.2");
    // Seed retired triad so convert must PM-remove them before add (wave4e lockfile).
    const seeded = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    seeded.dependencies = {
      ...(seeded.dependencies ?? {}),
      "@deftai/directive-core": "0.119.2",
      "@deftai/directive-content": "0.119.2",
      "@deftai/directive-types": "0.119.2",
    };
    writeFileSync(join(root, "package.json"), `${JSON.stringify(seeded, null, 2)}\n`);
    writeCopiedCoreEvidence(root, { edited: true });
    writeLegacyGeneration(root, 4);
    writePreservedData(root);

    const state = readProjectInstallState(root);
    const c = capture();
    let setupFrom: string | null = null;
    let migrateFrom: string | null = null;
    let pmAddCalled = false;
    const pmRemoved: string[] = [];

    const code = runUpgrade(
      root,
      state,
      ["--yes", "--target-version", "9.9.9"],
      "0.0.0-test",
      c.io,
      {
        resolvePublishedContract: () => ({ ok: true, contract: 1 }),
        runPmRemove: ({ packageName }) => {
          pmRemoved.push(packageName);
          return { ok: true };
        },
        runPmAdd: ({ version }) => {
          pmAddCalled = true;
          // After launcher strips legacy pin, simulate PM adding runtime.
          const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
            optionalDependencies?: Record<string, string>;
          };
          // Legacy pin + triad must already be gone before PM add returns.
          for (const key of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
            const block = pkg[key];
            if (block) {
              expect(block[LAUNCHER_PACKAGE_NAME]).toBeUndefined();
              expect(block["@deftai/directive-core"]).toBeUndefined();
              expect(block["@deftai/directive-content"]).toBeUndefined();
              expect(block["@deftai/directive-types"]).toBeUndefined();
            }
          }
          pkg.devDependencies = {
            ...(pkg.devDependencies ?? {}),
            [RUNTIME_PACKAGE_NAME]: version,
          };
          writeFileSync(join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
          installFakeRuntime(root, version);
          return { ok: true };
        },
        invokeSetup: (argv) => {
          const fromIdx = argv.indexOf("--from");
          setupFrom = fromIdx >= 0 ? String(argv[fromIdx + 1]) : null;
          // Leave core in place here — runtime setup owns removal (tested separately).
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              contract: 1,
              entry: "setup",
              removed: [".deft/core"],
              created: [],
              modified: [".deft/GENERATION.json"],
              conflicts: [],
            }),
            stderr: "",
            message: null,
          };
        },
        invokeMigrate: (argv) => {
          const fromIdx = argv.indexOf("--from");
          migrateFrom = fromIdx >= 0 ? String(argv[fromIdx + 1]) : null;
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              contract: 1,
              entry: "migrate",
              migrated: [".deft/directive/data-schema.json"],
            }),
            stderr: "",
            message: null,
          };
        },
      },
    );

    expect(code).toBe(0);
    expect(pmAddCalled).toBe(true);
    expect(setupFrom).toBe("old-style");
    expect(migrateFrom).toBe("old-style");
    expect(pmRemoved).toEqual(
      expect.arrayContaining([
        LAUNCHER_PACKAGE_NAME,
        "@deftai/directive-core",
        "@deftai/directive-content",
        "@deftai/directive-types",
      ]),
    );

    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      devDependencies?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(deps[RUNTIME_PACKAGE_NAME]).toBe("9.9.9");
    expect(deps[LAUNCHER_PACKAGE_NAME]).toBeUndefined();
    expect(deps["@deftai/directive-core"]).toBeUndefined();

    // Settings/data untouched by launcher bookend itself
    expect(readFileSync(join(root, "xbrief", "USER-NOTE.txt"), "utf8")).toBe("preserve-me\n");
    expect(readFileSync(join(root, ".deft", "settings.json"), "utf8")).toMatch(/legacy-keep/);
    expect(c.out()).toMatch(/\.deft\/core/);
  });
});
