import { describe, expect, it } from "vitest";
import {
  detectTerminalEntryDrift,
  formatTerminalLifecycleDriftMessage,
  resolvePlanEntryLifecycleOrigin,
  TERMINAL_LIFECYCLE_CODE,
  type TerminalLifecycleOrigin,
} from "./terminal-drift.js";
import { createPlanSequence } from "./types.js";

function origin(
  partial: Partial<TerminalLifecycleOrigin> & Pick<TerminalLifecycleOrigin, "path">,
): TerminalLifecycleOrigin {
  return {
    folder: "completed",
    issueNumbers: [],
    prNumbers: [],
    storyIds: [],
    failed: false,
    hasTransitionWrite: false,
    ...partial,
  };
}

describe("resolvePlanEntryLifecycleOrigin (#4129)", () => {
  it("resolves issue kind from entry.issue and numeric id", () => {
    const fromField = resolvePlanEntryLifecycleOrigin({
      id: "feature-a",
      kind: "issue",
      issue: 287,
    });
    expect(fromField).toEqual({
      status: "resolved",
      keys: [{ kind: "issue", value: "287" }],
    });
    const fromId = resolvePlanEntryLifecycleOrigin({ id: "287", kind: "issue" });
    expect(fromId.status).toBe("resolved");
    if (fromId.status === "resolved") {
      expect(fromId.keys).toContainEqual({ kind: "issue", value: "287" });
    }
  });

  it("resolves pr kind from linked issue and pr-N id", () => {
    const resolved = resolvePlanEntryLifecycleOrigin({
      id: "pr-2120",
      kind: "pr",
      issue: 2120,
    });
    expect(resolved.status).toBe("resolved");
    if (resolved.status === "resolved") {
      expect(resolved.keys).toContainEqual({ kind: "issue", value: "2120" });
      expect(resolved.keys).toContainEqual({ kind: "pr", value: "2120" });
    }
  });

  it("resolves a wholly numeric story id as an issue origin", () => {
    expect(resolvePlanEntryLifecycleOrigin({ id: "287", kind: "story" })).toEqual({
      status: "resolved",
      keys: [
        { kind: "issue", value: "287" },
        { kind: "story-id", value: "287" },
      ],
    });
  });

  it("resolves story kind from issue, id, and title", () => {
    const resolved = resolvePlanEntryLifecycleOrigin({
      id: "287-done",
      kind: "story",
      issue: 287,
      title: "Ship 287",
    });
    expect(resolved.status).toBe("resolved");
    if (resolved.status === "resolved") {
      expect(resolved.keys).toContainEqual({ kind: "issue", value: "287" });
      expect(resolved.keys).toContainEqual({ kind: "story-id", value: "287-done" });
      expect(resolved.keys).toContainEqual({ kind: "title", value: "ship 287" });
    }
  });

  it("skips task/phase/checklist/review with no origin", () => {
    for (const kind of ["task", "phase", "checklist", "review"] as const) {
      expect(resolvePlanEntryLifecycleOrigin({ id: kind, kind })).toEqual({
        status: "skip",
        reason: "no-origin",
      });
    }
  });

  it("resolves optional issue origin on task kind", () => {
    expect(resolvePlanEntryLifecycleOrigin({ id: "t1", kind: "task", issue: 9 })).toEqual({
      status: "resolved",
      keys: [{ kind: "issue", value: "9" }],
    });
  });

  it("skips issue kind with no numeric origin", () => {
    expect(resolvePlanEntryLifecycleOrigin({ id: "unbound", kind: "issue" })).toEqual({
      status: "skip",
      reason: "no-origin",
    });
  });

  it("requires the whole issue id token to be a positive integer", () => {
    expect(resolvePlanEntryLifecycleOrigin({ id: "287-followup", kind: "issue" })).toEqual({
      status: "skip",
      reason: "no-origin",
    });
    expect(resolvePlanEntryLifecycleOrigin({ id: "#287", kind: "issue" })).toEqual({
      status: "resolved",
      keys: [{ kind: "issue", value: "287" }],
    });
  });

  it("requires pr- remainder to be all digits", () => {
    expect(resolvePlanEntryLifecycleOrigin({ id: "pr-99-extra", kind: "pr" })).toEqual({
      status: "skip",
      reason: "no-origin",
    });
    expect(resolvePlanEntryLifecycleOrigin({ id: "pr-99", kind: "pr" })).toEqual({
      status: "resolved",
      keys: [{ kind: "pr", value: "99" }],
    });
    expect(resolvePlanEntryLifecycleOrigin({ id: "99", kind: "pr" })).toEqual({
      status: "resolved",
      keys: [{ kind: "pr", value: "99" }],
    });
    expect(resolvePlanEntryLifecycleOrigin({ id: "0", kind: "issue" })).toEqual({
      status: "skip",
      reason: "no-origin",
    });
  });
});

