/**
 * Unit tests for coverage-map.ts (#3238 / epic #3237 Q1/Q7/Q8).
 * Integration with scope:decompose --check lives in decompose.test.ts.
 */

import { describe, expect, it } from "vitest";
import {
  extractParentRequirements,
  formatCoverageReportLine,
  parseBehavioralDeltas,
  parseCoverageMap,
  validateCoverageMap,
} from "./coverage-map.js";

const abcParent = {
  xBRIEFInfo: { version: "0.8" },
  plan: {
    id: "epic-state-machine",
    title: "Ordered state machine A-B-C",
    status: "pending",
    items: [
      {
        id: "req-ordered-a-b-c",
        title: "Ordered stages A then B then C",
        status: "pending",
        narrative: {
          Acceptance: "Given stage A, when advancing, then B then C in order.",
        },
      },
      {
        id: "req-forbid-a-to-c",
        title: "Forbidden shortcut A to C",
        kind: "negative_invariant",
        status: "pending",
        narrative: {
          Acceptance: "Given stage A, when A-to-C is requested, then reject it.",
        },
      },
      {
        id: "req-terminal-failure",
        title: "Terminal failure path",
        status: "pending",
        narrative: {
          Acceptance: "Given failed transition, when recovery fails, then terminal failure.",
        },
      },
    ],
    metadata: { kind: "epic" },
  },
};

