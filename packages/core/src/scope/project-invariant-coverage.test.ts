import { describe, expect, it } from "vitest";
import { parseProjectInvariants } from "../policy/project-invariants.js";
import {
  applicableProjectInvariants,
  pathGlobsIntersect,
  validateProjectInvariantCoverage,
} from "./project-invariant-coverage.js";

const list = parseProjectInvariants([
  {
    id: "policy-contract",
    statement: "Do not break policy resolve.",
    paths: ["packages/core/src/policy/**"],
  },
  {
    id: "docs-contract",
    statement: "Keep authoring docs loadable.",
    contract_surface: ["content/docs/**"],
  },
  {
    id: "engine-module",
    statement: "Engine modules stay independently useful.",
    contractSurface: { moduleIds: ["typescript-engine"] },
  },
]).invariants;

const modules = {
  "typescript-engine": ["packages/**/*.ts", "packages/**/*.json"],
};

describe("pathGlobsIntersect", () => {
  it("matches a directory file_scope against a ** contract glob", () => {
    expect(pathGlobsIntersect("packages/core/src/policy/**", "packages/core/src/policy")).toBe(
      true,
    );
    expect(pathGlobsIntersect("packages/core/src/policy", "packages/core/src/policy/**")).toBe(
      true,
    );
  });

  it("matches nested prefixes in either direction", () => {
    expect(pathGlobsIntersect("packages/core", "packages/core/src/policy")).toBe(true);
    expect(pathGlobsIntersect("packages/core/src/policy", "packages/core")).toBe(true);
  });

  it("does not match disjoint trees", () => {
    expect(pathGlobsIntersect("packages/core/src/policy", "content/docs/**")).toBe(false);
    expect(pathGlobsIntersect("packages/cli", "packages/core")).toBe(false);
    expect(pathGlobsIntersect("", "packages/core")).toBe(false);
  });

  it("treats **/*.ts as a subtree under the prefix", () => {
    expect(pathGlobsIntersect("packages/**/*.ts", "packages/core")).toBe(true);
    expect(pathGlobsIntersect("packages/**/*.ts", "content/docs")).toBe(false);
  });

  it("matches a leading **/ suffix against a concrete file_scope", () => {
    expect(pathGlobsIntersect("**/src/policy", "packages/core/src/policy")).toBe(true);
    expect(pathGlobsIntersect("**/src/policy", "packages/cli/src/main.ts")).toBe(false);
  });

  it("keeps /* to one path segment", () => {
    expect(pathGlobsIntersect("packages/core/*", "packages/core/foo")).toBe(true);
    expect(pathGlobsIntersect("packages/core/*", "packages/core/foo/bar")).toBe(false);
  });
});

describe("applicableProjectInvariants", () => {
  it("requires no disposition when file_scope is empty", () => {
    expect(applicableProjectInvariants(list, [], modules)).toEqual([]);
  });

  it("requires no disposition when the intersection is empty", () => {
    const applicable = applicableProjectInvariants(list, ["cmd/deft-install"], modules);
    expect(applicable.map((a) => a.id)).toEqual([]);
  });

  it("selects only intersecting path contracts", () => {
    const applicable = applicableProjectInvariants(
      list,
      ["packages/core/src/policy", "packages/core/src/scope"],
      modules,
    );
    expect(applicable.map((a) => a.id).sort()).toEqual(["engine-module", "policy-contract"]);
  });

  it("resolves module ids through pathGlobs", () => {
    const applicable = applicableProjectInvariants(
      list.filter((i) => i.id === "engine-module"),
      ["packages/core/src/scope"],
      modules,
    );
    expect(applicable).toEqual([{ id: "engine-module", reason: "module" }]);
  });

  it("treats unresolved module ids as applicable", () => {
    const applicable = applicableProjectInvariants(
      list.filter((i) => i.id === "engine-module"),
      ["docs/only"],
      {},
    );
    expect(applicable).toEqual([{ id: "engine-module", reason: "unresolved-module" }]);
  });
});

