import { describe, expect, it } from "vitest";
import { cmdVbriefReconcile, runParityScenario, usage } from "./index.js";
import { pyRepr } from "./py-repr.js";
import { asStrList, candidateDepGraph } from "./swarm-deps.js";
import type { Candidate } from "./types.js";

describe("vbrief-reconcile coverage boost", () => {
  it("pyRepr quotes strings", () => {
    expect(pyRepr("pending")).toBe("'pending'");
  });

  it("asStrList filters non-strings", () => {
    expect(asStrList(["a", 1, "b"])).toEqual(["a", "b"]);
  });

  it("candidateDepGraph tracks intra-candidate deps", () => {
    const a: Candidate = {
      path: "/a",
      storyId: "a",
      status: "proposed",
      swarm: { depends_on: ["b"] },
      blocked: [],
    };
    const b: Candidate = {
      path: "/b",
      storyId: "b",
      status: "proposed",
      swarm: { depends_on: [] },
      blocked: [],
    };
    const graph = candidateDepGraph([a, b], { a: ["/a", "proposed"], b: ["/b", "proposed"] });
    expect(graph.a).toEqual(["b"]);
  });

  it("runParityScenario reconcile-overrides", () => {
    const result = runParityScenario("reconcile-overrides", { fixtureRoot: "/tmp" });
    expect(result.ok).toBe(true);
  });

  it("usage does not throw", () => {
    expect(() => usage()).not.toThrow();
  });

  it("cmd returns 2 for missing verb", () => {
    expect(cmdVbriefReconcile([])).toBe(2);
  });
});