describe("coverage-map (#3238)", () => {
  it("extracts authored IDs and negative invariants from parent items", () => {
    const reqs = extractParentRequirements(abcParent);
    expect(reqs.map((r) => r.id).sort()).toEqual([
      "req-forbid-a-to-c",
      "req-ordered-a-b-c",
      "req-terminal-failure",
    ]);
    expect(reqs.find((r) => r.id === "req-forbid-a-to-c")?.negativeInvariant).toBe(true);
  });

  it("parses object-map and array coverage_map forms", () => {
    const asMap = parseCoverageMap({
      "req-ordered-a-b-c": { disposition: "covered", child_story_ids: ["s1"] },
    });
    expect(asMap.errors).toEqual([]);
    expect(asMap.entries).toHaveLength(1);

    const asArray = parseCoverageMap([
      {
        parent_requirement_id: "req-ordered-a-b-c",
        disposition: "deferred",
        provenance: { reason: "later", target_path: "xbrief/proposed/later.xbrief.json" },
      },
    ]);
    expect(asArray.errors).toEqual([]);
    expect(asArray.entries[0]?.disposition).toBe("deferred");
  });

  it("rejects unknown disposition and incomplete deferred side fields", () => {
    const badDisp = parseCoverageMap({
      "req-x": { disposition: "maybe" },
    });
    expect(badDisp.errors.some((e) => e.includes("disposition"))).toBe(true);

    const badDeferred = parseCoverageMap({
      "req-x": { disposition: "deferred", provenance: { reason: "only" } },
    });
    expect(badDeferred.errors.some((e) => e.includes("target_story_id"))).toBe(true);
  });

  it("rejects behavioral_delta without delta_id and incomplete delta records", () => {
    const noId = parseCoverageMap({
      "req-x": { disposition: "behavioral_delta" },
    });
    expect(noId.errors.some((e) => e.includes("delta_id"))).toBe(true);

    const incomplete = parseBehavioralDeltas([{ delta_id: "d1", change_kind: "remove_invariant" }]);
    expect(incomplete.errors.some((e) => e.includes("missing/invalid"))).toBe(true);
  });

  it("fails incomplete coverage listing uncovered IDs", () => {
    const result = validateCoverageMap({
      parent: abcParent,
      draft: {
        coverage_map: {
          "req-ordered-a-b-c": { disposition: "covered", child_story_ids: ["s1"] },
        },
      },
      storyIds: ["s1"],
    });
    expect(result.ok).toBe(false);
    expect(result.report.uncovered.sort()).toEqual(["req-forbid-a-to-c", "req-terminal-failure"]);
  });

  it("fails silent removal of negative invariant", () => {
    const result = validateCoverageMap({
      parent: abcParent,
      draft: {
        coverage_map: {
          "req-ordered-a-b-c": { disposition: "covered" },
          "req-terminal-failure": { disposition: "covered" },
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("silent removal"))).toBe(true);
  });

  it("accepts full A-B-C map and formats COVERAGE_REPORT line", () => {
    const result = validateCoverageMap({
      parent: abcParent,
      draft: {
        coverage_map: {
          "req-ordered-a-b-c": { disposition: "covered", child_story_ids: ["s1"] },
          "req-forbid-a-to-c": { disposition: "covered", child_story_ids: ["s1"] },
          "req-terminal-failure": { disposition: "covered", child_story_ids: ["s1"] },
        },
      },
      storyIds: ["s1"],
    });
    expect(result.ok).toBe(true);
    const line = formatCoverageReportLine(result.report);
    expect(line.startsWith("COVERAGE_REPORT ")).toBe(true);
    expect(JSON.parse(line.slice("COVERAGE_REPORT ".length)).ok).toBe(true);
  });

  it("links behavioral_delta disposition to a complete delta record", () => {
    const missing = validateCoverageMap({
      parent: abcParent,
      draft: {
        coverage_map: {
          "req-ordered-a-b-c": { disposition: "covered" },
          "req-forbid-a-to-c": { disposition: "behavioral_delta", delta_id: "delta-1" },
          "req-terminal-failure": { disposition: "covered" },
        },
        behavioral_deltas: [],
      },
    });
    expect(missing.ok).toBe(false);
    expect(missing.errors.some((e) => e.includes("no linked record"))).toBe(true);

    const ok = validateCoverageMap({
      parent: abcParent,
      draft: {
        coverage_map: {
          "req-ordered-a-b-c": { disposition: "covered" },
          "req-forbid-a-to-c": { disposition: "behavioral_delta", delta_id: "delta-1" },
          "req-terminal-failure": { disposition: "covered" },
        },
        behavioral_deltas: [
          {
            delta_id: "delta-1",
            parent_requirement_ids: ["req-forbid-a-to-c"],
            change_kind: "remove_invariant",
            summary: "Allow shortcut",
            before: "forbid A-to-C",
            after: "allow A-to-C",
            rationale: "operator approved recovery path",
          },
        ],
      },
    });
    expect(ok.ok).toBe(true);
  });

  it("no-ops when parent has no authored requirement IDs", () => {
    const result = validateCoverageMap({
      parent: { plan: { items: [], metadata: { kind: "phase" } } },
      draft: { stories: [] },
    });
    expect(result.ok).toBe(true);
    expect(result.report.parent_requirement_ids).toEqual([]);
  });

  it("extracts requirements from plan.requirements, metadata, and nested items", () => {
    const parent = {
      plan: {
        items: [
          {
            id: "outer",
            title: "Outer",
            items: [{ id: "nested", title: "Nested", status: "pending" }],
            subItems: [
              {
                id: "sub-neg",
                negative_invariant: true,
                title: "Sub neg",
              },
            ],
          },
        ],
        requirements: [
          "req-string",
          { id: "req-obj", title: "Obj", type: "negative_invariant" },
          { notAnId: true },
          42,
        ],
        metadata: {
          kind: "epic",
          requirement_ids: ["meta-a", ""],
          requirementIds: ["meta-b"],
        },
      },
    };
    const reqs = extractParentRequirements(parent);
    const ids = reqs.map((r) => r.id);
    expect(ids).toContain("outer");
    expect(ids).toContain("nested");
    expect(ids).toContain("sub-neg");
    expect(ids).toContain("req-string");
    expect(ids).toContain("req-obj");
    expect(ids).toContain("meta-a");
    expect(ids).toContain("meta-b");
    expect(reqs.find((r) => r.id === "sub-neg")?.negativeInvariant).toBe(true);
    expect(reqs.find((r) => r.id === "req-obj")?.negativeInvariant).toBe(true);
  });

  it("marks negative invariants via narrative and camelCase flags", () => {
    const parent = {
      plan: {
        items: [
          {
            id: "n1",
            negativeInvariant: true,
            title: "camel",
          },
          {
            id: "n2",
            narrative: { NegativeInvariant: true },
          },
          {
            id: "n3",
            narrative: { negative_invariant: true },
          },
          { id: "plain", title: "plain" },
        ],
      },
    };
    const reqs = extractParentRequirements(parent);
    expect(
      reqs
        .filter((r) => r.negativeInvariant)
        .map((r) => r.id)
        .sort(),
    ).toEqual(["n1", "n2", "n3"]);
  });

  it("returns empty for non-object parent", () => {
    expect(extractParentRequirements(null)).toEqual([]);
    expect(extractParentRequirements("x")).toEqual([]);
    expect(extractParentRequirements([])).toEqual([]);
  });

  it("rejects malformed coverage_map shapes and unknown parent IDs", () => {
    expect(parseCoverageMap(null).entries).toEqual([]);
    expect(parseCoverageMap("nope").errors.some((e) => e.includes("object map"))).toBe(true);
    expect(parseCoverageMap([null, "x"]).errors.length).toBeGreaterThan(0);
    expect(
      parseCoverageMap([{ disposition: "covered" }]).errors.some((e) =>
        e.includes("parent_requirement_id"),
      ),
    ).toBe(true);
    expect(
      parseCoverageMap({ bad: "not-object" }).errors.some((e) => e.includes("must be an object")),
    ).toBe(true);

    const unknown = validateCoverageMap({
      parent: abcParent,
      draft: {
        coverage_map: {
          "req-ordered-a-b-c": { disposition: "covered" },
          "req-forbid-a-to-c": { disposition: "covered" },
          "req-terminal-failure": { disposition: "covered" },
          "req-not-on-parent": { disposition: "covered" },
        },
      },
    });
    expect(unknown.ok).toBe(false);
    expect(unknown.errors.some((e) => e.includes("unknown parent_requirement_id"))).toBe(true);
  });

  it("validates split side fields and incomplete groups", () => {
    const missingGroup = parseCoverageMap({
      r: { disposition: "split", part: "1" },
    });
    expect(missingGroup.errors.some((e) => e.includes("split_group"))).toBe(true);
    const missingPart = parseCoverageMap({
      r: { disposition: "split", split_group: "g" },
    });
    expect(missingPart.errors.some((e) => e.includes("part"))).toBe(true);

    const incomplete = validateCoverageMap({
      parent: { plan: { items: [{ id: "r1" }, { id: "r2" }] } },
      draft: {
        coverage_map: [
          {
            parent_requirement_id: "r1",
            disposition: "split",
            split_group: "g",
            part: "1",
          },
          { parent_requirement_id: "r2", disposition: "covered" },
        ],
      },
    });
    expect(incomplete.ok).toBe(false);
    expect(incomplete.errors.some((e) => e.includes("incomplete"))).toBe(true);
  });

  it("rejects unknown child_story_ids and deferred without reason", () => {
    const badChild = validateCoverageMap({
      parent: abcParent,
      draft: {
        coverage_map: {
          "req-ordered-a-b-c": { disposition: "covered", child_story_ids: ["missing"] },
          "req-forbid-a-to-c": { disposition: "covered", child_story_ids: ["s1"] },
          "req-terminal-failure": { disposition: "covered", child_story_ids: ["s1"] },
        },
      },
      storyIds: ["s1"],
    });
    expect(badChild.ok).toBe(false);
    expect(badChild.errors.some((e) => e.includes("unknown story"))).toBe(true);

    const noReason = parseCoverageMap({
      r: { disposition: "deferred", target_path: "x" },
    });
    expect(noReason.errors.some((e) => e.includes("reason"))).toBe(true);

    const deferredOk = parseCoverageMap({
      r: {
        disposition: "deferred",
        provenance: { reason: "later", target_story_id: "future" },
      },
    });
    expect(deferredOk.errors).toEqual([]);
    expect(deferredOk.entries[0]?.provenance?.target_story_id).toBe("future");
  });

  it("rejects incomplete and duplicate behavioral delta records", () => {
    expect(parseBehavioralDeltas("x").errors.some((e) => e.includes("array"))).toBe(true);
    expect(parseBehavioralDeltas([null]).errors.length).toBeGreaterThan(0);
    const dup = parseBehavioralDeltas([
      {
        delta_id: "d1",
        parent_requirement_ids: ["r"],
        change_kind: "other",
        summary: "s",
        before: "b",
        after: "a",
        rationale: "why",
      },
      {
        delta_id: "d1",
        parent_requirement_ids: ["r"],
        change_kind: "other",
        summary: "s",
        before: "b",
        after: "a",
        rationale: "why",
      },
    ]);
    expect(dup.errors.some((e) => e.includes("duplicate"))).toBe(true);

    const mismatch = validateCoverageMap({
      parent: abcParent,
      draft: {
        coverage_map: {
          "req-ordered-a-b-c": { disposition: "covered" },
          "req-forbid-a-to-c": {
            disposition: "behavioral_delta",
            delta_id: "delta-x",
          },
          "req-terminal-failure": { disposition: "covered" },
        },
        behavioral_deltas: [
          {
            delta_id: "delta-x",
            parent_requirement_ids: ["req-ordered-a-b-c"],
            change_kind: "weaken_invariant",
            summary: "s",
            before: "b",
            after: "a",
            rationale: "r",
          },
        ],
      },
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.errors.some((e) => e.includes("does not list parent_requirement_id"))).toBe(
      true,
    );
  });

  it("accepts camelCase draft keys and empty coverage when parent has IDs", () => {
    const camel = validateCoverageMap({
      parent: abcParent,
      draft: {
        coverageMap: {
          "req-ordered-a-b-c": { disposition: "covered", childStoryIds: ["s1"] },
          "req-forbid-a-to-c": { disposition: "covered" },
          "req-terminal-failure": {
            disposition: "deferred",
            provenance: { reason: "later", targetPath: "xbrief/proposed/t.xbrief.json" },
          },
        },
      },
      storyIds: ["s1"],
    });
    expect(camel.ok).toBe(true);

    const emptyMap = validateCoverageMap({
      parent: abcParent,
      draft: { coverage_map: {} },
    });
    expect(emptyMap.ok).toBe(false);
    expect(emptyMap.errors.some((e) => e.includes("coverage_map is required"))).toBe(true);
  });

  it("rejects conflicting or duplicate non-split entries for the same parent ID", () => {
    const conflicting = validateCoverageMap({
      parent: abcParent,
      draft: {
        coverage_map: [
          {
            parent_requirement_id: "req-ordered-a-b-c",
            disposition: "covered",
            child_story_ids: ["s1"],
          },
          {
            parent_requirement_id: "req-ordered-a-b-c",
            disposition: "deferred",
            provenance: { reason: "later", target_path: "xbrief/proposed/t.xbrief.json" },
          },
          {
            parent_requirement_id: "req-forbid-a-to-c",
            disposition: "covered",
          },
          {
            parent_requirement_id: "req-terminal-failure",
            disposition: "covered",
          },
        ],
      },
      storyIds: ["s1"],
    });
    expect(conflicting.ok).toBe(false);
    expect(conflicting.errors.some((e) => e.includes("conflicting dispositions"))).toBe(true);

    const duplicateSame = validateCoverageMap({
      parent: abcParent,
      draft: {
        coverage_map: [
          {
            parent_requirement_id: "req-ordered-a-b-c",
            disposition: "covered",
            child_story_ids: ["s1"],
          },
          {
            parent_requirement_id: "req-ordered-a-b-c",
            disposition: "covered",
            child_story_ids: ["s2"],
          },
          {
            parent_requirement_id: "req-forbid-a-to-c",
            disposition: "covered",
          },
          {
            parent_requirement_id: "req-terminal-failure",
            disposition: "covered",
          },
        ],
      },
      storyIds: ["s1", "s2"],
    });
    expect(duplicateSame.ok).toBe(false);
    expect(duplicateSame.errors.some((e) => e.includes("duplicate coverage entries"))).toBe(true);
  });

  it("covers remaining extract/parse edge branches", () => {
    // asStrList: empty string, non-list scalar, string list metadata
    const parent = {
      plan: {
        items: [
          null,
          "skip",
          { id: "  ", title: "blank-id" },
          { id: "dup", title: "first" },
          { id: "dup", kind: "negative_invariant", title: "" },
          { id: "kind-type", type: "negative_invariant" },
        ],
        requirements: [{ id: "req-neg", kind: "negative_invariant", title: "n" }],
        metadata: { requirement_ids: "single-id", requirementIds: 12 },
      },
    };
    const reqs = extractParentRequirements(parent);
    expect(reqs.find((r) => r.id === "dup")?.negativeInvariant).toBe(true);
    expect(reqs.find((r) => r.id === "dup")?.title).toBe("first");
    expect(reqs.some((r) => r.id === "single-id")).toBe(true);
    expect(reqs.find((r) => r.id === "kind-type")?.negativeInvariant).toBe(true);
    expect(reqs.find((r) => r.id === "req-neg")?.negativeInvariant).toBe(true);

    // disposition non-string; change_kind hyphen and invalid
    expect(parseCoverageMap({ r: { disposition: 1 } }).errors.length).toBeGreaterThan(0);
    expect(
      parseBehavioralDeltas([
        {
          deltaId: "camel-d",
          parentRequirementIds: ["r"],
          changeKind: "remove-invariant",
          summary: "s",
          before: "b",
          after: "a",
          rationale: "why",
        },
      ]).deltas,
    ).toHaveLength(1);
    expect(
      parseBehavioralDeltas([
        {
          delta_id: "bad-kind",
          parent_requirement_ids: ["r"],
          change_kind: "not-a-kind",
          summary: "s",
          before: "b",
          after: "a",
          rationale: "why",
        },
      ]).errors.some((e) => e.includes("change_kind")),
    ).toBe(true);
    expect(
      parseBehavioralDeltas([
        {
          delta_id: "no-parents",
          parent_requirement_ids: [],
          change_kind: "other",
          summary: "s",
          before: "b",
          after: "a",
          rationale: "why",
        },
      ]).errors.some((e) => e.includes("parent_requirement_ids")),
    ).toBe(true);

    // object-map with empty parent_requirement_id override
    expect(
      parseCoverageMap({
        "": { disposition: "covered", parent_requirement_id: "  " },
      }).errors.some((e) => e.includes("parent_requirement_id")),
    ).toBe(true);

    // non-object draft falls through
    const nonObjDraft = validateCoverageMap({
      parent: abcParent,
      draft: null,
    });
    expect(nonObjDraft.ok).toBe(false);

    // complete split so incomplete-parts branch is not taken (hit size>=2 arm)
    const completeSplit = validateCoverageMap({
      parent: { plan: { items: [{ id: "r1" }] } },
      draft: {
        coverage_map: [
          {
            parent_requirement_id: "r1",
            disposition: "split",
            split_group: "g",
            part: "1",
          },
          {
            parent_requirement_id: "r1",
            disposition: "split",
            split_group: "g",
            part: "2",
          },
        ],
      },
    });
    expect(completeSplit.ok).toBe(true);

    // missing delta_id path inside validate (parse error + entry report)
    const missDelta = validateCoverageMap({
      parent: { plan: { items: [{ id: "r1", kind: "negative_invariant" }] } },
      draft: {
        coverage_map: [{ parent_requirement_id: "r1", disposition: "behavioral_delta" }],
      },
    });
    expect(missDelta.ok).toBe(false);
  });
});
