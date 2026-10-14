/**
 * Wave 3b/3d/3f owner-boundary tests — L2 shape registry (detect → shape_id → decision).
 * WAVE3-V2 (3f): convert-via-removals upgrade/install succeeds (strategy → pin → setup).
 * Survey shape_ids from specs/5490-wave3-historical-survey.md; L0 paths stay thin.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInstall, runUpgrade } from "../bookends.js";
import { LAUNCHER_PACKAGE_NAME, RUNTIME_PACKAGE_NAME } from "../constants.js";
import { readPin, readProjectInstallState } from "../pin.js";
import {
  DECISION_BY_SHAPE_ID,
  decisionForShapeId,
  formatShapeRecoveryMessage,
  isL2RefusalDecision,
  resolveInstallShape,
  type RecoveryDecision,
  type SurveyShapeId,
} from "./index.js";

const TEMPS: string[] = [];

afterEach(() => {
  while (TEMPS.length > 0) {
    const root = TEMPS.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function tempProject(name = "wave3b-shape"): string {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  TEMPS.push(root);
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "shape-t", version: "0.0.0", private: true }, null, 2)}\n`,
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
    text: () => `${out.join("")}${err.join("")}`,
  };
}

function writeCopiedCoreEvidence(root: string): void {
  const core = join(root, ".deft", "core");
  mkdirSync(core, { recursive: true });
  writeFileSync(join(core, "VERSION"), "ref: 'v0.40.0'\ninstall_root: '.deft/core'\n");
  writeFileSync(
    join(core, "package.json"),
    `${JSON.stringify(
      { name: "@deftai/directive-content", version: "0.40.0", deftConsumerDeposit: true },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(core, "main.md"), "# deposited main\n");
}

function pinLegacyExact(root: string, version = "0.119.2"): void {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<
    string,
    unknown
  >;
  pkg.devDependencies = { [LAUNCHER_PACKAGE_NAME]: version };
  writeFileSync(join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
}

function pinRuntimeExact(root: string, version = "1.2.3"): void {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<
    string,
    unknown
  >;
  pkg.devDependencies = { [RUNTIME_PACKAGE_NAME]: version };
  writeFileSync(join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
}

function writeGoTarballDeft(root: string): void {
  const deft = join(root, "deft");
  mkdirSync(deft, { recursive: true });
  writeFileSync(join(deft, "main.md"), "# legacy deft root\n");
  writeFileSync(join(deft, "VERSION"), "0.25.0\n");
}

function writeSubmoduleDeft(root: string): void {
  writeGoTarballDeft(root);
  // File-form gitlink used by submodules.
  writeFileSync(join(root, "deft", ".git"), "gitdir: ../.git/modules/deft\n");
}

describe("L2 shape registry — WAVE3-V2 convert-via-removals lean", () => {
  const expected: ReadonlyArray<readonly [SurveyShapeId, RecoveryDecision]> = [
    ["ovpr-runtime-pin", "l0-current"],
    ["npm-hybrid-pin-copied-core", "l0-latest-legacy-convert"],
    ["go-tarball-deft-root", "convert-via-removals"],
    ["submodule-deft", "convert-via-removals"],
    ["vendored-core-go", "convert-via-removals"],
    ["dual-layout-deft-and-core", "convert-via-removals"],
    ["orphan-deft-version", "convert-via-removals"],
  ];

  it("maps every wired survey shape_id to the WAVE3-V2 lean decision", () => {
    for (const [shapeId, decision] of expected) {
      expect(decisionForShapeId(shapeId)).toBe(decision);
      expect(DECISION_BY_SHAPE_ID[shapeId]).toBe(decision);
    }
  });

  it("recovery enum includes convert-via-removals (L2 long-term path)", () => {
    const allowed = new Set<RecoveryDecision>([
      "l0-current",
      "l0-latest-legacy-convert",
      "convert-via-removals",
      "uninstall-reinstall",
      "unsupported-honest",
    ]);
    for (const decision of Object.values(DECISION_BY_SHAPE_ID)) {
      expect(allowed.has(decision)).toBe(true);
    }
    expect(decisionForShapeId("go-tarball-deft-root")).toBe("convert-via-removals");
    expect(decisionForShapeId("vendored-core-go")).toBe("convert-via-removals");
    expect(decisionForShapeId("orphan-deft-version")).toBe("convert-via-removals");
    expect(decisionForShapeId("go-tarball-deft-root")).not.toBe("uninstall-reinstall");
  });
});

describe("L2 thin detect → shape_id (reuses pin + legacy fingerprints)", () => {
  it("ovpr-runtime-pin: exact runtime pin → l0-current", () => {
    const root = tempProject();
    pinRuntimeExact(root);
    const resolved = resolveInstallShape(root);
    expect(resolved).not.toBeNull();
    expect(resolved!.shapeId).toBe("ovpr-runtime-pin");
    expect(resolved!.decision).toBe("l0-current");
    expect(readPin(root).oldStyle).toBe(false);
  });

  it("npm-hybrid-pin-copied-core: oldStyle → l0-latest-legacy-convert", () => {
    const root = tempProject();
    pinLegacyExact(root);
    writeCopiedCoreEvidence(root);
    expect(readProjectInstallState(root).oldStyle).toBe(true);
    const resolved = resolveInstallShape(root);
    expect(resolved).not.toBeNull();
    expect(resolved!.shapeId).toBe("npm-hybrid-pin-copied-core");
    expect(resolved!.decision).toBe("l0-latest-legacy-convert");
  });

  it("vendored-core-go: copied core, no exact pin → convert-via-removals", () => {
    const root = tempProject();
    writeCopiedCoreEvidence(root);
    expect(readPin(root).oldStyle).toBe(false);
    const resolved = resolveInstallShape(root);
    expect(resolved).not.toBeNull();
    expect(resolved!.shapeId).toBe("vendored-core-go");
    expect(resolved!.decision).toBe("convert-via-removals");
  });

  it("go-tarball-deft-root / legacy-deft-prefixed → convert-via-removals", () => {
    const root = tempProject();
    writeGoTarballDeft(root);
    const resolved = resolveInstallShape(root);
    expect(resolved).not.toBeNull();
    expect(resolved!.shapeId).toBe("go-tarball-deft-root");
    expect(resolved!.decision).toBe("convert-via-removals");
  });

  it("submodule-deft → convert-via-removals", () => {
    const root = tempProject();
    writeSubmoduleDeft(root);
    const resolved = resolveInstallShape(root);
    expect(resolved).not.toBeNull();
    expect(resolved!.shapeId).toBe("submodule-deft");
    expect(resolved!.decision).toBe("convert-via-removals");
  });

  it("orphan-deft-version → convert-via-removals", () => {
    const root = tempProject();
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(join(root, ".deft", "VERSION"), "orphan\n");
    expect(existsSync(join(root, ".deft", "core"))).toBe(false);
    const resolved = resolveInstallShape(root);
    expect(resolved).not.toBeNull();
    expect(resolved!.shapeId).toBe("orphan-deft-version");
    expect(resolved!.decision).toBe("convert-via-removals");
  });

  it("dual-layout-deft-and-core → convert-via-removals", () => {
    const root = tempProject();
    writeCopiedCoreEvidence(root);
    writeGoTarballDeft(root);
    const resolved = resolveInstallShape(root);
    expect(resolved).not.toBeNull();
    expect(resolved!.shapeId).toBe("dual-layout-deft-and-core");
    expect(resolved!.decision).toBe("convert-via-removals");
  });

  it("greenfield (no footprint) → null (not a historical shape)", () => {
    const root = tempProject();
    expect(resolveInstallShape(root)).toBeNull();
  });

  it("runtime pin wins over leftover copied core (L0, not vendored-core-go)", () => {
    const root = tempProject();
    pinRuntimeExact(root);
    writeCopiedCoreEvidence(root);
    const resolved = resolveInstallShape(root);
    expect(resolved!.shapeId).toBe("ovpr-runtime-pin");
    expect(resolved!.decision).toBe("l0-current");
  });
});

describe("L2 dispatch messaging (convert vs unsupported)", () => {
  it("convert-via-removals is not an L2 refusal decision", () => {
    expect(isL2RefusalDecision("convert-via-removals")).toBe(false);
    expect(isL2RefusalDecision("unsupported-honest")).toBe(true);
    expect(isL2RefusalDecision("uninstall-reinstall")).toBe(true);
    const msg = formatShapeRecoveryMessage(
      {
        shapeId: "go-tarball-deft-root",
        decision: "convert-via-removals",
        evidence: ["deft/"],
      },
      "upgrade",
    );
    expect(msg).toMatch(/go-tarball-deft-root/);
    expect(msg).not.toMatch(/`directive uninstall` then `directive install`/);
  });

  it("unsupported-honest message does not invent convert or upgrade", () => {
    const msg = formatShapeRecoveryMessage(
      {
        shapeId: "submodule-deft",
        decision: "unsupported-honest",
        evidence: ["deft/", "gitlink mode 160000"],
      },
      "upgrade",
    );
    expect(msg).toMatch(/submodule-deft/);
    expect(msg).toMatch(/unsupported|not supported|automatic recovery/i);
    expect(msg).not.toMatch(/Run `directive upgrade`/);
  });
});

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
          "": { name: "shape-t", devDependencies: { [RUNTIME_PACKAGE_NAME]: version } },
          [`node_modules/${RUNTIME_PACKAGE_NAME}`]: { version },
        },
      },
      null,
      2,
    )}\n`,
  );
}

function convertDeps(root: string, expectedFrom: string) {
  let setupFrom: string | null = null;
  let migrateFrom: string | null = null;
  return {
    get setupFrom() {
      return setupFrom;
    },
    get migrateFrom() {
      return migrateFrom;
    },
    deps: {
      resolvePublishedContract: () => ({ ok: true as const, contract: 1 }),
      runPmAdd: ({ version }: { version: string }) => {
        const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
          devDependencies?: Record<string, string>;
        };
        pkg.devDependencies = {
          ...(pkg.devDependencies ?? {}),
          [RUNTIME_PACKAGE_NAME]: version,
        };
        writeFileSync(join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
        installFakeRuntime(root, version);
        return { ok: true as const };
      },
      invokeSetup: (argv: readonly string[]) => {
        const fromIdx = argv.indexOf("--from");
        setupFrom = fromIdx >= 0 ? String(argv[fromIdx + 1]) : null;
        expect(setupFrom).toBe(expectedFrom);
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            contract: 1,
            entry: "setup",
            removed: [],
            created: [".deft/GENERATION.json"],
            modified: [],
            conflicts: [],
          }),
          stderr: "",
          message: null,
        };
      },
      invokeMigrate: (argv: readonly string[]) => {
        const fromIdx = argv.indexOf("--from");
        migrateFrom = fromIdx >= 0 ? String(argv[fromIdx + 1]) : null;
        return {
          exitCode: 0,
          stdout: JSON.stringify({ contract: 1, entry: "migrate", migrated: [] }),
          stderr: "",
          message: null,
        };
      },
    },
  };
}

describe("bookend seam — L0 oldStyle unchanged; unsupported still refuses", () => {
  it("install on oldStyle still names upgrade (L0 convert path unchanged)", () => {
    const root = tempProject();
    pinLegacyExact(root);
    writeCopiedCoreEvidence(root);
    expect(readProjectInstallState(root).oldStyle).toBe(true);
    const c = capture();
    const code = runInstall(root, readProjectInstallState(root), ["--yes"], "0.0.0-test", c.io);
    expect(code).toBe(1);
    expect(c.text()).toMatch(/directive upgrade/i);
    expect(c.text()).not.toMatch(/uninstall then install|uninstall` then/i);
  });

  it("upgrade refuses unsupported-honest submodule (gitlink residual messaging)", () => {
    // Simulate detect override: unsupported decision path via format + isL2Refusal.
    expect(isL2RefusalDecision("unsupported-honest")).toBe(true);
    const msg = formatShapeRecoveryMessage(
      {
        shapeId: "submodule-deft",
        decision: "unsupported-honest",
        evidence: ["gitlink mode 160000"],
      },
      "upgrade",
    );
    expect(msg).toMatch(/unsupported/i);
  });
});

/**
 * WAVE3-V2 3f: upgrade --yes converts surveyed layouts without dump-out refuse.
 */
