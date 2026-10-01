import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  immutableProjectionDigest,
  projectionsEqual,
  stripNamespacedEvidenceSlots,
} from "./immutable-projection.js";

describe("immutable-projection (#4714)", () => {
  it("strips only namespaced evidence/disposition on plan.items", () => {
    const input = {
      plan: {
        id: "s",
        items: [
          {
            id: "c1",
            status: "pending",
            "x-directive/evidence": { kind: "test" },
            "x-directive/disposition": { status: "waived" },
          },
        ],
      },
    };
    const stripped = stripNamespacedEvidenceSlots(input) as {
      plan: { items: Array<Record<string, unknown>> };
    };
    expect(stripped.plan.items[0]?.["x-directive/evidence"]).toBeUndefined();
    expect(stripped.plan.items[0]?.["x-directive/disposition"]).toBeUndefined();
    expect(stripped.plan.items[0]?.id).toBe("c1");
  });

  it("canonicalJson sorts object keys", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("digest equality ignores evidence-only edits", () => {
    const left = { plan: { items: [{ id: "c1", command: "t" }] } };
    const right = {
      plan: {
        items: [{ id: "c1", command: "t", "x-directive/evidence": { kind: "test" } }],
      },
    };
    expect(projectionsEqual(left, right)).toBe(true);
    expect(immutableProjectionDigest(left)).toHaveLength(64);
  });
});
