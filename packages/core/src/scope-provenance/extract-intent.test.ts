import { describe, expect, it } from "vitest";
import {
  ACCEPTANCE_DISPOSITION_KEY,
  ACCEPTANCE_EVIDENCE_KEY,
} from "../scope/acceptance-evidence.js";
import { extractIntentFromPayload, slugFromGithubIssueUri } from "./extract-intent.js";
import { computeIntentDigest } from "./intent-digest.js";

const evidence = {
  kind: "test",
  pointer: "packages/core/src/scope-provenance/extract-intent.test.ts",
  recorded_at: "2026-09-01T00:00:00Z",
  recorded_by: "vitest",
};

describe("extract-intent file (#3385)", () => {
  it("parses github issue slugs and extracts title", () => {
    expect(slugFromGithubIssueUri("https://github.com/deftai/directive/issues/3385")).toBe(
      "deftai/directive",
    );
    const r = extractIntentFromPayload({ plan: { id: "x", title: "Hello" } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.preimage.plan.title).toBe("Hello");
  });
});

describe("canonical evidence omit (#4059)", () => {
  it("omits top-level evidence and does not record it as unknown", () => {
    const item: Record<string, unknown> = {
      id: "i1",
      title: "first",
      status: "proposed",
    };
    item[ACCEPTANCE_EVIDENCE_KEY] = evidence;
    const r = extractIntentFromPayload({ plan: { id: "x", title: "Hello", items: [item] } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const items = r.preimage.plan.items as Array<Record<string, unknown>>;
    expect(items[0]?.[ACCEPTANCE_EVIDENCE_KEY]).toBeUndefined();
    expect(items[0]?.status).toBeUndefined();
    expect(r.preimage.unknownPaths.some((path) => path.includes("evidence"))).toBe(false);
  });

  it("omits nested items and subItems evidence; nested status and effort stay hashed", () => {
    const child: Record<string, unknown> = {
      id: "child",
      title: "child",
      status: "proposed",
      effort: "S",
    };
    child[ACCEPTANCE_EVIDENCE_KEY] = evidence;
    const parent: Record<string, unknown> = {
      id: "parent",
      title: "parent",
      status: "proposed",
      items: [child],
      subItems: [{ ...child, id: "sub" }],
    };
    const withEv = extractIntentFromPayload({
      plan: { id: "x", title: "Hello", items: [parent] },
    });
    const childBare: Record<string, unknown> = {
      id: "child",
      title: "child",
      status: "proposed",
      effort: "S",
    };
    const parentBare: Record<string, unknown> = {
      id: "parent",
      title: "parent",
      status: "proposed",
      items: [childBare],
      subItems: [{ ...childBare, id: "sub" }],
    };
    const withoutEv = extractIntentFromPayload({
      plan: { id: "x", title: "Hello", items: [parentBare] },
    });
    expect(withEv.ok).toBe(true);
    expect(withoutEv.ok).toBe(true);
    if (!withEv.ok || !withoutEv.ok) return;
    const extracted = withEv.preimage.plan.items as Array<Record<string, unknown>>;
    const inner = (extracted[0]?.items as Array<Record<string, unknown>>)[0];
    const sub = (extracted[0]?.subItems as Array<Record<string, unknown>>)[0];
    expect(inner?.[ACCEPTANCE_EVIDENCE_KEY]).toBeUndefined();
    expect(sub?.[ACCEPTANCE_EVIDENCE_KEY]).toBeUndefined();
    expect(inner?.status).toBe("proposed");
    expect(inner?.effort).toBe("S");
    expect(computeIntentDigest(withEv.preimage)).toBe(computeIntentDigest(withoutEv.preimage));
    const driftedChild: Record<string, unknown> = {
      id: "child",
      title: "child",
      status: "completed",
      effort: "S",
    };
    const drifted = extractIntentFromPayload({
      plan: {
        id: "x",
        title: "Hello",
        items: [
          {
            id: "parent",
            title: "parent",
            status: "proposed",
            items: [driftedChild],
            subItems: [{ ...driftedChild, id: "sub" }],
          },
        ],
      },
    });
    expect(drifted.ok).toBe(true);
    if (!drifted.ok) return;
    expect(computeIntentDigest(withoutEv.preimage)).not.toBe(computeIntentDigest(drifted.preimage));
  });

  it("keeps x-directive/disposition unknown", () => {
    const item: Record<string, unknown> = {
      id: "i1",
      title: "first",
    };
    item[ACCEPTANCE_DISPOSITION_KEY] = { disposition: "waived" };
    const r = extractIntentFromPayload({ plan: { id: "x", items: [item] } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const items = r.preimage.plan.items as Array<Record<string, unknown>>;
    expect(items[0]?.[ACCEPTANCE_DISPOSITION_KEY]).toEqual({ disposition: "waived" });
    expect(r.preimage.unknownPaths).toContain("items[].x-directive/disposition");
  });
});
