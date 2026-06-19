import { describe, expect, it } from "vitest";
import { storyQualityIssues } from "./story-quality.js";

const BASE = {
  title: "Auth model",
  description:
    "Auth model persistence stores user identity and session state. The story covers focused model changes plus matching unit tests for save and load behavior.",
  implementationPlan:
    "- Update the src/auth model persistence code so valid payloads are saved through the model boundary.\n" +
    "- Add focused tests for successful persistence and a missing-record fixture in tests/auth/model.",
  userStory:
    "As an auth maintainer, I want persisted user records, so that login state survives requests.",
  acceptanceTexts: [
    "Given a valid user payload, when the auth model saves it, then the user record persists.",
    "Given an existing user, when the auth model loads it, then the saved identity returns.",
  ],
  acceptanceCountJustification: "",
  swarm: {
    file_scope: ["src/auth/model.ts", "tests/auth/model.test.ts"],
    verify_commands: ["npm test -- auth/model"],
    expected_outputs: ["tests pass"],
    depends_on: [],
    conflict_group: "auth",
    size: "M",
    file_scope_confidence: "high",
    model_tier: "medium",
    parallel_safe: true,
  },
};

describe("story-quality", () => {
  it("accepts a well-formed story", () => {
    expect(storyQualityIssues(BASE)).toEqual([]);
  });

  it("flags invalid user story format", () => {
    const issues = storyQualityIssues({ ...BASE, userStory: "Build it." });
    expect(issues.some((i) => i.includes("UserStory must match"))).toBe(true);
  });

  it("flags broad file scope and generic verify commands", () => {
    expect(
      storyQualityIssues({
        ...BASE,
        swarm: { ...BASE.swarm, file_scope: ["backend"] },
      }).some((i) => i.includes("broad file_scope")),
    ).toBe(true);
    expect(
      storyQualityIssues({
        ...BASE,
        swarm: { ...BASE.swarm, verify_commands: ["task check"] },
      }).some((i) => i.includes("generic verify command")),
    ).toBe(true);
  });
});
