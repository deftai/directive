import { describe, expect, it } from "vitest";
import { derivePlanBatch, derivePlanCursor } from "./derive.js";
import type { TerminalLifecycleOrigin } from "./terminal-drift.js";
import {
  advancePlanSequence,
  createPlanSequence,
  isClosedPlanSequenceShape,
  type PlanSequence,
  parsePlanSequence,
  planBatchError,
  verifyPlanStory,
  verifyPlanTarget,
} from "./types.js";

describe("plan-sequence types", () => {
  it("rejects empty entries", () => {
    expect(() =>
      createPlanSequence({
        sequence_id: "x",
        sequence_kind: "delivery",
        authorized_by: "t",
        entries: [],
      }),
    ).toThrow(/non-empty/);
  });

  it("parsePlanSequence requires sequence_id", () => {
    expect(() =>
      parsePlanSequence({ sequence_kind: "delivery", entries: [{ id: "a", kind: "pr" }] }),
    ).toThrow(/sequence_id/);
  });

  it("does not parse a non-string sequence_kind as a sequence (#4843)", () => {
    const base = {
      sequence_id: "undefined",
      entries: [{ id: "m0-gap", kind: "story" as const, issue: 285 }],
    };
    for (const sequence_kind of [undefined, null, 1, { k: "delivery" }, false]) {
      expect(() => parsePlanSequence({ ...base, sequence_kind })).toThrow(
        /plan-sequence: sequence_kind required/,
      );
    }
    expect(parsePlanSequence({ ...base, sequence_kind: "" }).sequence_kind).toBe("");
  });

  it("create/parse/advance round-trip generation and source_revision (#3907)", () => {
    const created = createPlanSequence({
      sequence_id: "g",
      sequence_kind: "delivery",
      authorized_by: "t",
      entries: [
        { id: "a", kind: "pr" },
        { id: "b", kind: "pr" },
      ],
      source_revision: "base",
    });
    expect(created.generation).toBe(0);
    expect(created.source_revision).toBe("base");
    const advanced = advancePlanSequence(created);
    expect(advanced.generation).toBe(1);
    expect(advanced.source_revision).toBe("base");
    const parsed = parsePlanSequence({
      ...advanced,
      generation: 4,
      source_revision: "deadbeef",
    });
    expect(parsed.generation).toBe(4);
    expect(parsed.source_revision).toBe("deadbeef");
    const { generation, ...withoutGeneration } = created;
    expect(generation).toBe(0);
    expect(parsePlanSequence(withoutGeneration).generation).toBe(0);
    expect(isClosedPlanSequenceShape(created)).toBe(true);
    expect(isClosedPlanSequenceShape(JSON.parse(JSON.stringify(parsed)) as unknown)).toBe(true);
    expect(isClosedPlanSequenceShape({ ...created, extra_authority: true })).toBe(false);
    expect(parsePlanSequence({ ...created, generation: -1 }).generation).toBe(0);
    expect(parsePlanSequence({ ...created, generation: 1.5 }).generation).toBe(0);
    expect(() =>
      parsePlanSequence({ sequence_id: "x", sequence_kind: "delivery", entries: [null] }),
    ).toThrow(/entries\[0\] must be an object/);
    expect(() =>
      parsePlanSequence({
        sequence_id: "x",
        sequence_kind: "delivery",
        entries: [{ kind: "pr" }],
      }),
    ).toThrow(/requires id and kind/);
  });

  it("clause.12: the closed shape admits insert_approvals rows and entry keys stay closed (#6205)", () => {
    const created = createPlanSequence({
      sequence_id: "ins",
      sequence_kind: "delivery",
      authorized_by: "t",
      entries: [{ id: "a", kind: "issue", issue: 1 }],
    });
    const row = { entry_id: "a", grant_id: "grant-1", approved_at: "2026-11-16T00:00:00Z" };
    const withRow = { ...created, insert_approvals: [row] };
    expect(isClosedPlanSequenceShape(withRow)).toBe(true);
    expect(parsePlanSequence(withRow).insert_approvals).toEqual([row]);
    expect(isClosedPlanSequenceShape({ ...created, insert_approvals: [] })).toBe(true);
    for (const bad of [
      "rows",
      [{ ...row, note: "x" }],
      [{ ...row, grant_id: "" }],
      [null],
      [{ entry_id: "a", grant_id: "g" }],
    ]) {
      expect(isClosedPlanSequenceShape({ ...created, insert_approvals: bad })).toBe(false);
    }
    expect(
      isClosedPlanSequenceShape({
        ...created,
        entries: [{ id: "a", kind: "issue", approval: "grant-1" }],
      }),
    ).toBe(false);
    // Parse keeps well-formed rows only and omits the key when absent.
    expect(
      parsePlanSequence({ ...created, insert_approvals: [row, { entry_id: "x" }] })
        .insert_approvals,
    ).toEqual([row]);
    expect(parsePlanSequence(created)).not.toHaveProperty("insert_approvals");
  });
});

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

