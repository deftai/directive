import { describe, expect, it } from "vitest";
import {
  EMPTY_PLANNING_NARRATIVES_CAUSE,
  evaluateTrackedPlanningNarrativesBag,
  TRACKED_PLANNING_NARRATIVE_KEYS,
} from "./index.js";

describe("project index surface (#5176)", () => {
  it("re-exports the Prefer-A evaluator bag", () => {
    expect(TRACKED_PLANNING_NARRATIVE_KEYS).toEqual(["overview", "techstack"]);
    const empty = evaluateTrackedPlanningNarrativesBag({
      narratives: { Overview: "", "tech stack": "" },
    });
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.cause).toBe(EMPTY_PLANNING_NARRATIVES_CAUSE);
  });
});
