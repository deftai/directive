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

  it("preserves inline code in acceptance-criteria checkbox titles (#1269 shape)", () => {
    const body = [
      "## Acceptance criteria",
      "",
      "- [ ] `.deft/` added to `.gitignore`",
      "- [ ] Sentinel reader + writer module (e.g. `scripts/ritual_sentinel.py`) with `read()` / `write()` / `compute_delta()` functions",
      "- [ ] `task check` passes",
    ].join("\n");
    expect(extractPlanItems(body)).toEqual([
      { title: "`.deft/` added to `.gitignore`", status: "proposed" },
      {
        title:
          "Sentinel reader + writer module (e.g. `scripts/ritual_sentinel.py`) with `read()` / `write()` / `compute_delta()` functions",
        status: "proposed",
      },
      { title: "`task check` passes", status: "proposed" },
    ]);
  });

  it("preserves inline code in acceptance-criteria checkbox titles (#1270 shape)", () => {
    const body = [
      "## Acceptance criteria",
      "",
      '- [ ] `scripts/triage_summary.py` `in-flight` count reads `len(glob("vbrief/active/*.vbrief.json"))` filtered by `plan.status == "running"` (filesystem-truth)',
      "- [ ] When `filesystem_count != cache_scoped_count`, append `[triage:scope] N in-flight outside plan.policy.triageScope[] (uncounted in queue ranking)` (loud discrepancy line)",
      "- [ ] `task check` passes",
    ].join("\n");
    expect(extractPlanItems(body)).toEqual([
      {
        title:
          '`scripts/triage_summary.py` `in-flight` count reads `len(glob("vbrief/active/*.vbrief.json"))` filtered by `plan.status == "running"` (filesystem-truth)',
        status: "proposed",
      },
      {
        title:
          "When `filesystem_count != cache_scoped_count`, append `[triage:scope] N in-flight outside plan.policy.triageScope[] (uncounted in queue ranking)` (loud discrepancy line)",
        status: "proposed",
      },
      { title: "`task check` passes", status: "proposed" },
    ]);
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
