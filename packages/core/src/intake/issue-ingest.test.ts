import { describe, expect, it } from "vitest";
import {
  buildIssueVbrief,
  extractCrossRefs,
  extractPlanItems,
  provenanceIssueNumber,
} from "./issue-ingest.js";

describe("buildIssueVbrief", () => {
  it("maps checkbox body to plan items", () => {
    const body = "## Acceptance Criteria\n- [ ] Widget renders\n- [x] Spec updated\n";
    const [vbrief] = buildIssueVbrief(
      {
        number: 500,
        title: "Widget support",
        url: "https://github.com/owner/repo/issues/500",
        body,
        labels: [],
      },
      "proposed",
      "https://github.com/owner/repo",
    );
    const plan = vbrief.plan as Record<string, unknown>;
    expect(plan.items).toEqual([
      { title: "Widget renders", status: "proposed" },
      { title: "Spec updated", status: "completed" },
    ]);
    expect((plan.narratives as Record<string, string>).Overview).toContain("Acceptance Criteria");
  });
});

describe("extractCrossRefs", () => {
  it("extracts closes/refs/blocks outside code spans", () => {
    const body = "Closes #10\nRefs #11\nBlocked by #12\n```\nCloses #99\n```";
    const refs = extractCrossRefs(body, "https://github.com/o/r", new Set());
    expect(refs.map((r) => r.type)).toEqual([
      "x-vbrief/closes",
      "x-vbrief/blocks",
      "x-vbrief/refs",
    ]);
  });
});

describe("extractPlanItems", () => {
  it("returns empty for body without structure", () => {
    expect(extractPlanItems("Just prose, no checklist.")).toEqual([]);
  });
});

describe("provenanceIssueNumber", () => {
  it("reads issue number from Origin URL", () => {
    expect(
      provenanceIssueNumber({
        plan: { narratives: { Origin: "Ingested from https://github.com/o/r/issues/42" } },
      }),
    ).toBe(42);
  });
});
