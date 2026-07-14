import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  advancePlanSequence,
  clearPlanSequence,
  createPlanSequence,
  EXHAUSTED_FAIL_CLOSED_MESSAGE,
  isExplicitQueueAsk,
  isPlanFirstPhrase,
  parsePlanSequence,
  readPlanSequence,
  resolveContinuation,
  verifyPlanTarget,
  writePlanSequence,
} from "./index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function seed(): string {
  const root = mkdtempSync(join(tmpdir(), "plan-seq-"));
  roots.push(root);
  return root;
}

function twoPrPlan() {
  return createPlanSequence({
    sequence_id: "incident-2402",
    sequence_kind: "delivery",
    authorized_by: "PR 1 closes #2120; PR 2 closes #2118",
    entries: [
      { id: "pr-2120", kind: "pr", issue: 2120, title: "Windows session-start cache-fresh" },
      { id: "pr-2118", kind: "pr", issue: 2118, title: "deft update idempotent" },
    ],
  });
}

describe("plan-sequence (#2402)", () => {
  it("next after PR1 resolves to PR2 only", () => {
    const seq = twoPrPlan();
    const first = resolveContinuation("move on to the next task/pr", seq);
    expect(first.action).toBe("advance");
    if (first.action === "advance") {
      expect(first.entry.id).toBe("pr-2120");
      expect(first.entry.issue).toBe(2120);
    }
    const afterFirst = advancePlanSequence(seq);
    expect(afterFirst.current_index).toBe(1);
    expect(afterFirst.exhausted).toBe(false);
    const second = resolveContinuation("what's next?", afterFirst);
    expect(second.action).toBe("advance");
    if (second.action === "advance") {
      expect(second.entry.id).toBe("pr-2118");
    }
  });

  it("next after final entry fails closed without authorizing PR3", () => {
    let seq = twoPrPlan();
    seq = advancePlanSequence(seq);
    seq = advancePlanSequence(seq);
    expect(seq.exhausted).toBe(true);
    const result = resolveContinuation("next pr", seq);
    expect(result.action).toBe("ask");
    if (result.action === "ask") {
      expect(result.message).toBe(EXHAUSTED_FAIL_CLOSED_MESSAGE);
    }
    const verify = verifyPlanTarget(seq, { targetKind: "pr", target: "pr-9999" });
    expect(verify.ok).toBe(false);
    if (!verify.ok) {
      expect(verify.code).toBe("exhausted");
    }
  });

  it("what's next without active sequence routes to queue", () => {
    const result = resolveContinuation("what's next?", null);
    expect(result).toEqual({ action: "queue", reason: "no-active-sequence" });
  });

  it("explicit queue ask stays queue-driven even mid-plan with a distinct reason", () => {
    const seq = twoPrPlan();
    const result = resolveContinuation("what's the queue?", seq);
    expect(result).toEqual({ action: "queue", reason: "explicit-queue-override" });
  });

  it("verify matches current entry only", () => {
    const seq = twoPrPlan();
    expect(verifyPlanTarget(seq, { targetKind: "pr", target: "pr-2120" }).ok).toBe(true);
    expect(verifyPlanTarget(seq, { targetKind: "pr", target: "2120" }).ok).toBe(true);
    const mismatch = verifyPlanTarget(seq, { targetKind: "pr", target: "pr-2118" });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.code).toBe("mismatch");
    }
  });

  it("persists under .deft/plan-sequence.json (not triage continuation fields)", () => {
    const root = seed();
    const seq = twoPrPlan();
    writePlanSequence(root, seq);
    const loaded = readPlanSequence(root);
    expect(loaded?.sequence_id).toBe("incident-2402");
    expect(loaded && "continuationNumbers" in loaded).toBe(false);
    expect(clearPlanSequence(root)).toBe(true);
    expect(readPlanSequence(root)).toBeNull();
  });

  it("continuation_past_final routes exhausted plan to queue", () => {
    let seq = twoPrPlan();
    seq = advancePlanSequence(seq);
    seq = advancePlanSequence(seq);
    seq = { ...seq, continuation_past_final: true, exhausted: true };
    expect(resolveContinuation("what's next?", seq).action).toBe("queue");
  });

  it("non-plan-first text with active sequence does not bind, with a distinct reason", () => {
    expect(resolveContinuation("hello world", twoPrPlan())).toEqual({
      action: "queue",
      reason: "not-plan-first-phrase",
    });
  });

  it("verify reports kind-mismatch and missing sequence", () => {
    const seq = twoPrPlan();
    const kind = verifyPlanTarget(seq, { targetKind: "issue", target: "pr-2120" });
    expect(kind.ok).toBe(false);
    if (!kind.ok) expect(kind.code).toBe("kind-mismatch");
    const missing = verifyPlanTarget(null, { targetKind: "pr", target: "x" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("missing");
  });

  it("title and issue number matchers work", () => {
    const seq = twoPrPlan();
    expect(
      verifyPlanTarget(seq, {
        targetKind: "pr",
        target: "Windows session-start cache-fresh",
      }).ok,
    ).toBe(true);
  });

  it("isExplicitQueueAsk and isPlanFirstPhrase helpers", () => {
    expect(isExplicitQueueAsk("build a cohort please")).toBe(true);
    expect(isPlanFirstPhrase("please proceed")).toBe(true);
    expect(isPlanFirstPhrase("unrelated")).toBe(false);
  });

  it("bare 'next' binds to the ordered plan per preamble § 2.55", () => {
    expect(isPlanFirstPhrase("okay, next")).toBe(true);
    const result = resolveContinuation("okay, next", twoPrPlan());
    expect(result.action).toBe("advance");
  });

  it("parsePlanSequence accepts exhausted and status variants", () => {
    const raw = {
      sequence_id: "p",
      sequence_kind: "review",
      current_index: 1,
      exhausted: true,
      batching_allowed: true,
      continuation_past_final: false,
      authorized_by: "op",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      entries: [
        { id: "a", kind: "review", status: "completed" },
        { id: "b", kind: "review", status: "skipped" },
      ],
    };
    const parsed = parsePlanSequence(raw);
    expect(parsed.exhausted).toBe(true);
    expect(parsed.batching_allowed).toBe(true);
    expect(parsed.entries[0]?.status).toBe("completed");
    expect(parsed.entries[1]?.status).toBe("skipped");
    expect(() => parsePlanSequence(null)).toThrow(/object/);
    expect(() => parsePlanSequence({ sequence_id: "x", sequence_kind: "delivery" })).toThrow(
      /entries/,
    );
  });

  it("advance on already-exhausted is idempotent", () => {
    let seq = twoPrPlan();
    seq = advancePlanSequence(seq);
    seq = advancePlanSequence(seq);
    const again = advancePlanSequence(seq);
    expect(again.exhausted).toBe(true);
  });
});
