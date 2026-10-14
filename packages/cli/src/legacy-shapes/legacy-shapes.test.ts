/**
 * Wave 3b owner-boundary tests — L2 shape registry (detect → shape_id → decision).
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

describe("L2 shape registry — data-driven decisions (survey shape_ids)", () => {
  const expected: ReadonlyArray<readonly [SurveyShapeId, RecoveryDecision]> = [
    ["ovpr-runtime-pin", "l0-current"],
    ["npm-hybrid-pin-copied-core", "l0-latest-legacy-convert"],
    ["go-tarball-deft-root", "uninstall-reinstall"],
    ["submodule-deft", "uninstall-reinstall"],
    ["vendored-core-go", "uninstall-reinstall"],
    ["orphan-deft-version", "unsupported-honest"],
  ];

  it("maps every wired survey shape_id to the 3b lean decision", () => {
    for (const [shapeId, decision] of expected) {
      expect(decisionForShapeId(shapeId)).toBe(decision);
      expect(DECISION_BY_SHAPE_ID[shapeId]).toBe(decision);
    }
  });

  it("recovery enum is closed (no invented convert decisions for L2)", () => {
    const allowed = new Set<RecoveryDecision>([
      "l0-current",
      "l0-latest-legacy-convert",
      "uninstall-reinstall",
      "unsupported-honest",
    ]);
    for (const decision of Object.values(DECISION_BY_SHAPE_ID)) {
      expect(allowed.has(decision)).toBe(true);
    }
    expect(decisionForShapeId("go-tarball-deft-root")).not.toBe("l0-latest-legacy-convert");
    expect(decisionForShapeId("vendored-core-go")).not.toBe("l0-latest-legacy-convert");
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

  it("vendored-core-go: copied core, no exact pin → uninstall-reinstall", () => {
    const root = tempProject();
    writeCopiedCoreEvidence(root);
    expect(readPin(root).oldStyle).toBe(false);
    const resolved = resolveInstallShape(root);
    expect(resolved).not.toBeNull();
    expect(resolved!.shapeId).toBe("vendored-core-go");
    expect(resolved!.decision).toBe("uninstall-reinstall");
  });

  it("go-tarball-deft-root / legacy-deft-prefixed → uninstall-reinstall", () => {
    const root = tempProject();
    writeGoTarballDeft(root);
    const resolved = resolveInstallShape(root);
    expect(resolved).not.toBeNull();
    expect(resolved!.shapeId).toBe("go-tarball-deft-root");
    expect(resolved!.decision).toBe("uninstall-reinstall");
  });

  it("submodule-deft → uninstall-reinstall", () => {
    const root = tempProject();
    writeSubmoduleDeft(root);
    const resolved = resolveInstallShape(root);
    expect(resolved).not.toBeNull();
    expect(resolved!.shapeId).toBe("submodule-deft");
    expect(resolved!.decision).toBe("uninstall-reinstall");
  });

  it("orphan-deft-version → unsupported-honest", () => {
    const root = tempProject();
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(join(root, ".deft", "VERSION"), "orphan\n");
    expect(existsSync(join(root, ".deft", "core"))).toBe(false);
    const resolved = resolveInstallShape(root);
    expect(resolved).not.toBeNull();
    expect(resolved!.shapeId).toBe("orphan-deft-version");
    expect(resolved!.decision).toBe("unsupported-honest");
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

describe("L2 dispatch messaging (uninstall→reinstall / unsupported-honest)", () => {
  it("uninstall-reinstall message names uninstall then install", () => {
    const msg = formatShapeRecoveryMessage(
      {
        shapeId: "go-tarball-deft-root",
        decision: "uninstall-reinstall",
        evidence: ["deft/"],
      },
      "upgrade",
    );
    expect(msg).toMatch(/go-tarball-deft-root/);
    expect(msg).toMatch(/`directive uninstall` then `directive install`/);
    expect(msg).not.toMatch(/Run `directive upgrade`/);
    expect(msg).not.toMatch(/in-place convert is supported/i);
  });

  it("unsupported-honest message does not invent convert or upgrade", () => {
    const msg = formatShapeRecoveryMessage(
      {
        shapeId: "orphan-deft-version",
        decision: "unsupported-honest",
        evidence: [".deft/VERSION"],
      },
      "upgrade",
    );
    expect(msg).toMatch(/orphan-deft-version/);
    expect(msg).toMatch(/unsupported|not supported|automatic recovery/i);
    expect(msg).not.toMatch(/Run `directive upgrade`/);
    expect(msg).not.toMatch(/convert/i);
  });
});

describe("bookend seam — L2 shapes name uninstall→install (L0 oldStyle unchanged)", () => {
  it("upgrade on go-tarball names uninstall then install", () => {
    const root = tempProject();
    writeGoTarballDeft(root);
    const c = capture();
    const code = runUpgrade(root, readProjectInstallState(root), ["--yes"], "0.0.0-test", c.io);
    expect(code).toBe(2);
    expect(c.text()).toMatch(/uninstall/i);
    expect(c.text()).toMatch(/install/i);
    expect(c.text()).toMatch(/go-tarball-deft-root/);
  });

  it("upgrade on vendored-core-go names uninstall then install", () => {
    const root = tempProject();
    writeCopiedCoreEvidence(root);
    const c = capture();
    const code = runUpgrade(root, readProjectInstallState(root), ["--yes"], "0.0.0-test", c.io);
    expect(code).toBe(2);
    expect(c.text()).toMatch(/vendored-core-go/);
    expect(c.text()).toMatch(/uninstall/i);
  });

  it("upgrade on orphan-deft-version is unsupported-honest", () => {
    const root = tempProject();
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(join(root, ".deft", "VERSION"), "orphan\n");
    const c = capture();
    const code = runUpgrade(root, readProjectInstallState(root), ["--yes"], "0.0.0-test", c.io);
    expect(code).toBe(2);
    expect(c.text()).toMatch(/orphan-deft-version/);
    expect(c.text()).toMatch(/unsupported|not supported|automatic recovery/i);
  });

  it("install on submodule-deft names uninstall then install", () => {
    const root = tempProject();
    writeSubmoduleDeft(root);
    const c = capture();
    const code = runInstall(root, readProjectInstallState(root), ["--yes"], "0.0.0-test", c.io);
    expect(code).toBe(1);
    expect(c.text()).toMatch(/submodule-deft/);
    expect(c.text()).toMatch(/uninstall/i);
  });

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
});
