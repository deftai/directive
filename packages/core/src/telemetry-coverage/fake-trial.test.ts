/**
 * Shared fake-trial harness: enroll kinds, do not rebuild per kind (#3362).
 */
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
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
});