describe("detectTerminalEntryDrift (#4129)", () => {
  const seq = createPlanSequence({
    sequence_id: "consumer-287",
    sequence_kind: "delivery",
    authorized_by: "test",
    entries: [
      { id: "287", kind: "issue", issue: 287 },
      { id: "288", kind: "issue", issue: 288 },
    ],
  });

  it("reports drift when current pending entry origin sits in completed/", () => {
    const result = detectTerminalEntryDrift(seq, [
      origin({ path: "xbrief/completed/2026-09-01-287.xbrief.json", issueNumbers: [287] }),
    ]);
    expect(result.drifted).toBe(true);
    if (result.drifted) {
      expect(result.code).toBe(TERMINAL_LIFECYCLE_CODE);
      expect(result.code).not.toBe("mismatch");
      expect(result.code).not.toBe("exhausted");
      expect(result.originPath).toBe("xbrief/completed/2026-09-01-287.xbrief.json");
      // #6205: a completed origin is a fact, not an operator stop.
      expect(result.message).toContain("Its completed brief finishes the entry");
      expect(result.message).not.toContain("Do not run task plan-sequence:advance until");
    }
  });

  it("does not drift when the origin is only in a non-terminal folder fact set (empty terminals)", () => {
    expect(detectTerminalEntryDrift(seq, []).drifted).toBe(false);
  });

  it("does not drift when sequence is exhausted", () => {
    const exhausted = { ...seq, exhausted: true, current_index: 1 };
    expect(
      detectTerminalEntryDrift(exhausted, [
        origin({ path: "xbrief/completed/287.xbrief.json", issueNumbers: [287] }),
      ]).drifted,
    ).toBe(false);
  });

  it("does not drift when the plan entry status is already completed", () => {
    const advanced = {
      ...seq,
      entries: seq.entries.map((e, i) => (i === 0 ? { ...e, status: "completed" as const } : e)),
    };
    expect(
      detectTerminalEntryDrift(advanced, [
        origin({ path: "xbrief/completed/287.xbrief.json", issueNumbers: [287] }),
      ]).drifted,
    ).toBe(false);
  });

  it("does not drift for no-origin skip kinds", () => {
    const tasks = createPlanSequence({
      sequence_id: "tasks",
      sequence_kind: "checklist",
      authorized_by: "t",
      entries: [{ id: "a", kind: "task" }],
    });
    expect(
      detectTerminalEntryDrift(tasks, [
        origin({ path: "xbrief/completed/a.xbrief.json", storyIds: ["a"] }),
      ]).drifted,
    ).toBe(false);
  });

  it("matches cancelled/ and failed stamp as terminal evidence", () => {
    const cancelled = detectTerminalEntryDrift(seq, [
      origin({
        path: "xbrief/cancelled/287.xbrief.json",
        folder: "cancelled",
        issueNumbers: [287],
      }),
    ]);
    expect(cancelled.drifted).toBe(true);
    const failed = detectTerminalEntryDrift(seq, [
      origin({
        path: "xbrief/completed/287-failed.xbrief.json",
        issueNumbers: [287],
        failed: true,
        hasTransitionWrite: true,
      }),
    ]);
    expect(failed.drifted).toBe(true);
  });

  it("matches story id against a completed basename without requiring GitHub closed", () => {
    const story = createPlanSequence({
      sequence_id: "story",
      sequence_kind: "swarm",
      authorized_by: "t",
      entries: [{ id: "287-done", kind: "story" }],
    });
    const result = detectTerminalEntryDrift(story, [
      origin({
        path: "xbrief/completed/2026-09-01-287-done.xbrief.json",
        storyIds: ["2026-09-01-287-done", "287-done"],
      }),
    ]);
    expect(result.drifted).toBe(true);
  });

  it("does not treat a later entry's terminal origin as current-entry drift", () => {
    expect(
      detectTerminalEntryDrift(seq, [
        origin({ path: "xbrief/completed/288.xbrief.json", issueNumbers: [288] }),
      ]).drifted,
    ).toBe(false);
  });

  it("returns not drifted for a null sequence", () => {
    expect(detectTerminalEntryDrift(null, []).drifted).toBe(false);
  });

  it("matches a story title against a completed brief title", () => {
    const story = createPlanSequence({
      sequence_id: "t",
      sequence_kind: "swarm",
      authorized_by: "t",
      entries: [{ id: "slug", kind: "story", title: "Ship 287" }],
    });
    expect(
      detectTerminalEntryDrift(story, [
        origin({ path: "xbrief/completed/ship.xbrief.json", title: "Ship 287" }),
      ]).drifted,
    ).toBe(true);
  });

  it("does not drift when plan entry status is skipped", () => {
    const skipped = {
      ...seq,
      entries: seq.entries.map((e, i) => (i === 0 ? { ...e, status: "skipped" as const } : e)),
    };
    expect(
      detectTerminalEntryDrift(skipped, [
        origin({ path: "xbrief/completed/287.xbrief.json", issueNumbers: [287] }),
      ]).drifted,
    ).toBe(false);
  });

  it("matches pr kind via prNumbers", () => {
    const pr = createPlanSequence({
      sequence_id: "pr",
      sequence_kind: "delivery",
      authorized_by: "t",
      entries: [{ id: "pr-99", kind: "pr" }],
    });
    expect(
      detectTerminalEntryDrift(pr, [
        origin({ path: "xbrief/completed/pr-99.xbrief.json", prNumbers: [99] }),
      ]).drifted,
    ).toBe(true);
  });

  it("does not treat 287-followup as issue 287", () => {
    const followup = createPlanSequence({
      sequence_id: "followup",
      sequence_kind: "delivery",
      authorized_by: "t",
      entries: [{ id: "287-followup", kind: "issue" }],
    });
    expect(
      detectTerminalEntryDrift(followup, [
        origin({ path: "xbrief/completed/287.xbrief.json", issueNumbers: [287] }),
      ]).drifted,
    ).toBe(false);
  });

  it("does not treat pr-99-extra as PR 99", () => {
    const extra = createPlanSequence({
      sequence_id: "pr-extra",
      sequence_kind: "delivery",
      authorized_by: "t",
      entries: [{ id: "pr-99-extra", kind: "pr" }],
    });
    expect(
      detectTerminalEntryDrift(extra, [
        origin({ path: "xbrief/completed/pr-99.xbrief.json", prNumbers: [99] }),
      ]).drifted,
    ).toBe(false);
  });
});

