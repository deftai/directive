/**
 * Wave 3d RED — owner-boundary contracts for removal steps + strategy table.
 * pruneEmptyAncestors / removeSoleAuthorHusks intentionally fail until 3e.
 * Strategy table rows are present (data) so convert path shape is documented.
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
import { pruneEmptyAncestors, removeSoleAuthorHusks } from "./steps.js";
import { STRATEGIES, strategyForShape } from "./strategies.js";

const TEMPS: string[] = [];

afterEach(() => {
  while (TEMPS.length > 0) {
    const root = TEMPS.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(name = "wave3d-removal"): string {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  TEMPS.push(root);
  return root;
}

describe("pruneEmptyAncestors (C4 / F-012) — RED until 3e", () => {
  it("removes empty dirs after file delete and stops at non-empty / foreign", () => {
    const root = tempRoot();
    const skillDir = join(root, ".agents", "skills", "directive-coding");
    mkdirSync(skillDir, { recursive: true });
    const skillFile = join(skillDir, "SKILL.md");
    writeFileSync(skillFile, "# owned\n");
    // Sibling foreign content under .agents must survive prune walk-up.
    mkdirSync(join(root, ".agents", "skills", "user-skill"), { recursive: true });
    writeFileSync(join(root, ".agents", "skills", "user-skill", "SKILL.md"), "# user\n");

    rmSync(skillFile);

    const removed = pruneEmptyAncestors(root, ".agents/skills/directive-coding/SKILL.md");
    expect(removed).toEqual(
      expect.arrayContaining([".agents/skills/directive-coding"]),
    );
    expect(existsSync(join(root, ".agents", "skills", "directive-coding"))).toBe(false);
    // Must not delete .agents/skills (holds foreign skill) or .agents.
    expect(existsSync(join(root, ".agents", "skills", "user-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(root, ".agents", "skills"))).toBe(true);
  });
});

describe("removeSoleAuthorHusks (C5 / F-013) — RED until 3e", () => {
  it("removes {private:true}-only package.json and {} hooks we created", () => {
    const root = tempRoot();
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify({ private: true }, null, 2)}\n`,
    );
    mkdirSync(join(root, ".cursor"), { recursive: true });
    writeFileSync(join(root, ".cursor", "hooks.json"), "{}\n");
    // User content must stay.
    mkdirSync(join(root, "xbrief"), { recursive: true });
    writeFileSync(join(root, "xbrief", "keep.txt"), "user\n");
    writeFileSync(
      join(root, "real-pkg.json"),
      `${JSON.stringify({ name: "app", private: true, dependencies: { leftpad: "1.0.0" } }, null, 2)}\n`,
    );

    const removed = removeSoleAuthorHusks(root);
    expect(removed).toEqual(
      expect.arrayContaining(["package.json", ".cursor/hooks.json"]),
    );
    expect(existsSync(join(root, "package.json"))).toBe(false);
    expect(existsSync(join(root, ".cursor", "hooks.json"))).toBe(false);
    expect(existsSync(join(root, "xbrief", "keep.txt"))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, "real-pkg.json"), "utf8")).name).toBe("app");
  });
});

describe("STRATEGIES table (WAVE3-V2 convert shapes)", () => {
  it("lists go-tarball / vendored-core-go / submodule with ordered steps + pin", () => {
    const go = strategyForShape("go-tarball-deft-root");
    expect(go.needsRuntimePin).toBe(true);
    expect(go.steps).toContain("removeDeftFrameworkTree");
    expect(go.steps).toContain("pruneEmptyAncestors");
    expect(go.steps).toContain("removeSoleAuthorHusks");

    const vendored = strategyForShape("vendored-core-go");
    expect(vendored.needsRuntimePin).toBe(true);
    expect(vendored.steps).toContain("removeCopiedCore");
    expect(vendored.steps.indexOf("removeCopiedCore")).toBeLessThan(
      vendored.steps.indexOf("pruneEmptyAncestors"),
    );

    const sub = strategyForShape("submodule-deft");
    expect(sub.needsRuntimePin).toBe(true);
    expect(sub.steps).toContain("normalizeGitmodules");
    expect(sub.steps).toContain("removeDeftFrameworkTree");
  });

  it("lists dual-layout and orphan convert strategies", () => {
    const dual = STRATEGIES["dual-layout-deft-and-core"];
    expect(dual.needsRuntimePin).toBe(true);
    expect(dual.steps.indexOf("removeDeftFrameworkTree")).toBeLessThan(
      dual.steps.indexOf("removeCopiedCore"),
    );

    const orphan = STRATEGIES["orphan-deft-version"];
    expect(orphan.needsRuntimePin).toBe(true);
    expect(orphan.steps).toContain("removeOrphanDeftVersion");
  });

  it("keeps L0 ovpr / npm-hybrid rows as anchors", () => {
    expect(STRATEGIES["ovpr-runtime-pin"].steps).toEqual([]);
    expect(STRATEGIES["npm-hybrid-pin-copied-core"].needsRuntimePin).toBe(true);
    expect(STRATEGIES["npm-hybrid-pin-copied-core"].steps).toContain("removeCopiedCore");
  });
});
