import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isSpecDriftOverrideTemplateName,
  mintSpecDriftOverrideTemplateGrant,
  SPEC_DRIFT_OVERRIDE_DEFAULT_EXPIRY_HOURS,
  SPEC_DRIFT_OVERRIDE_TEMPLATE_NAME,
} from "./spec-drift-override-grant.js";

describe("spec-drift-override-grant", () => {
  let root = "";

  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("exposes free-pattern default expiry and template name", () => {
    expect(SPEC_DRIFT_OVERRIDE_TEMPLATE_NAME).toBe("spec-drift-override");
    expect(SPEC_DRIFT_OVERRIDE_DEFAULT_EXPIRY_HOURS).toBe(Number("24"));
    expect(isSpecDriftOverrideTemplateName("spec-drift-override")).toBe(true);
    expect(isSpecDriftOverrideTemplateName("finish-loop")).toBe(false);
  });

  it("returns failure for missing binds without throwing", () => {
    root = mkdtempSync(join(tmpdir(), "spec-drift-override-"));
    const missingTarget = mintSpecDriftOverrideTemplateGrant({
      projectRoot: root,
      target: "  ",
      planRef: "scope-1",
      storyIds: ["i1"],
    });
    expect(missingTarget.ok).toBe(false);
    if (missingTarget.ok) return;
    expect(missingTarget.reason).toMatch(/--target/);

    const missingItems = mintSpecDriftOverrideTemplateGrant({
      projectRoot: root,
      target: "baseline-1",
      planRef: "scope-1",
      storyIds: ["  "],
    });
    expect(missingItems.ok).toBe(false);
    if (missingItems.ok) return;
    expect(missingItems.reason).toMatch(/--story-ids/);
  });
});