describe("formatTerminalLifecycleDriftMessage (#4129 / #6205)", () => {
  const entry = { id: "287", kind: "issue" as const, issue: 287 };
  const STOP = "Stop and ask the operator whether to advance, replace, or clear the sequence.";

  it("uses orphan-active stop/ask voice for a cancelled origin, not unattended advance", () => {
    const message = formatTerminalLifecycleDriftMessage(
      entry,
      "xbrief/cancelled/287.xbrief.json",
      "cancelled",
    );
    expect(message).toContain("issue:287 (#287)");
    expect(message).toContain("Do not run task plan-sequence:advance until the operator reviews");
    expect(message).toContain(STOP);
    expect(message).not.toMatch(/run task plan-sequence:advance\n/);
  });

  it("keeps the stop for a failed origin and drops it for a completed one (clause 9)", () => {
    const failed = formatTerminalLifecycleDriftMessage(
      entry,
      "xbrief/completed/287.xbrief.json",
      "completed",
      true,
    );
    expect(failed).toContain("terminal (failed)");
    expect(failed).toContain(STOP);
    const completed = formatTerminalLifecycleDriftMessage(
      entry,
      "xbrief/completed/287.xbrief.json",
      "completed",
    );
    expect(completed).not.toContain(STOP);
    expect(completed).not.toContain("Do not run task plan-sequence:advance");
    expect(completed).toContain("readers derive the next entry");
  });
});
