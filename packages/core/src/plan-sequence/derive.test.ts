import { describe, expect, it } from "vitest";
import {
  cursorMovedPastStored,
  derivePlanCursor,
  findInsertApproval,
  insertApprovedPlanEntry,
  materializeDerivedCursor,
} from "./derive.js";
import type { TerminalLifecycleOrigin } from "./terminal-drift.js";
import { createPlanSequence, type PlanSequence, verifyPlanTarget } from "./types.js";

function origin(
  partial: Partial<TerminalLifecycleOrigin> & { path: string },
): TerminalLifecycleOrigin {
  return {
    folder: "completed",
    issueNumbers: [],
    prNumbers: [],
    storyIds: [],
    failed: false,
    hasTransitionWrite: true,
    ...partial,
  };
}

function plan(entries: PlanSequence["entries"]): PlanSequence {
  return createPlanSequence({
    sequence_id: "seq-6205",
    sequence_kind: "delivery",
    authorized_by: "operator",
    entries,
    now: "2026-11-16T00:00:00.000Z",
  });
}

const threeIssues = plan([
  { id: "101", kind: "issue", issue: 101 },
  { id: "102", kind: "issue", issue: 102 },
  { id: "103", kind: "issue", issue: 103 },
]);

describe("derivePlanCursor (#6205)", () => {
  it("clause.2: a completed brief with a stale stored cursor derives the next unfinished entry", () => {
    const done = origin({ path: "xbrief/completed/101.xbrief.json", issueNumbers: [101] });
    const cursor = derivePlanCursor(threeIssues, [done]);
    expect(cursor.index).toBe(1);
    expect(cursor.entry?.id).toBe("102");
    expect(cursor.stop).toBeNull();
    expect(cursor.derivedFinished.map((d) => d.originPath)).toEqual([done.path]);
    expect(cursorMovedPastStored(threeIssues, cursor)).toBe(true);
  });

  it("clause.2: reads as exhausted when every pending entry is finished", () => {
    const all = [101, 102, 103].map((n) =>
      origin({ path: `xbrief/completed/${n}.xbrief.json`, issueNumbers: [n] }),
    );
    const cursor = derivePlanCursor(threeIssues, all);
    expect(cursor.exhausted).toBe(true);
    expect(cursor.entry).toBeNull();
    expect(cursor.index).toBe(3);
    const verified = verifyPlanTarget(threeIssues, {
      targetKind: "issue",
      target: "103",
      terminalOrigins: all,
    });
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.code).toBe("exhausted");
  });

  it("clause.1: matches by story id, and a title-only match does not finish the entry", () => {
    const stories = plan([
      { id: "ship-it", kind: "story", title: "Ship the thing" },
      { id: "after", kind: "story" },
    ]);
    const byTitle = origin({ path: "xbrief/completed/x.xbrief.json", title: "Ship the thing" });
    const titleOnly = derivePlanCursor(stories, [byTitle]);
    expect(titleOnly.index).toBe(0);
    expect(titleOnly.derivedFinished).toEqual([]);
    expect(titleOnly.stop).toBeNull();

    const byStoryId = origin({
      path: "xbrief/completed/2026-11-16-ship-it.xbrief.json",
      storyIds: ["2026-11-16-ship-it", "ship-it"],
    });
    expect(derivePlanCursor(stories, [byStoryId]).entry?.id).toBe("after");
  });

  it("clause.1: verifyPlanTarget admits the derived entry and refuses the finished one", () => {
    const done = [origin({ path: "xbrief/completed/101.xbrief.json", issueNumbers: [101] })];
    expect(
      verifyPlanTarget(threeIssues, { targetKind: "issue", target: "102", terminalOrigins: done }),
    ).toMatchObject({ ok: true, index: 1 });
    const stale = verifyPlanTarget(threeIssues, {
      targetKind: "issue",
      target: "101",
      terminalOrigins: done,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe("mismatch");
  });

  it("clause.3: a cancelled origin stops with terminal-lifecycle and the operator stop text", () => {
    const cancelled = origin({
      path: "xbrief/cancelled/101.xbrief.json",
      folder: "cancelled",
      issueNumbers: [101],
    });
    const cursor = derivePlanCursor(threeIssues, [cancelled]);
    expect(cursor.stop?.code).toBe("terminal-lifecycle");
    expect(cursor.stop?.index).toBe(0);
    expect(cursor.stop?.message).toContain("Stop and ask the operator");
    const verified = verifyPlanTarget(threeIssues, {
      targetKind: "issue",
      target: "101",
      terminalOrigins: [cancelled],
    });
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.code).toBe("terminal-lifecycle");
  });

  it("clause.3: a failed brief in completed/ stops instead of finishing", () => {
    const failed = origin({
      path: "xbrief/completed/101.xbrief.json",
      issueNumbers: [101],
      failed: true,
    });
    const cursor = derivePlanCursor(threeIssues, [failed]);
    expect(cursor.stop?.failed).toBe(true);
    expect(cursor.stop?.message).toContain("terminal (failed)");
    expect(cursor.derivedFinished).toEqual([]);
  });

  it("clause.3: a stop after a derived-finished entry still stops on the later entry", () => {
    const cursor = derivePlanCursor(threeIssues, [
      origin({ path: "xbrief/completed/101.xbrief.json", issueNumbers: [101] }),
      origin({
        path: "xbrief/cancelled/102.xbrief.json",
        folder: "cancelled",
        issueNumbers: [102],
      }),
    ]);
    expect(cursor.stop?.index).toBe(1);
    expect(cursor.derivedFinished).toHaveLength(1);
  });

  it("clause.4: an entry with no lifecycle origin stays current until advanced by hand", () => {
    const tasks = plan([
      { id: "write-docs", kind: "task" },
      { id: "review-it", kind: "review" },
    ]);
    const cursor = derivePlanCursor(tasks, [
      origin({ path: "xbrief/completed/write-docs.xbrief.json", storyIds: ["write-docs"] }),
    ]);
    expect(cursor.index).toBe(0);
    expect(cursor.entry?.id).toBe("write-docs");
    expect(cursorMovedPastStored(tasks, cursor)).toBe(false);
  });

  it("passes entries already marked completed or skipped", () => {
    const marked: PlanSequence = {
      ...threeIssues,
      entries: threeIssues.entries.map((e, i) =>
        i === 0 ? { ...e, status: "skipped" as const } : e,
      ),
    };
    expect(derivePlanCursor(marked, []).entry?.id).toBe("102");
  });

  it("a stored exhausted plan stays exhausted", () => {
    const exhausted = { ...threeIssues, exhausted: true, current_index: 2 };
    const cursor = derivePlanCursor(exhausted, []);
    expect(cursor.exhausted).toBe(true);
    expect(cursorMovedPastStored(exhausted, cursor)).toBe(false);
  });
});

