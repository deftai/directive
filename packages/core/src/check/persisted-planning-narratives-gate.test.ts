import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EMPTY_PLANNING_NARRATIVES_CAUSE,
  evaluatePersistedPlanningNarratives,
  evaluateTrackedPlanningNarrativesBag,
} from "../project/persisted-planning-narratives.js";
import {
  checkRejectsEmptyPlanningNarratives,
  evaluateCheckPersistedPlanningNarratives,
} from "./persisted-planning-narratives-gate.js";
import { recordProductMutationCompletion } from "./product-mutation-completion.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pd-check-gate-"));
  temps.push(root);
  mkdirSync(join(root, "xbrief"), { recursive: true });
  return root;
}

function writeEmptyPd(root: string): void {
  writeFileSync(
    join(root, "xbrief", "PROJECT-DEFINITION.xbrief.json"),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8" },
      plan: { title: "demo", narratives: { Overview: "", "tech stack": "  " } },
    }),
    "utf8",
  );
}

describe("check persisted-planning-narratives gate (#5176)", () => {
  it("does not refuse empty Overview+tech stack without product-mutation evidence", () => {
    const result = evaluateTrackedPlanningNarrativesBag({
      narratives: { Overview: "", "tech stack": "" },
    });
    expect(checkRejectsEmptyPlanningNarratives(result, { kind: "absent" })).toBe(false);
  });

  it("refuses empty Overview+tech stack when product-mutation completion is present", () => {
    const result = evaluateTrackedPlanningNarrativesBag({
      narratives: { Overview: "", "tech stack": "" },
    });
    expect(
      checkRejectsEmptyPlanningNarratives(result, {
        kind: "present",
        recordedAt: "2026-09-30T12:00:00.000Z",
      }),
    ).toBe(true);
    if (
      !checkRejectsEmptyPlanningNarratives(result, {
        kind: "present",
        recordedAt: "2026-09-30T12:00:00.000Z",
      })
    ) {
      return;
    }
    expect(result.cause).toBe(EMPTY_PLANNING_NARRATIVES_CAUSE);
  });

  it("refuses empty when product-mutation marker is unreadable (fail closed)", () => {
    const result = evaluateTrackedPlanningNarrativesBag({
      narratives: { Overview: "", "tech stack": "" },
    });
    expect(
      checkRejectsEmptyPlanningNarratives(result, {
        kind: "unreadable",
        detail: "marker JSON is not an object",
      }),
    ).toBe(true);
  });

  it("passes when one tracked field is non-empty even with product-mutation", () => {
    const result = evaluateTrackedPlanningNarrativesBag({
      narratives: { Overview: "demo", "tech stack": "" },
    });
    expect(
      checkRejectsEmptyPlanningNarratives(result, {
        kind: "present",
        recordedAt: "2026-09-30T12:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("missing PROJECT-DEFINITION is not a check narrative-bar refuse", () => {
    const root = tempRoot();
    const evaluated = evaluateCheckPersistedPlanningNarratives(root, {
      productMutationLookup: {
        kind: "present",
        recordedAt: "2026-09-30T12:00:00.000Z",
      },
    });
    expect(evaluated.narratives.ok).toBe(false);
    if (evaluated.narratives.ok) return;
    expect(evaluated.narratives.code).toBe(2);
    expect(
      checkRejectsEmptyPlanningNarratives(evaluated.narratives, evaluated.productMutation),
    ).toBe(false);
  });

  it("greenfield empty seed passes check; product-mutation+empty refuses", () => {
    const scaffold = tempRoot();
    writeEmptyPd(scaffold);
    const scaffoldEval = evaluateCheckPersistedPlanningNarratives(scaffold);
    expect(scaffoldEval.productMutation.kind).toBe("absent");
    expect(
      checkRejectsEmptyPlanningNarratives(scaffoldEval.narratives, scaffoldEval.productMutation),
    ).toBe(false);
    // Standalone verify still sees empty (setup Phase 2 bar).
    const verifyEmpty = evaluatePersistedPlanningNarratives(scaffold);
    expect(verifyEmpty.ok).toBe(false);

    const mutated = tempRoot();
    writeEmptyPd(mutated);
    recordProductMutationCompletion(mutated, new Date("2026-09-30T12:00:00Z"));
    const mutatedEval = evaluateCheckPersistedPlanningNarratives(mutated);
    expect(mutatedEval.productMutation.kind).toBe("present");
    expect(
      checkRejectsEmptyPlanningNarratives(mutatedEval.narratives, mutatedEval.productMutation),
    ).toBe(true);
  });
});
