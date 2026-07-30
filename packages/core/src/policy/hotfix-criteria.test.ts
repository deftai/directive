import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOTFIX_MAX_FILES,
  DEFAULT_HOTFIX_MAX_LINES,
  evaluateHotfixEligibility,
  HOTFIX_CANDIDATE_LABEL,
  resolveHotfixCriteria,
} from "./hotfix-criteria.js";

describe("evaluateHotfixEligibility — acceptance table (#1193)", () => {
  it("✓ single character fix restoring green", () => {
    const r = evaluateHotfixEligibility({
      linesChanged: 1,
      filesChanged: 1,
      paths: ["src/index.ts"],
      isOneCharacterEdit: true,
      restoresGreen: true,
    });
    expect(r.eligible).toBe(true);
    expect(r.proposedLabel).toBe(HOTFIX_CANDIDATE_LABEL);
  });

  it("✓ small fix ≤10 lines ≤2 files restoring green", () => {
    const r = evaluateHotfixEligibility({
      linesChanged: 8,
      filesChanged: 2,
      paths: ["src/a.ts", "src/b.ts"],
      restoresGreen: true,
    });
    expect(r.eligible).toBe(true);
    expect(r.proposedLabel).toBe(HOTFIX_CANDIDATE_LABEL);
  });

  it("✓ pure revert always qualifies", () => {
    const r = evaluateHotfixEligibility({
      linesChanged: 500,
      filesChanged: 40,
      paths: ["fly.toml", "src/huge.ts"],
      isPureRevert: true,
      isRefactor: true,
      addsNewHandlerOrRoute: true,
    });
    expect(r.eligible).toBe(true);
    expect(r.proposedLabel).toBe(HOTFIX_CANDIDATE_LABEL);
  });

  it("⊗ 300-line new media-type handler never qualifies", () => {
    const r = evaluateHotfixEligibility({
      linesChanged: 300,
      filesChanged: 1,
      paths: ["src/handlers/media.ts"],
      addsNewHandlerOrRoute: true,
      changesExportedSurface: true,
      restoresGreen: true,
    });
    expect(r.eligible).toBe(false);
    expect(r.proposedLabel).toBeNull();
    expect(r.denyCodes).toContain("new-handler-route");
    expect(r.denyCodes).toContain("too-many-lines");
  });

  it("⊗ small refactor never qualifies", () => {
    const r = evaluateHotfixEligibility({
      linesChanged: 5,
      filesChanged: 1,
      paths: ["src/util.ts"],
      isRefactor: true,
      restoresGreen: true,
    });
    expect(r.eligible).toBe(false);
    expect(r.denyCodes).toContain("refactor");
  });

  it("⊗ forbidden path fly.toml never qualifies", () => {
    const r = evaluateHotfixEligibility({
      linesChanged: 1,
      filesChanged: 1,
      paths: ["fly.toml"],
      restoresGreen: true,
    });
    expect(r.eligible).toBe(false);
    expect(r.denyCodes).toContain("forbidden-path");
  });

  it("⊗ Dockerfile / workflows / migrations forbidden", () => {
    for (const path of ["Dockerfile", ".github/workflows/ci.yml", "migrations/001.sql"]) {
      const r = evaluateHotfixEligibility({
        linesChanged: 1,
        filesChanged: 1,
        paths: [path],
        restoresGreen: true,
      });
      expect(r.eligible, path).toBe(false);
      expect(r.denyCodes, path).toContain("forbidden-path");
    }
  });

  it("⊗ over line or file limit", () => {
    const tooManyLines = evaluateHotfixEligibility({
      linesChanged: DEFAULT_HOTFIX_MAX_LINES + 1,
      filesChanged: 1,
      paths: ["src/a.ts"],
      restoresGreen: true,
    });
    expect(tooManyLines.eligible).toBe(false);
    expect(tooManyLines.denyCodes).toContain("too-many-lines");

    const tooManyFiles = evaluateHotfixEligibility({
      linesChanged: 1,
      filesChanged: DEFAULT_HOTFIX_MAX_FILES + 1,
      paths: ["a.ts", "b.ts", "c.ts"],
      restoresGreen: true,
    });
    expect(tooManyFiles.eligible).toBe(false);
    expect(tooManyFiles.denyCodes).toContain("too-many-files");
  });

  it("⊗ new export / dependency / schema", () => {
    expect(
      evaluateHotfixEligibility({
        linesChanged: 1,
        filesChanged: 1,
        paths: ["src/a.ts"],
        changesExportedSurface: true,
        restoresGreen: true,
      }).eligible,
    ).toBe(false);
    expect(
      evaluateHotfixEligibility({
        linesChanged: 1,
        filesChanged: 1,
        paths: ["package.json"],
        addsNewDependency: true,
        restoresGreen: true,
      }).eligible,
    ).toBe(false);
    expect(
      evaluateHotfixEligibility({
        linesChanged: 1,
        filesChanged: 1,
        paths: ["schema.sql"],
        touchesSchemaOrMigration: true,
        restoresGreen: true,
      }).eligible,
    ).toBe(false);
  });
});

describe("resolveHotfixCriteria", () => {
  it("applies defaults for empty/invalid", () => {
    const d = resolveHotfixCriteria(null);
    expect(d.maxLines).toBe(DEFAULT_HOTFIX_MAX_LINES);
    expect(d.maxFiles).toBe(DEFAULT_HOTFIX_MAX_FILES);
    expect(d.forbiddenPathGlobs.length).toBeGreaterThan(0);
  });

  it("honors typed overrides", () => {
    const d = resolveHotfixCriteria({
      maxLines: 3,
      maxFiles: 1,
      forbiddenPathGlobs: ["secrets/**"],
    });
    expect(d.maxLines).toBe(3);
    expect(d.maxFiles).toBe(1);
    expect(d.forbiddenPathGlobs).toEqual(["secrets/**"]);
  });
});