function waves(batching_allowed: boolean): PlanSequence {
  return createPlanSequence({
    sequence_id: "waves-4433",
    sequence_kind: "cohort",
    authorized_by: "operator",
    batching_allowed,
    entries: [
      { id: "A1", kind: "issue", issue: 512, batch: "a" },
      { id: "A2", kind: "issue", issue: 515, batch: "a" },
      { id: "B1", kind: "issue", issue: 520, batch: "b" },
    ],
    now: "2026-11-16T00:00:00.000Z",
  });
}

const done = (issue: number): TerminalLifecycleOrigin =>
  origin({ path: `xbrief/completed/${issue}.xbrief.json`, issueNumbers: [issue] });

describe("batching_allowed batches (#4433)", () => {
  it("clause 30: every pending entry of the current batch passes; the later batch is refused", () => {
    const plan = waves(true);
    expect(verifyPlanTarget(plan, { targetKind: "issue", target: "A1" })).toMatchObject({
      ok: true,
      index: 0,
    });
    expect(verifyPlanTarget(plan, { targetKind: "issue", target: "515" })).toMatchObject({
      ok: true,
      index: 1,
    });
    const later = verifyPlanTarget(plan, { targetKind: "issue", target: "B1" });
    expect(later).toEqual({
      ok: false,
      code: "mismatch",
      message: 'Target issue:B1 is not in the current ordered-plan batch "a" (issue:A1, issue:A2).',
    });
    const kind = verifyPlanTarget(plan, { targetKind: "pr", target: "A2" });
    expect(kind.ok).toBe(false);
    if (!kind.ok) expect(kind.code).toBe("kind-mismatch");
  });

  it("clauses 5/31: batching_allowed false keeps the single derived current entry", () => {
    const plan = waves(false);
    expect(verifyPlanTarget(plan, { targetKind: "issue", target: "A2" })).toEqual({
      ok: false,
      code: "mismatch",
      message: "Target issue:A2 is not the current ordered-plan entry (issue:A1).",
    });
    // #4129 on that one entry when terminal origins are passed.
    const cancelled = origin({
      path: "xbrief/cancelled/512.xbrief.json",
      folder: "cancelled",
      issueNumbers: [512],
    });
    const stopped = verifyPlanTarget(plan, {
      targetKind: "issue",
      target: "A1",
      terminalOrigins: [cancelled],
    });
    expect(stopped.ok).toBe(false);
    if (!stopped.ok) expect(stopped.code).toBe("terminal-lifecycle");
  });

  it("clause 32: a peer finishing first is passed once the earlier entry completes", () => {
    const plan = waves(true);
    const early = [done(515)];
    expect(
      verifyPlanTarget(plan, { targetKind: "issue", target: "A1", terminalOrigins: early }).ok,
    ).toBe(true);
    expect(
      verifyPlanTarget(plan, { targetKind: "issue", target: "B1", terminalOrigins: early }).ok,
    ).toBe(false);
    expect(
      derivePlanBatch(plan, derivePlanCursor(plan, early), early).map((a) => a.entry.id),
    ).toEqual(["A1"]);
    const both = [done(515), done(512)];
    const cursor = derivePlanCursor(plan, both);
    expect(cursor.entry?.id).toBe("B1");
    expect(cursor.derivedFinished.map((d) => d.entry.id)).toEqual(["A1", "A2"]);
    expect(
      verifyPlanTarget(plan, { targetKind: "issue", target: "B1", terminalOrigins: both }).ok,
    ).toBe(true);
  });

  it("drops a cancelled or non-pending peer from the batch", () => {
    const plan = parsePlanSequence({
      ...waves(true),
      entries: [
        { id: "A1", kind: "issue", issue: 512, batch: "a" },
        { id: "A2", kind: "issue", issue: 515, batch: "a" },
        { id: "A3", kind: "issue", issue: 516, batch: "a", status: "skipped" },
        { id: "A4", kind: "issue", issue: 517, batch: "a" },
      ],
    });
    const cancelled = origin({
      path: "xbrief/cancelled/515.xbrief.json",
      folder: "cancelled",
      issueNumbers: [515],
    });
    const cursor = derivePlanCursor(plan, [cancelled]);
    expect(derivePlanBatch(plan, cursor, [cancelled]).map((a) => a.entry.id)).toEqual(["A1", "A4"]);
    expect(
      derivePlanBatch(
        plan,
        derivePlanCursor(plan, [done(512), done(515), done(516), done(517)]),
        [],
      ),
    ).toEqual([]);
  });

  it("clause 26: a persisted batching_allowed true plan with no labels reads as serial", () => {
    const legacy = parsePlanSequence({
      sequence_id: "legacy",
      sequence_kind: "cohort",
      batching_allowed: true,
      entries: [
        { id: "A", kind: "issue" },
        { id: "B", kind: "issue", batch: "" },
      ],
    });
    expect(legacy.batching_allowed).toBe(true);
    expect(legacy.entries[1]).not.toHaveProperty("batch");
    expect(verifyPlanTarget(legacy, { targetKind: "issue", target: "A" }).ok).toBe(true);
    expect(verifyPlanTarget(legacy, { targetKind: "issue", target: "B" }).ok).toBe(false);
  });

  it("set-time batch labels fail closed with one remediation", () => {
    const base = {
      sequence_id: "s",
      sequence_kind: "cohort" as const,
      authorized_by: "t",
    };
    expect(() =>
      createPlanSequence({
        ...base,
        batching_allowed: true,
        entries: [
          { id: "A", kind: "issue" },
          { id: "B", kind: "issue" },
        ],
      }),
    ).toThrow(/no entry has a "batch" label/);
    expect(() =>
      createPlanSequence({
        ...base,
        batching_allowed: true,
        entries: [
          { id: "A", kind: "issue", batch: "a" },
          { id: "B", kind: "issue", batch: "b" },
          { id: "C", kind: "issue", batch: "a" },
        ],
      }),
    ).toThrow(/batch "a" is split by other entries at entries\[2\]/);
    expect(planBatchError([{ batch: "a" }, {}, { batch: "a" }], true)).toMatch(
      /split by other entries at entries\[2\]/,
    );
    expect(planBatchError([{ batch: "  " }], false)).toBe(
      "plan-sequence: entries[0].batch must be a non-empty string.",
    );
    expect(planBatchError([{ batch: "a" }, {}, { batch: "a" }], false)).toBeNull();
    expect(planBatchError([{ batch: "a" }, { batch: "a" }], true)).toBeNull();
  });

  it("clause 28: batch labels live on the plan entries and pass the closed-shape check", () => {
    const plan = waves(true);
    const roundTrip = parsePlanSequence(JSON.parse(JSON.stringify(plan)));
    expect(roundTrip.entries.map((e) => e.batch)).toEqual(["a", "a", "b"]);
    expect(isClosedPlanSequenceShape(JSON.parse(JSON.stringify(plan)))).toBe(true);
    for (const batch of ["", 3, null]) {
      expect(
        isClosedPlanSequenceShape({ ...plan, entries: [{ id: "A", kind: "issue", batch }] }),
      ).toBe(false);
    }
  });
});

