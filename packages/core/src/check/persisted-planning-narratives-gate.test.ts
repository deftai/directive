import { describe, expect, it } from "vitest";
import {
  EMPTY_PLANNING_NARRATIVES_CAUSE,
  evaluateTrackedPlanningNarrativesBag,
} from "../project/persisted-planning-narratives.js";
import { checkRejectsEmptyPlanningNarratives } from "./persisted-planning-narratives-gate.js";

describe("check persisted-planning-narratives gate (#5176)", () => {
  it("refuses empty Overview+tech stack", () => {
    const result = evaluateTrackedPlanningNarrativesBag({
      narratives: { Overview: "", "tech stack": "" },
    });
    expect(checkRejectsEmptyPlanningNarratives(result)).toBe(true);
    if (!checkRejectsEmptyPlanningNarratives(result)) return;
    expect(result.cause).toBe(EMPTY_PLANNING_NARRATIVES_CAUSE);
  });

  it("passes when one tracked field is non-empty", () => {
    const result = evaluateTrackedPlanningNarrativesBag({
      narratives: { Overview: "demo", "tech stack": "" },
    });
    expect(checkRejectsEmptyPlanningNarratives(result)).toBe(false);
  });
});
