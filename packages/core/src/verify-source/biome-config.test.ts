import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateBiomeConfigGuard, findRuleSeverities, GUARDED_RULES } from "./biome-config.js";

describe("findRuleSeverities", () => {
  it("reads a string severity", () => {
    const config = {
      linter: { rules: { correctness: { noUnusedVariables: "warn" } } },
    };
    const [finding] = findRuleSeverities(config, [
      { group: "correctness", rule: "noUnusedVariables" },
    ]);
    expect(finding?.severity).toBe("warn");
  });

  it("reads a severity nested under an object's level field", () => {
    const config = {
      linter: {
        rules: { style: { noNonNullAssertion: { level: "info", fix: "none" } } },
      },
    };
    const [finding] = findRuleSeverities(config, [{ group: "style", rule: "noNonNullAssertion" }]);
    expect(finding?.severity).toBe("info");
  });

  it("returns null when the rule has no explicit entry", () => {
    const config = { linter: { rules: { preset: "recommended" } } };
    const [finding] = findRuleSeverities(config, [
      { group: "correctness", rule: "noUnusedVariables" },
    ]);
    expect(finding?.severity).toBeNull();
  });

  it("returns null for a malformed config shape", () => {
    const findings = findRuleSeverities(null, [
      { group: "correctness", rule: "noUnusedVariables" },
    ]);
    expect(findings[0]?.severity).toBeNull();
  });

  it("returns null when the rule entry is neither a string nor an object", () => {
    const config = {
      linter: { rules: { correctness: { noUnusedVariables: 1 } } },
    };
    const [finding] = findRuleSeverities(config, [
      { group: "correctness", rule: "noUnusedVariables" },
    ]);
    expect(finding?.severity).toBeNull();
  });
});

describe("evaluateBiomeConfigGuard", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  function writeBiomeJson(contents: unknown): void {
    root = mkdtempSync(join(tmpdir(), "biome-config-guard-"));
    writeFileSync(join(root, "biome.json"), JSON.stringify(contents), "utf8");
  }

  it("passes when both guarded rules have an explicit non-error severity", () => {
    writeBiomeJson({
      linter: {
        rules: {
          preset: "recommended",
          correctness: { noUnusedVariables: "warn" },
          style: { noNonNullAssertion: "warn" },
        },
      },
    });
    const result = evaluateBiomeConfigGuard(root);
    expect(result.code).toBe(0);
    expect(result.findings).toHaveLength(GUARDED_RULES.length);
  });

  it("fails when a guarded rule has no explicit severity (preset-inherited)", () => {
    writeBiomeJson({ linter: { rules: { preset: "recommended" } } });
    const result = evaluateBiomeConfigGuard(root);
    expect(result.code).toBe(1);
    expect(result.message).toContain("noUnusedVariables");
    expect(result.message).toContain("not explicitly set");
  });

  it("fails when a guarded rule is explicitly pinned to error", () => {
    writeBiomeJson({
      linter: {
        rules: {
          preset: "recommended",
          correctness: { noUnusedVariables: "error" },
          style: { noNonNullAssertion: "warn" },
        },
      },
    });
    const result = evaluateBiomeConfigGuard(root);
    expect(result.code).toBe(1);
    expect(result.message).toContain('"error"');
  });

  it("returns a config error when biome.json is missing", () => {
    root = mkdtempSync(join(tmpdir(), "biome-config-guard-missing-"));
    const result = evaluateBiomeConfigGuard(root);
    expect(result.code).toBe(2);
    expect(result.message).toContain("cannot read");
  });

  it("returns a config error when biome.json is not valid JSON", () => {
    root = mkdtempSync(join(tmpdir(), "biome-config-guard-badjson-"));
    writeFileSync(join(root, "biome.json"), "{not json", "utf8");
    const result = evaluateBiomeConfigGuard(root);
    expect(result.code).toBe(2);
    expect(result.message).toContain("not valid JSON");
  });

  it("validates the repo's own biome.json declares explicit severities", () => {
    const result = evaluateBiomeConfigGuard(join(import.meta.dirname, "..", "..", "..", ".."));
    expect(result.code).toBe(0);
  });
});
