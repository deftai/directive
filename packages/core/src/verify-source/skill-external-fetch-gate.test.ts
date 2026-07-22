import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluateSkillExternalFetchGate } from "./skill-external-fetch-gate.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");

describe("evaluateSkillExternalFetchGate (#1936)", () => {
  it("passes_on_real_framework_source_tree", () => {
    const result = evaluateSkillExternalFetchGate(REPO_ROOT);
    expect(result.code).toBe(0);
    expect(result.message).toContain("clean");
  });

  it("returns_config_error_when_skills_dir_missing", () => {
    const result = evaluateSkillExternalFetchGate("/nonexistent/deft-root");
    expect(result.code).toBe(2);
    expect(result.message).toContain("not found");
  });
});