describe("materializeDerivedCursor (#6205)", () => {
  it("marks derived entries completed and moves the stored cursor", () => {
    const cursor = derivePlanCursor(threeIssues, [
      origin({ path: "xbrief/completed/101.xbrief.json", issueNumbers: [101] }),
    ]);
    const next = materializeDerivedCursor(threeIssues, cursor, "2026-11-16T01:00:00.000Z");
    expect(next.current_index).toBe(1);
    expect(next.entries[0]?.status).toBe("completed");
    expect(next.updated_at).toBe("2026-11-16T01:00:00.000Z");
    expect(next.generation).toBe(threeIssues.generation);
  });

  it("an exhausted derivation keeps the last index, as advance does", () => {
    const all = [101, 102, 103].map((n) =>
      origin({ path: `xbrief/completed/${n}.xbrief.json`, issueNumbers: [n] }),
    );
    const next = materializeDerivedCursor(threeIssues, derivePlanCursor(threeIssues, all));
    expect(next.exhausted).toBe(true);
    expect(next.current_index).toBe(0);
    expect(next.entries.every((e) => e.status === "completed")).toBe(true);
  });
});

describe("insertApprovedPlanEntry (#6205)", () => {
  const approval = { entry_id: "fix-1", grant_id: "grant-x", approved_at: "2026-11-16T02:00:00Z" };
  const fix = { id: "fix-1", kind: "issue" as const, issue: 900 };

  it("clause.10: inserts at the effective cursor and records one approval row", () => {
    const cursor = derivePlanCursor(threeIssues, [
      origin({ path: "xbrief/completed/101.xbrief.json", issueNumbers: [101] }),
    ]);
    const result = insertApprovedPlanEntry({ sequence: threeIssues, cursor, entry: fix, approval });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.position).toBe(1);
    expect(result.sequence.entries.map((e) => e.id)).toEqual(["101", "fix-1", "102", "103"]);
    expect(result.sequence.entries[1]?.status).toBe("pending");
    expect(result.sequence.current_index).toBe(1);
    expect(result.sequence.insert_approvals).toEqual([approval]);
    expect(findInsertApproval(result.sequence, "fix-1")).toEqual(approval);
    expect(findInsertApproval(result.sequence, "102")).toBeNull();
    expect(Object.keys(result.sequence.entries[1] ?? {}).sort()).toEqual([
      "id",
      "issue",
      "kind",
      "status",
    ]);
  });

  it("clause.10: inserts at a named later index and refuses an earlier one", () => {
    const cursor = derivePlanCursor(threeIssues, []);
    const later = insertApprovedPlanEntry({
      sequence: threeIssues,
      cursor,
      entry: fix,
      position: 3,
      approval,
    });
    expect(later.ok && later.sequence.entries[3]?.id).toBe("fix-1");
    expect(later.ok && later.sequence.current_index).toBe(0);

    const derived = derivePlanCursor(threeIssues, [
      origin({ path: "xbrief/completed/101.xbrief.json", issueNumbers: [101] }),
    ]);
    const earlier = insertApprovedPlanEntry({
      sequence: threeIssues,
      cursor: derived,
      entry: fix,
      position: 0,
      approval,
    });
    expect(earlier).toMatchObject({ ok: false });
    if (!earlier.ok) expect(earlier.reason).toMatch(/before the effective cursor/);
  });

  it("refuses an index past the end, a duplicate id, and a stopped plan", () => {
    const cursor = derivePlanCursor(threeIssues, []);
    const past = insertApprovedPlanEntry({
      sequence: threeIssues,
      cursor,
      entry: fix,
      position: 9,
      approval,
    });
    expect(!past.ok && past.reason).toMatch(/past the end/);
    const dup = insertApprovedPlanEntry({
      sequence: threeIssues,
      cursor,
      entry: { id: "102", kind: "issue" },
      approval,
    });
    expect(!dup.ok && dup.reason).toMatch(/already in the plan/);
    const stopped = derivePlanCursor(threeIssues, [
      origin({
        path: "xbrief/cancelled/101.xbrief.json",
        folder: "cancelled",
        issueNumbers: [101],
      }),
    ]);
    const blocked = insertApprovedPlanEntry({
      sequence: threeIssues,
      cursor: stopped,
      entry: fix,
      approval,
    });
    expect(!blocked.ok && blocked.reason).toMatch(/Stop and ask/);
  });

  it("inserting into an exhausted plan reopens it at the new entry", () => {
    const exhausted = { ...threeIssues, exhausted: true, current_index: 2 };
    const result = insertApprovedPlanEntry({
      sequence: exhausted,
      cursor: derivePlanCursor(exhausted, []),
      entry: fix,
      approval: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sequence.exhausted).toBe(false);
    expect(result.sequence.current_index).toBe(3);
    expect(result.sequence.entries[3]?.id).toBe("fix-1");
    expect(result.sequence.insert_approvals).toBeUndefined();
  });
});
