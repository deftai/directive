import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectOnePolicy } from "./index.js";
import {
  FIELD_REVIEW_REVIEWERS,
  FIELD_REVIEW_REVIEWERS_CLI_ALIAS,
  inspectReviewers,
  resolveReviewers,
} from "./reviewers.js";

function makeProject(policy?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "review-reviewers-"));
  mkdirSync(join(root, "xbrief"), { recursive: true });
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      plan: {
        title: "P",
        status: "running",
        policy: policy ?? {},
      },
    }),
    "utf8",
  );
  return root;
}

describe("resolveReviewers (#3630)", () => {
  let root = "";
  afterEach(() => {
    if (root.length > 0) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("unset when policy.review.reviewers is missing (probe, not implicit zero)", () => {
    root = makeProject({ review: { minGreptileConfidence: 5 } });
    const resolved = resolveReviewers(root);
    expect(resolved.reviewers).toBeNull();
    expect(resolved.source).toBe("unset");
  });

  it("typed empty array is explicit zero", () => {
    root = makeProject({ review: { reviewers: [] } });
    const resolved = resolveReviewers(root);
    expect(resolved.reviewers).toEqual([]);
    expect(resolved.source).toBe("typed");
  });

  it("blank-only reviewers entries do not collapse to explicit zero (#5165)", () => {
    root = makeProject({ review: { reviewers: ["", "  "] } });
    const resolved = resolveReviewers(root);
    expect(resolved.reviewers).toBeNull();
    expect(resolved.source).toBe("invalid");
    expect(resolved.error).toMatch(/blank entries/i);
  });

  it("typed non-empty list is expected reviewers", () => {
    root = makeProject({ review: { reviewers: ["greptile"] } });
    const resolved = resolveReviewers(root);
    expect(resolved.reviewers).toEqual(["greptile"]);
    expect(resolved.source).toBe("typed");
  });

  it("policy:show alias reviewers maps to the dotted path", () => {
    root = makeProject({ review: { reviewers: [] } });
    const byAlias = inspectOnePolicy(FIELD_REVIEW_REVIEWERS_CLI_ALIAS, root);
    const byPath = inspectOnePolicy(FIELD_REVIEW_REVIEWERS, root);
    expect(byAlias?.name).toBe(FIELD_REVIEW_REVIEWERS);
    expect(byPath?.current).toEqual([]);
    expect(inspectReviewers(null, root).source).toBe("typed");
  });
});