describe("verifyPlanStory launch match key (#4433)", () => {
  const storyPlan = createPlanSequence({
    sequence_id: "stories",
    sequence_kind: "swarm",
    authorized_by: "t",
    entries: [
      { id: "coh-a", kind: "story", title: "Story Title" },
      { id: "coh-b", kind: "story" },
    ],
  });

  it("clause 18: a story-kind entry matches on story_id, never title", () => {
    expect(verifyPlanStory(storyPlan, { storyId: "COH-A", issues: [] })).toMatchObject({
      ok: true,
      index: 0,
    });
    const byTitle = verifyPlanStory(storyPlan, { storyId: "Story Title", issues: [] });
    expect(byTitle).toEqual({
      ok: false,
      code: "mismatch",
      message:
        "Launch roster member story:Story Title is not the current ordered-plan entry (story:coh-a).",
    });
  });

  it("clauses 19/20: issue-kind entries match the resolved issue set exactly", () => {
    const serial = waves(false);
    expect(verifyPlanStory(serial, { storyId: "s1", issues: [512] }).ok).toBe(true);
    const byId = createPlanSequence({
      sequence_id: "ids",
      sequence_kind: "cohort",
      authorized_by: "t",
      entries: [{ id: "#512", kind: "issue" }],
    });
    expect(verifyPlanStory(byId, { storyId: "s1", issues: new Set([512]) }).ok).toBe(true);
    const multi = verifyPlanStory(serial, { storyId: "s2", issues: [515, 512] });
    expect(multi).toEqual({
      ok: false,
      code: "mismatch",
      message:
        "Launch roster member story:s2 (issues #512, #515) is not the current ordered-plan entry (issue:A1).",
    });
    expect(verifyPlanStory(waves(true), { storyId: "s2", issues: [515, 512] })).toMatchObject({
      ok: true,
      index: 0,
    });
    expect(verifyPlanStory(waves(true), { storyId: "s3", issues: [512, 520] }).ok).toBe(false);
    expect(verifyPlanStory(serial, { storyId: "s4", issues: [] }).ok).toBe(false);
  });

  it("clause 12: the launch check and verifyPlanTarget admit the same set", () => {
    const plan = waves(true);
    for (const [issue, id] of [
      [512, "A1"],
      [515, "A2"],
      [520, "B1"],
    ] as const) {
      expect(verifyPlanStory(plan, { storyId: "x", issues: [issue] }).ok).toBe(
        verifyPlanTarget(plan, { targetKind: "issue", target: id }).ok,
      );
    }
  });

  it("refuses missing, exhausted, stopped and non-story plans", () => {
    expect(verifyPlanStory(null, { storyId: "a", issues: [] })).toMatchObject({
      ok: false,
      code: "missing",
    });
    expect(
      verifyPlanStory({ ...storyPlan, exhausted: true }, { storyId: "coh-a", issues: [] }),
    ).toMatchObject({ ok: false, code: "exhausted" });
    const cancelled = origin({
      path: "xbrief/cancelled/coh-a.xbrief.json",
      folder: "cancelled",
      storyIds: ["coh-a"],
    });
    expect(
      verifyPlanStory(storyPlan, { storyId: "coh-a", issues: [], terminalOrigins: [cancelled] }),
    ).toMatchObject({ ok: false, code: "terminal-lifecycle" });
    const prPlan = createPlanSequence({
      sequence_id: "prs",
      sequence_kind: "review",
      authorized_by: "t",
      entries: [{ id: "p1", kind: "pr" }],
    });
    expect(verifyPlanStory(prPlan, { storyId: "p1", issues: [1] })).toEqual({
      ok: false,
      code: "kind-mismatch",
      message:
        "Current ordered-plan entry is kind=pr id=p1; launch roster member story:p1 (issues #1) matches only story or issue entries.",
    });
  });
});
