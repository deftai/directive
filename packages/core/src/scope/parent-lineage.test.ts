/**
 * Unit tests for parent-lineage gates (#3241 / epic #3237).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildParentLineageArtifact,
  evaluateParentLineage,
  evaluateParentLineageAtPath,
  extractChildCoverageDraft,
  findLifecycleRootFromArtifact,
  formatParentLineageLine,
  PARENT_LINEAGE_SCHEMA,
  resolveParentPathFromRef,
} from "./parent-lineage.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) {
    rmSync(t, { recursive: true, force: true });
  }
});

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
      },
      {
        id: "req-forbid-a-to-c",
        title: "Forbidden shortcut A to C",
        kind: "negative_invariant",
        status: "pending",
      },
      {
        id: "req-terminal-failure",
        title: "Terminal failure path",
        status: "pending",
      },
    ],
    metadata: { kind: "epic" },
  },
};

const fullCoverageMap = {
  "req-ordered-a-b-c": { disposition: "covered", child_story_ids: ["s1"] },
  "req-forbid-a-to-c": { disposition: "covered", child_story_ids: ["s1"] },
  "req-terminal-failure": { disposition: "covered", child_story_ids: ["s1"] },
};

function childWithLineage(opts: {
  planRef?: string;
  coverage_map?: unknown;
  behavioral_deltas?: unknown;
  omitLineage?: boolean;
}): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    kind: "story",
    swarm: { readiness: "ready" },
  };
  if (!opts.omitLineage && opts.coverage_map !== undefined) {
    metadata.parent_lineage = buildParentLineageArtifact({
      coverage_map: opts.coverage_map,
      behavioral_deltas: opts.behavioral_deltas,
      parent_requirement_ids: ["req-ordered-a-b-c", "req-forbid-a-to-c", "req-terminal-failure"],
      negative_invariant_ids: ["req-forbid-a-to-c"],
    });
  }
  return {
    xBRIEFInfo: { version: "0.8" },
    plan: {
      id: "s1",
      title: "Child story",
      status: "running",
      ...(opts.planRef !== undefined ? { planRef: opts.planRef } : {}),
      items: [],
      metadata,
    },
  };
}

describe("parent-lineage helpers (#3241)", () => {
  it("buildParentLineageArtifact stamps schema and maps", () => {
    const art = buildParentLineageArtifact({
      coverage_map: fullCoverageMap,
      parent_requirement_ids: ["a"],
      negative_invariant_ids: ["b"],
    });
    expect(art.schema).toBe(PARENT_LINEAGE_SCHEMA);
    expect(art.coverage_map).toEqual(fullCoverageMap);
    expect(art.parent_requirement_ids).toEqual(["a"]);
  });

  it("extractChildCoverageDraft prefers plan.metadata.parent_lineage", () => {
    const child = childWithLineage({ coverage_map: fullCoverageMap });
    const extracted = extractChildCoverageDraft(child);
    expect(extracted.hasCoverageMapKey).toBe(true);
    expect(extracted.source).toBe("plan.metadata.parent_lineage");
  });

  it("resolveParentPathFromRef rejects absolute and .. traversal", () => {
    const root = join(tmpdir(), "lifecycle-root");
    expect(resolveParentPathFromRef("../escape.json", root).error).toMatch(/traversal/);
    expect(resolveParentPathFromRef("/abs/path.json", root).error).toMatch(/absolute/);
  });

  it("findLifecycleRootFromArtifact walks to xbrief/", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-pl-"));
    temps.push(base);
    const active = join(base, "xbrief", "active");
    mkdirSync(active, { recursive: true });
    const childPath = join(active, "story.xbrief.json");
    writeFileSync(childPath, "{}", "utf8");
    expect(findLifecycleRootFromArtifact(childPath)?.replace(/\\/g, "/")).toMatch(/\/xbrief$/);
  });
});

describe("evaluateParentLineage (#3241)", () => {
  it("N/A when child has no planRef", () => {
    const result = evaluateParentLineage({
      child: { plan: { status: "running", metadata: { kind: "story" } } },
    });
    expect(result.ok).toBe(true);
    expect(result.applicable).toBe(false);
    expect(result.message).toMatch(/N\/A/);
  });

  it("N/A when parent authors no requirement IDs", () => {
    const result = evaluateParentLineage({
      child: childWithLineage({ planRef: "pending/parent.xbrief.json", omitLineage: true }),
      parent: {
        plan: { id: "p", items: [{ title: "no id", status: "pending" }] },
      },
      parentPath: "/virtual/parent.xbrief.json",
    });
    expect(result.ok).toBe(true);
    expect(result.applicable).toBe(false);
  });

  it("fails closed when child missing coverage artifacts after parent authors IDs", () => {
    const result = evaluateParentLineage({
      child: childWithLineage({
        planRef: "pending/parent.xbrief.json",
        omitLineage: true,
      }),
      parent: abcParent,
      parentPath: "/virtual/parent.xbrief.json",
    });
    expect(result.ok).toBe(false);
    expect(result.applicable).toBe(true);
    expect(result.defect_class).toBe("child_spec");
    expect(result.message).toMatch(/missing parent coverage/i);
    expect(result.parent_requirement_ids).toContain("req-forbid-a-to-c");
  });

  it("fails closed when negative invariant omitted without behavioral_delta (pre-PR lineage)", () => {
    const result = evaluateParentLineage({
      child: childWithLineage({
        planRef: "pending/parent.xbrief.json",
        coverage_map: {
          "req-ordered-a-b-c": { disposition: "covered" },
          // req-forbid-a-to-c intentionally omitted — contradiction without approved delta
          "req-terminal-failure": { disposition: "covered" },
        },
      }),
      parent: abcParent,
      parentPath: "/virtual/parent.xbrief.json",
    });
    expect(result.ok).toBe(false);
    expect(result.defect_class).toBe("parent_child_drift");
    expect(result.errors.some((e) => e.includes("req-forbid-a-to-c"))).toBe(true);
    expect(result.errors.some((e) => /negative invariant|silent removal/i.test(e))).toBe(true);
  });

  it("fails closed on undeclared behavioral_delta (missing linked delta record)", () => {
    const result = evaluateParentLineage({
      child: childWithLineage({
        planRef: "pending/parent.xbrief.json",
        coverage_map: {
          "req-ordered-a-b-c": { disposition: "covered" },
          "req-forbid-a-to-c": {
            disposition: "behavioral_delta",
            delta_id: "delta-remove-forbid",
          },
          "req-terminal-failure": { disposition: "covered" },
        },
        // no behavioral_deltas array — undeclared
      }),
      parent: abcParent,
      parentPath: "/virtual/parent.xbrief.json",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /delta_id|behavioral_delta|no linked/i.test(e))).toBe(true);
  });

  it("passes when full coverage and no contradictions", () => {
    const result = evaluateParentLineage({
      child: childWithLineage({
        planRef: "pending/parent.xbrief.json",
        coverage_map: fullCoverageMap,
      }),
      parent: abcParent,
      parentPath: "/virtual/parent.xbrief.json",
    });
    expect(result.ok).toBe(true);
    expect(result.applicable).toBe(true);
    expect(result.defect_class).toBeNull();
    expect(result.parent_requirement_ids).toHaveLength(3);
    expect(result.negative_invariant_ids).toEqual(["req-forbid-a-to-c"]);
    expect(result.message).toMatch(/OK/);
  });

  it("passes with approved behavioral_delta for negative invariant", () => {
    const result = evaluateParentLineage({
      child: childWithLineage({
        planRef: "pending/parent.xbrief.json",
        coverage_map: {
          "req-ordered-a-b-c": { disposition: "covered" },
          "req-forbid-a-to-c": {
            disposition: "behavioral_delta",
            delta_id: "delta-remove-forbid",
          },
          "req-terminal-failure": { disposition: "covered" },
        },
        behavioral_deltas: [
          {
            delta_id: "delta-remove-forbid",
            parent_requirement_ids: ["req-forbid-a-to-c"],
            change_kind: "remove_invariant",
            summary: "Allow A→C in this child",
            before: "A→C forbidden",
            after: "A→C allowed with guard",
            rationale: "Product amendment",
          },
        ],
      }),
      parent: abcParent,
      parentPath: "/virtual/parent.xbrief.json",
    });
    expect(result.ok).toBe(true);
    expect(result.applicable).toBe(true);
  });

  it("formatParentLineageLine is machine-readable", () => {
    const result = evaluateParentLineage({
      child: childWithLineage({
        planRef: "pending/parent.xbrief.json",
        coverage_map: fullCoverageMap,
      }),
      parent: abcParent,
      parentPath: "/virtual/parent.xbrief.json",
    });
    const line = formatParentLineageLine(result);
    expect(line.startsWith("PARENT_LINEAGE ")).toBe(true);
    const parsed = JSON.parse(line.slice("PARENT_LINEAGE ".length)) as {
      schema: string;
      ok: boolean;
    };
    expect(parsed.schema).toBe("deft.scope.parent_lineage_report.v1");
    expect(parsed.ok).toBe(true);
  });

  it("evaluateParentLineageAtPath loads child and parent from disk", () => {
    const base = mkdtempSync(join(tmpdir(), "deft-pl-disk-"));
    temps.push(base);
    const pending = join(base, "xbrief", "pending");
    const active = join(base, "xbrief", "active");
    mkdirSync(pending, { recursive: true });
    mkdirSync(active, { recursive: true });
    const parentPath = join(pending, "parent.xbrief.json");
    writeFileSync(parentPath, JSON.stringify(abcParent), "utf8");
    const child = childWithLineage({
      planRef: "pending/parent.xbrief.json",
      coverage_map: fullCoverageMap,
    });
    const childPath = join(active, "child.xbrief.json");
    writeFileSync(childPath, JSON.stringify(child), "utf8");

    const ok = evaluateParentLineageAtPath(childPath, { projectRoot: base });
    expect(ok.ok).toBe(true);
    expect(ok.applicable).toBe(true);

    const missing = childWithLineage({
      planRef: "pending/parent.xbrief.json",
      omitLineage: true,
    });
    const missingPath = join(active, "missing.xbrief.json");
    writeFileSync(missingPath, JSON.stringify(missing), "utf8");
    const bad = evaluateParentLineageAtPath(missingPath, { projectRoot: base });
    expect(bad.ok).toBe(false);
    expect(bad.defect_class).toBe("child_spec");
  });
});
