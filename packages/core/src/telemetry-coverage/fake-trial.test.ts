/**
 * Shared fake-trial harness: enroll kinds, do not rebuild per kind (#3362).
 */
import { readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { computeRitualGateShare } from "../run-summary/share.js";
import { DEFAULT_TRIAL_STEPS, missingEnrolledKinds, runFakeTrial } from "./fake-trial.js";
import { ENROLLED_FIELD_FIXTURE_KINDS, RUN_SUMMARY_EVENT_KINDS } from "./kinds.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("runFakeTrial (#3362)", () => {
  it("writes field-shaped JSONL and asserts enrolled kinds plus identity", () => {
    const result = runFakeTrial();
    roots.push(result.projectRoot);
    expect(result.lines.length).toBeGreaterThan(0);
    expect(result.seqMonotonic).toBe(true);
    expect(result.sessionIdStable).toBe(true);
    expect(missingEnrolledKinds(result)).toEqual([]);
    const present = new Set(result.presentKinds);
    for (const kind of ENROLLED_FIELD_FIXTURE_KINDS) {
      expect(present.has(kind), kind).toBe(true);
    }
    expect(result.stepOutcomes.length).toBe(DEFAULT_TRIAL_STEPS.length);
    for (const outcome of result.stepOutcomes) {
      expect(outcome.emittedKinds).toContain(outcome.declaredKind);
    }
    expect(result.lines.every((line) => line.schema_version === 1)).toBe(true);
    const seqs = result.lines.map((line) => line.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  });

  it("covers every schema kind from the single step table", () => {
    const stepKinds = DEFAULT_TRIAL_STEPS.map((step) => step.kind).sort();
    expect(stepKinds).toEqual([...RUN_SUMMARY_EVENT_KINDS].sort());
  });

  it("one session has exactly one sourced tool_turn_denominator and matching share (#3928)", () => {
    const result = runFakeTrial();
    roots.push(result.projectRoot);
    const denoms = result.lines.filter((line) => line.event === "tool_turn_denominator");
    expect(denoms).toHaveLength(1);
    expect(denoms[0]?.session_id).toBe(result.sessionId);
    expect(denoms[0]?.payload).toMatchObject({
      total_tool_turns: 8,
      denominator_source: "harness_actual",
    });
    const checks = result.lines.filter((line) => line.event === "check_invocation");
    const share = computeRitualGateShare(result.lines);
    const expectedShare = checks.length / 8;
    expect(share.evaluable).toBe(true);
    expect(share.ritualGateCount).toBe(checks.length);
    expect(share.totalToolTurns).toBe(8);
    expect(share.share).toBe(expectedShare);
  });

  it("reports a missing enrolled kind when the trial omits it", () => {
    const result = runFakeTrial({
      steps: DEFAULT_TRIAL_STEPS.filter((step) => step.kind !== "acceptance"),
    });
    roots.push(result.projectRoot);
    expect(missingEnrolledKinds(result, ["acceptance"])).toEqual(["acceptance"]);
  });

  it("treats a first-step no-write as empty emit instead of throwing ENOENT", () => {
    const result = runFakeTrial({
      steps: [
        {
          kind: "session_start",
          invoke: () => {
            /* silent / fail-open: destPath is never created */
          },
        },
      ],
    });
    roots.push(result.projectRoot);
    expect(result.stepOutcomes).toEqual([{ declaredKind: "session_start", emittedKinds: [] }]);
    expect(missingEnrolledKinds(result, ["session_start"])).toEqual(["session_start"]);
  });

  it("removes the auto-created temp root when a trial step throws", () => {
    const prefix = "deft-telemetry-trial-";
    const listed = (): string[] => readdirSync(tmpdir()).filter((name) => name.startsWith(prefix));
    const before = new Set(listed());
    expect(() =>
      runFakeTrial({
        steps: [
          {
            kind: "session_start",
            invoke: () => {
              throw new Error("fake-trial-boom");
            },
          },
        ],
      }),
    ).toThrow(/fake-trial-boom/);
    const leaked = listed().filter((name) => !before.has(name));
    expect(leaked).toEqual([]);
  });
});
