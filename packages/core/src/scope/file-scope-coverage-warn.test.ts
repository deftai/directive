import { describe, expect, it } from "vitest";
import { evaluateFileScopeCoverageWarn } from "./file-scope-coverage-warn.js";

describe("evaluateFileScopeCoverageWarn (#5736)", () => {
  it("warns when intended_placement path is outside file_scope", () => {
    const result = evaluateFileScopeCoverageWarn({
      brief: {
        plan: {
          metadata: {
            intended_placement: {
              files: ["packages/core/src/a.ts", "packages/core/src/b.ts"],
              module_boundary: "packages/core/src/a.ts",
            },
            swarm: { file_scope: ["packages/core/src/a.ts"] },
          },
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(result.uncovered).toEqual(["packages/core/src/b.ts"]);
    expect(result.warnings[0]).toMatch(/advisory file_scope coverage warn/);
  });

  it("is silent when durable paths are covered", () => {
    const result = evaluateFileScopeCoverageWarn({
      brief: {
        plan: {
          acceptance: {
            clauses: [{ id: 1, artifact_path: "CHANGELOG.md" }],
          },
          metadata: {
            intended_placement: { files: ["CHANGELOG.md"] },
            swarm: { file_scope: ["CHANGELOG.md", "Taskfile.yml"] },
          },
        },
      },
    });
    expect(result.warnings).toEqual([]);
    expect(result.uncovered).toEqual([]);
  });

  it("never invents paths from absent durable fields", () => {
    const result = evaluateFileScopeCoverageWarn({
      brief: {
        plan: {
          narratives: { Description: "mentions packages/core/src/secret.ts in prose only" },
          metadata: { swarm: { file_scope: ["CHANGELOG.md"] } },
        },
      },
    });
    expect(result.uncovered).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});