describe("WAVE3-V2 upgrade-convert path (era fixtures)", () => {
  it("upgrade on go-tarball-deft-root converts (not refuse)", () => {
    const root = tempProject("wave3f-go");
    writeGoTarballDeft(root);
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(join(root, "xbrief", "keep.txt"), "user-xbrief\n");
    const c = capture();
    const harness = convertDeps(root, "go-tarball-deft-root");
    const code = runUpgrade(
      root,
      readProjectInstallState(root),
      ["--yes", "--target-version", "9.9.9"],
      "0.0.0-test",
      c.io,
      harness.deps,
    );
    expect(code).toBe(0);
    expect(c.text()).not.toMatch(/`directive uninstall` then `directive install`/);
    expect(c.text()).toMatch(/go-tarball-deft-root/);
    expect(harness.setupFrom).toBe("go-tarball-deft-root");
    expect(harness.migrateFrom).toBe("go-tarball-deft-root");
    expect(readFileSync(join(root, "xbrief", "keep.txt"), "utf8")).toBe("user-xbrief\n");
    expect(decisionForShapeId("go-tarball-deft-root")).toBe("convert-via-removals");
  });

  it("upgrade on vendored-core-go converts (not refuse)", () => {
    const root = tempProject("wave3f-vendored");
    writeCopiedCoreEvidence(root);
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(join(root, "xbrief", "keep.txt"), "preserve\n");
    const c = capture();
    const harness = convertDeps(root, "vendored-core-go");
    const code = runUpgrade(
      root,
      readProjectInstallState(root),
      ["--yes", "--target-version", "9.9.9"],
      "0.0.0-test",
      c.io,
      harness.deps,
    );
    expect(code).toBe(0);
    expect(c.text()).not.toMatch(/Until then, run `directive uninstall`/);
    expect(c.text()).toMatch(/vendored-core-go/);
    expect(harness.setupFrom).toBe("vendored-core-go");
    expect(readFileSync(join(root, "xbrief", "keep.txt"), "utf8")).toBe("preserve\n");
  });

  it("F-016: vendored-core-go with no root package.json keeps ensurePackageJson + exact pin", () => {
    // Greenfield-ish legacy: .deft/core evidence, no package.json. Bookend creates
    // {private:true} then PM pins runtime — end state must retain that pin.
    const root = mkdtempSync(join(tmpdir(), "wave3k-f016-nopkg-"));
    TEMPS.push(root);
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeCopiedCoreEvidence(root);
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(join(root, "xbrief", "keep.txt"), "xbrief-keep\n");
    expect(existsSync(join(root, "package.json"))).toBe(false);

    const c = capture();
    const harness = convertDeps(root, "vendored-core-go");
    const code = runUpgrade(
      root,
      readProjectInstallState(root),
      ["--yes", "--target-version", "9.9.9"],
      "0.0.0-test",
      c.io,
      harness.deps,
    );
    expect(code).toBe(0);
    expect(harness.setupFrom).toBe("vendored-core-go");
    expect(existsSync(join(root, "package.json"))).toBe(true);
    const pin = readPin(root);
    expect(pin.kind).toBe("exact");
    expect(pin.version).toBe("9.9.9");
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      private?: boolean;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.private).toBe(true);
    expect(pkg.devDependencies?.[RUNTIME_PACKAGE_NAME]).toBe("9.9.9");
    expect(readFileSync(join(root, "xbrief", "keep.txt"), "utf8")).toBe("xbrief-keep\n");
    expect(c.text()).not.toMatch(/lost package\.json|lost runtime pin/i);
  });

  it("F-016: convert upgrade fails closed when setup deletes package.json (no false success)", () => {
    const root = tempProject("wave3k-f016-brace");
    writeCopiedCoreEvidence(root);
    const c = capture();
    let setupFrom: string | null = null;
    const code = runUpgrade(
      root,
      readProjectInstallState(root),
      ["--yes", "--target-version", "9.9.9"],
      "0.0.0-test",
      c.io,
      {
        resolvePublishedContract: () => ({ ok: true as const, contract: 1 }),
        runPmAdd: ({ version }: { version: string }) => {
          const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
            private?: boolean;
            devDependencies?: Record<string, string>;
          };
          // Simulate ensurePackageJson-shaped sole-author residue.
          writeFileSync(
            join(root, "package.json"),
            `${JSON.stringify(
              { private: true, devDependencies: { [RUNTIME_PACKAGE_NAME]: version } },
              null,
              2,
            )}\n`,
          );
          void pkg;
          installFakeRuntime(root, version);
          return { ok: true as const };
        },
        invokeSetup: (argv: readonly string[]) => {
          const fromIdx = argv.indexOf("--from");
          setupFrom = fromIdx >= 0 ? String(argv[fromIdx + 1]) : null;
          // Reproduce pre-F-016 husk deletion during convert setup.
          rmSync(join(root, "package.json"), { force: true });
          rmSync(join(root, "package-lock.json"), { force: true });
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              contract: 1,
              entry: "setup",
              removed: ["package.json", "package-lock.json", ".deft/core"],
              created: [],
              modified: [],
              conflicts: [],
            }),
            stderr: "",
            message: null,
          };
        },
        invokeMigrate: () => ({
          exitCode: 0,
          stdout: JSON.stringify({ contract: 1, entry: "migrate", migrated: [] }),
          stderr: "",
          message: null,
        }),
      },
    );
    expect(setupFrom).toBe("vendored-core-go");
    expect(code).toBe(1);
    expect(c.err()).toMatch(/lost package\.json after setup/i);
    expect(c.out()).not.toMatch(/Upgrade complete|upgraded successfully|Success/i);
  });

  it("upgrade on orphan-deft-version converts", () => {
    const root = tempProject("wave3f-orphan");
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(join(root, ".deft", "VERSION"), "orphan\n");
    const c = capture();
    const harness = convertDeps(root, "orphan-deft-version");
    const code = runUpgrade(
      root,
      readProjectInstallState(root),
      ["--yes", "--target-version", "9.9.9"],
      "0.0.0-test",
      c.io,
      harness.deps,
    );
    expect(code).toBe(0);
    expect(harness.setupFrom).toBe("orphan-deft-version");
    expect(c.text()).not.toMatch(/`directive uninstall` then/);
  });

  it("upgrade on dual-layout-deft-and-core converts", () => {
    const root = tempProject("wave3f-dual");
    writeCopiedCoreEvidence(root);
    writeGoTarballDeft(root);
    const c = capture();
    const harness = convertDeps(root, "dual-layout-deft-and-core");
    const code = runUpgrade(
      root,
      readProjectInstallState(root),
      ["--yes", "--target-version", "9.9.9"],
      "0.0.0-test",
      c.io,
      harness.deps,
    );
    expect(code).toBe(0);
    expect(harness.setupFrom).toBe("dual-layout-deft-and-core");
  });

  it("upgrade on submodule-deft (file gitlink, safe) converts", () => {
    const root = tempProject("wave3f-sub");
    writeSubmoduleDeft(root);
    const c = capture();
    const harness = convertDeps(root, "submodule-deft");
    const code = runUpgrade(
      root,
      readProjectInstallState(root),
      ["--yes", "--target-version", "9.9.9"],
      "0.0.0-test",
      c.io,
      harness.deps,
    );
    expect(code).toBe(0);
    expect(harness.setupFrom).toBe("submodule-deft");
    expect(c.text()).not.toMatch(/`directive uninstall` then/);
  });

  it("install on submodule-deft converts via first-install from=shape", () => {
    const root = tempProject("wave3f-sub-install");
    writeSubmoduleDeft(root);
    const c = capture();
    let setupFrom: string | null = null;
    const code = runInstall(
      root,
      readProjectInstallState(root),
      ["--yes", "--target-version", "9.9.9"],
      "0.0.0-test",
      c.io,
      {
        resolveLatest: () => ({ ok: true as const, version: "9.9.9" }),
        runPmAdd: ({ version }) => {
          const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
            devDependencies?: Record<string, string>;
          };
          pkg.devDependencies = { [RUNTIME_PACKAGE_NAME]: version };
          writeFileSync(join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
          installFakeRuntime(root, version);
          return { ok: true as const };
        },
        invokeSetup: (argv) => {
          const fromIdx = argv.indexOf("--from");
          setupFrom = fromIdx >= 0 ? String(argv[fromIdx + 1]) : null;
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              contract: 1,
              entry: "setup",
              removed: ["deft"],
              created: [],
              modified: [],
              conflicts: [],
            }),
            stderr: "",
            message: null,
          };
        },
      },
    );
    expect(code).toBe(0);
    expect(setupFrom).toBe("submodule-deft");
    expect(c.text()).not.toMatch(/`directive uninstall` then/);
  });
});