describe("validateProjectInvariantCoverage", () => {
  it("is a no-op success when nothing is applicable", () => {
    const result = validateProjectInvariantCoverage({
      applicableIds: [],
      draft: {},
    });
    expect(result.ok).toBe(true);
    expect(result.missingIds).toEqual([]);
  });

  it("fails closed on a missing applicable id", () => {
    const result = validateProjectInvariantCoverage({
      applicableIds: ["policy-contract"],
      draft: { coverage_map: {} },
    });
    expect(result.ok).toBe(false);
    expect(result.missingIds).toEqual(["policy-contract"]);
    expect(result.errors.join(" ")).toMatch(/policy-contract/);
    expect(result.errors.join(" ")).toMatch(/coverage_map/);
  });

  it("accepts covered / deferred / behavioral_delta with required side fields", () => {
    const result = validateProjectInvariantCoverage({
      applicableIds: ["a", "b", "c"],
      draft: {
        coverage_map: {
          a: { disposition: "covered" },
          b: {
            disposition: "deferred",
            provenance: { reason: "later", target_path: "xbrief/proposed/later.xbrief.json" },
          },
          c: { disposition: "behavioral_delta", delta_id: "d1" },
        },
        behavioral_deltas: [
          {
            delta_id: "d1",
            parent_requirement_ids: ["c"],
            change_kind: "weaken_invariant",
            summary: "weaken",
            before: "strict",
            after: "weaker",
            rationale: "needed",
          },
        ],
      },
    });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("rejects split at project level only for applicable IDs", () => {
    const result = validateProjectInvariantCoverage({
      applicableIds: ["a"],
      draft: {
        coverage_map: {
          a: { disposition: "split", split_group: "g", part: "1" },
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/split is excluded at project level/);

    const parentSplit = validateProjectInvariantCoverage({
      applicableIds: ["a"],
      draft: {
        coverage_map: {
          a: { disposition: "covered" },
          "req-parent": { disposition: "split", split_group: "g", part: "1" },
        },
      },
    });
    expect(parentSplit.ok).toBe(true);
  });

  it("accepts not_applicable only with a reason", () => {
    const bare = validateProjectInvariantCoverage({
      applicableIds: ["a"],
      draft: { coverage_map: { a: { disposition: "not_applicable" } } },
    });
    expect(bare.ok).toBe(false);
    expect(bare.errors.join(" ")).toMatch(/requires reason/);

    const ok = validateProjectInvariantCoverage({
      applicableIds: ["a"],
      draft: {
        coverage_map: {
          a: { disposition: "not_applicable", reason: "docs-only slice; no product write" },
        },
      },
    });
    expect(ok.ok).toBe(true);
  });

  it("ignores extra parent-requirement coverage_map keys", () => {
    const result = validateProjectInvariantCoverage({
      applicableIds: ["policy-contract"],
      draft: {
        coverage_map: {
          "policy-contract": { disposition: "covered" },
          "req-parent-abc": { disposition: "covered" },
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  it("reads coverage_map from plan.metadata and rejects duplicate entries", () => {
    const result = validateProjectInvariantCoverage({
      applicableIds: ["a"],
      draft: {
        plan: {
          metadata: {
            coverage_map: {
              a: { disposition: "covered" },
            },
          },
        },
      },
    });
    expect(result.ok).toBe(true);

    const dup = validateProjectInvariantCoverage({
      applicableIds: ["a"],
      draft: {
        coverage_map: [
          { parent_requirement_id: "a", disposition: "covered" },
          { parent_requirement_id: "a", disposition: "covered" },
        ],
      },
    });
    expect(dup.ok).toBe(false);
    expect(dup.errors.join(" ")).toMatch(/duplicate coverage entries/);
  });

  it("parses array-form not_applicable and flags a missing reason", () => {
    const result = validateProjectInvariantCoverage({
      applicableIds: ["a"],
      draft: {
        coverage_map: [{ id: "a", disposition: "not_applicable" }],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/requires reason/);
  });

  it("reuses deferred side-field validation from coverage_map", () => {
    const result = validateProjectInvariantCoverage({
      applicableIds: ["a"],
      draft: {
        coverage_map: {
          a: { disposition: "deferred", provenance: { reason: "later" } },
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/target_story_id|target_path/);
  });
});
