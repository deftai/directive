/**
 * Wave 3b/3d owner-boundary tests — L2 shape registry (detect → shape_id → decision).
 * WAVE3-V2 (3d): convert-via-removals lean; bookend refuse remains interim until 3f.
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

describe("L2 dispatch messaging (convert-via-removals interim / unsupported)", () => {
  it("convert-via-removals interim message still names uninstall then install", () => {
    const msg = formatShapeRecoveryMessage(
      {
        shapeId: "go-tarball-deft-root",
        decision: "convert-via-removals",
        evidence: ["deft/"],
      },
      "upgrade",
    );
    expect(msg).toMatch(/go-tarball-deft-root/);
    expect(msg).toMatch(/WAVE3-V2|convert-via-removals/i);
    expect(msg).toMatch(/`directive uninstall` then `directive install`/);
    expect(isL2RefusalDecision("convert-via-removals")).toBe(true);
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
  });
});

describe("bookend seam — interim L2 refuse until 3f (WAVE3-V2 superseded long-term)", () => {
  it("upgrade on go-tarball still refuses interim (3d); names shape + uninstall", () => {
    const root = tempProject();
    writeGoTarballDeft(root);
    const c = capture();
    const code = runUpgrade(root, readProjectInstallState(root), ["--yes"], "0.0.0-test", c.io);
    expect(code).toBe(2);
    expect(c.text()).toMatch(/uninstall/i);
    expect(c.text()).toMatch(/install/i);
    expect(c.text()).toMatch(/go-tarball-deft-root/);
    // Long-term intent is convert — registry already says so.
    expect(decisionForShapeId("go-tarball-deft-root")).toBe("convert-via-removals");
  });

  it("upgrade on vendored-core-go still refuses interim; registry is convert-via-removals", () => {
    const root = tempProject();
    writeCopiedCoreEvidence(root);
    const c = capture();
    const code = runUpgrade(root, readProjectInstallState(root), ["--yes"], "0.0.0-test", c.io);
    expect(code).toBe(2);
    expect(c.text()).toMatch(/vendored-core-go/);
    expect(c.text()).toMatch(/uninstall/i);
    expect(decisionForShapeId("vendored-core-go")).toBe("convert-via-removals");
  });

  it("upgrade on orphan-deft-version interim-refuses as convert-via-removals", () => {
    const root = tempProject();
    mkdirSync(join(root, ".deft"), { recursive: true });
    writeFileSync(join(root, ".deft", "VERSION"), "orphan\n");
    const c = capture();
    const code = runUpgrade(root, readProjectInstallState(root), ["--yes"], "0.0.0-test", c.io);
    expect(code).toBe(2);
    expect(c.text()).toMatch(/orphan-deft-version/);
    expect(decisionForShapeId("orphan-deft-version")).toBe("convert-via-removals");
  });

  it("install on submodule-deft interim-refuses; registry is convert-via-removals", () => {
    const root = tempProject();
    writeSubmoduleDeft(root);
    const c = capture();
    const code = runInstall(root, readProjectInstallState(root), ["--yes"], "0.0.0-test", c.io);
    expect(code).toBe(1);
    expect(c.text()).toMatch(/submodule-deft/);
    expect(c.text()).toMatch(/uninstall/i);
    expect(decisionForShapeId("submodule-deft")).toBe("convert-via-removals");
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

/**
 * RED until 3f: upgrade must run convert strategy (not refuse) for convert shapes.
 * Documents WAVE3-V2 long-term contract; expected to fail on 3d tip.
 */
describe("WAVE3-V2 upgrade-convert path (RED until 3f)", () => {
  it("upgrade on go-tarball-deft-root should convert (not exit refuse)", () => {
    const root = tempProject();
    writeGoTarballDeft(root);
    const c = capture();
    const code = runUpgrade(root, readProjectInstallState(root), ["--yes"], "0.0.0-test", c.io);
    // 3f: strategy runs → setup/migrate; must not be the L2 refuse exit.
    expect(code).not.toBe(2);
    expect(c.text()).not.toMatch(/`directive uninstall` then `directive install`/);
    expect(decisionForShapeId("go-tarball-deft-root")).toBe("convert-via-removals");
  });

  it("upgrade on vendored-core-go should convert (not exit refuse)", () => {
    const root = tempProject();
    writeCopiedCoreEvidence(root);
    const c = capture();
    const code = runUpgrade(root, readProjectInstallState(root), ["--yes"], "0.0.0-test", c.io);
    expect(code).not.toBe(2);
    expect(c.text()).not.toMatch(/Until then, run `directive uninstall`/);
  });
});
