/**
 * Head-bound merge approval (#3235) — SHA contract, stale multi-push, auto-merge disable.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BehavioralEventRecord } from "../lifecycle/events.js";
import {
  buildMergeApprovalRecovery,
  enforceMergeApprovalHead,
  evaluateMergeApprovalHead,
  findLatestPlanApprovalForPr,
  headShaMatches,
} from "./merge-approval-head.js";

const HEAD_A = "727ab9306ef3b179eee94f6d6df5aef178ae18aa";
const HEAD_B = "dfee15a518cb0277dd09edd47577acba1fd3426b";
const HEAD_C = "8454cc81ba780266055231a3cc49c5bb9b6c181d";

function planApproved(
  pr: number,
  headSha: string | null,
  opts: { approver?: string; at?: string } = {},
): BehavioralEventRecord {
  const payload: Record<string, unknown> = {
    plan_ref: `https://github.com/example/repo/pull/${pr}`,
    approver: opts.approver ?? "operator",
    pr_number: pr,
    approval_phrase: "yes",
  };
  if (headSha !== null) {
    payload.head_sha = headSha;
  }
  return {
    id: `evt-${pr}-${headSha ?? "none"}`,
    event: "plan:approved",
    category: "behavioral",
    detected_at: opts.at ?? "2026-08-10T00:00:00.000Z",
    payload,
  };
}

describe("headShaMatches", () => {
  it("matches only exact full SHAs", () => {
    expect(headShaMatches(HEAD_A, HEAD_A)).toBe(true);
  });
  it("rejects abbreviated or different heads (no prefix authorize)", () => {
    expect(headShaMatches(HEAD_A, HEAD_A.slice(0, 12))).toBe(false);
    expect(headShaMatches(HEAD_A.slice(0, 7), HEAD_A)).toBe(false);
    expect(headShaMatches(HEAD_A, HEAD_B)).toBe(false);
  });
});

describe("findLatestPlanApprovalForPr", () => {
  it("returns latest approval for the PR across multi-push history", () => {
    const records = [
      planApproved(525, HEAD_A, { at: "2026-08-01T00:00:00.000Z" }),
      planApproved(999, HEAD_B),
      planApproved(525, HEAD_B, { at: "2026-08-02T00:00:00.000Z" }),
    ];
    const latest = findLatestPlanApprovalForPr(525, { records });
    expect(latest?.head_sha).toBe(HEAD_B);
  });

  it("does not fall back to unscoped same-number approval when repo is set", () => {
    const foreign: BehavioralEventRecord = {
      id: "foreign",
      event: "plan:approved",
      category: "behavioral",
      detected_at: "2026-08-01T00:00:00.000Z",
      payload: {
        plan_ref: "https://github.com/other/repo/pull/525",
        repository: "other/repo",
        approver: "x",
        pr_number: 525,
        head_sha: HEAD_A,
      },
    };
    const latest = findLatestPlanApprovalForPr(525, {
      records: [foreign],
      repo: "3Ci-Consulting/runbound",
    });
    expect(latest).toBeNull();
  });

  it("returns null when no approval for PR", () => {
    expect(findLatestPlanApprovalForPr(1, { records: [planApproved(2, HEAD_A)] })).toBeNull();
  });
});

describe("evaluateMergeApprovalHead", () => {
  it("allows when approved_head_sha == current_head_sha", () => {
    const r = evaluateMergeApprovalHead({
      prNumber: 525,
      currentHeadSha: HEAD_A,
      records: [planApproved(525, HEAD_A)],
      requireHumanMerge: true,
    });
    expect(r.status).toBe("ok");
    expect(r.allowed).toBe(true);
    expect(r.recovery).toBeNull();
  });

  it("fails closed when HEAD changes after approval (single push)", () => {
    const r = evaluateMergeApprovalHead({
      prNumber: 525,
      currentHeadSha: HEAD_B,
      records: [planApproved(525, HEAD_A)],
      requireHumanMerge: true,
    });
    expect(r.status).toBe("stale");
    expect(r.allowed).toBe(false);
    expect(r.approved_head_sha).toBe(HEAD_A);
    expect(r.current_head_sha).toBe(HEAD_B);
    expect(r.message).toContain("#3235");
    expect(r.recovery).toContain("Recovery");
    expect(r.recovery).toContain("--head-sha");
  });

  it("fails closed across multi-push auto-merge retention (A then B then C)", () => {
    // Repro class from #3235: approval on A, later commits B and C with auto-merge still on.
    const records = [planApproved(525, HEAD_A)];
    for (const head of [HEAD_B, HEAD_C]) {
      const r = evaluateMergeApprovalHead({
        prNumber: 525,
        currentHeadSha: head,
        records,
        requireHumanMerge: true,
      });
      expect(r.allowed).toBe(false);
      expect(r.status).toBe("stale");
      expect(r.approved_head_sha).toBe(HEAD_A);
      expect(r.current_head_sha).toBe(head);
    }
  });

  it("fails closed when approval lacks head_sha binding under strict mode", () => {
    const r = evaluateMergeApprovalHead({
      prNumber: 10,
      currentHeadSha: HEAD_A,
      records: [planApproved(10, null)],
      requireHumanMerge: true,
      enforceStrictBinding: true,
    });
    expect(r.status).toBe("missing_binding");
    expect(r.allowed).toBe(false);
    expect(r.recovery).toContain("--head-sha");
  });

  it("allows when no plan:approved exists for the PR", () => {
    const r = evaluateMergeApprovalHead({
      prNumber: 42,
      currentHeadSha: HEAD_A,
      records: [],
      requireHumanMerge: true,
    });
    expect(r.status).toBe("no_approval");
    expect(r.allowed).toBe(true);
  });

  it("still enforces stale approval when requireHumanMerge is false but approval present", () => {
    const r = evaluateMergeApprovalHead({
      prNumber: 3,
      currentHeadSha: HEAD_C,
      records: [planApproved(3, HEAD_A)],
      requireHumanMerge: false,
      enforceWhenApprovalPresent: true,
    });
    expect(r.allowed).toBe(false);
    expect(r.status).toBe("stale");
  });
});

describe("enforceMergeApprovalHead", () => {
  it("disables auto-merge on stale approval and returns recovery", () => {
    const disableCalls: Array<[number, string | null]> = [];
    const r = enforceMergeApprovalHead({
      prNumber: 525,
      // omit repo so fixture plan_ref (example/repo) still matches by PR number
      currentHeadSha: HEAD_C,
      records: [planApproved(525, HEAD_A)],
      requireHumanMerge: true,
      disableAutoMergeOnDeny: true,
      disableAutoMergeFn: (pr, repo) => {
        disableCalls.push([pr, repo]);
        return { ok: true, stderr: "" };
      },
    });
    expect(r.allowed).toBe(false);
    expect(r.status).toBe("stale");
    expect(r.auto_merge_disabled).toBe(true);
    expect(disableCalls).toEqual([[525, null]]);
    expect(r.recovery).toContain("auto-merge was disabled");
    expect(r.recovery).toContain(HEAD_C);
  });

  it("reports recovery when auto-merge disable fails", () => {
    const r = enforceMergeApprovalHead({
      prNumber: 1,
      currentHeadSha: HEAD_B,
      records: [planApproved(1, HEAD_A)],
      requireHumanMerge: true,
      disableAutoMergeFn: () => ({ ok: false, stderr: "permission denied" }),
    });
    expect(r.auto_merge_disabled).toBe(false);
    expect(r.recovery).toContain("--disable-auto");
  });

  it("does not call disable when approval is ok", () => {
    let called = false;
    const r = enforceMergeApprovalHead({
      prNumber: 2,
      currentHeadSha: HEAD_A,
      records: [planApproved(2, HEAD_A)],
      disableAutoMergeFn: () => {
        called = true;
        return { ok: true, stderr: "" };
      },
    });
    expect(r.allowed).toBe(true);
    expect(called).toBe(false);
    expect(r.auto_merge_disabled).toBeNull();
  });

  it("reads plan:approved from project event log on disk", () => {
    const root = mkdtempSync(join(tmpdir(), "merge-appr-"));
    mkdirSync(join(root, ".deft-cache"), { recursive: true });
    const line = JSON.stringify(planApproved(77, HEAD_A));
    writeFileSync(join(root, ".deft-cache", "events.jsonl"), `${line}\n`, "utf8");
    const r = evaluateMergeApprovalHead({
      prNumber: 77,
      projectRoot: root,
      currentHeadSha: HEAD_B,
      requireHumanMerge: true,
    });
    expect(r.status).toBe("stale");
    expect(r.allowed).toBe(false);
  });
});

describe("buildMergeApprovalRecovery", () => {
  it("includes both SHAs and re-approval command", () => {
    const text = buildMergeApprovalRecovery({
      prNumber: 525,
      approvedHeadSha: HEAD_A,
      currentHeadSha: HEAD_C,
      status: "stale",
      autoMergeDisabled: true,
    });
    expect(text).toContain(HEAD_A);
    expect(text).toContain(HEAD_C);
    expect(text).toContain("--pr-number 525");
    expect(text).toContain(`--head-sha ${HEAD_C}`);
  });
});
