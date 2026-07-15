import { describe, expect, it } from "vitest";
import { classifyTriggerRoutingPaths, evaluate, isTriggerRoutingPath } from "./evaluate.js";

describe("eval-triggers-relocation (#1586)", () => {
  it("isTriggerRoutingPath matches routing homes", () => {
    expect(isTriggerRoutingPath("REFERENCES.md")).toBe(true);
    expect(isTriggerRoutingPath("packages/core/src/eval/triggers.ts")).toBe(true);
    expect(isTriggerRoutingPath("README.md")).toBe(false);
  });

  it("classifyTriggerRoutingPaths skips unrelated diffs", () => {
    const result = evaluate({
      paths: ["packages/cli/src/dispatch.ts"],
      quiet: true,
    });
    expect(result.code).toBe(0);
    expect(result.skipped).toBe(true);
  });

  it("classifyTriggerRoutingPaths runs eval when routing paths change", () => {
    const { isTriggerRouting, matchedPaths } = classifyTriggerRoutingPaths([
      "evals/trigger-cases.jsonl",
      "CHANGELOG.md",
    ]);
    expect(isTriggerRouting).toBe(true);
    expect(matchedPaths).toEqual(["evals/trigger-cases.jsonl"]);
  });
});
