import { describe, expect, it } from "vitest";
import { lintShippedRegistry, lintTaskContract } from "./index.js";

describe("task-cache registry lint", () => {
  it("passes for the shipped registry", () => {
    const { ok, findings } = lintShippedRegistry();
    expect(ok).toBe(true);
    expect(findings.filter((f) => f.kind === "under-declared-input")).toHaveLength(0);
  });

  it("flags under-declared cacheable tasks", () => {
    const findings = lintTaskContract({
      id: "bad",
      cacheable: true,
      inputs: { globs: ["a.txt"] },
      knownReadSet: { globs: ["a.txt", "b.txt"] },
    });
    expect(findings.some((f) => f.kind === "under-declared-input")).toBe(true);
  });
});
