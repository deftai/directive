import { describe, expect, it } from "vitest";
import {
  asStrList,
  itemHasAcceptance,
  itemHasTraces,
  itemsHaveAcceptance,
  missingRequiredSwarmFields,
  storyQualityIssues,
} from "./story-quality.js";

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
    expected_outputs: ["ok"],
    depends_on: [],
    conflict_group: "auth",
    size: "M",
    file_scope_confidence: "high",
    model_tier: "medium",
    parallel_safe: true,
  },
};

/**
 * Residual story-quality branches for the #3287 coverage hairline.
 */
describe("story-quality residual branches (#3287)", () => {
  it("covers asStrList non-array/non-string and empty trim", () => {
    expect(asStrList(undefined)).toEqual([]);
    expect(asStrList("")).toEqual([]);
    expect(asStrList("   ")).toEqual([]);
    expect(asStrList({ a: 1 })).toEqual([]);
  });

  it("covers nested acceptance/traces false paths and empty arrays", () => {
    expect(itemHasAcceptance({ narrative: { Acceptance: "   " } })).toBe(false);
    expect(itemHasAcceptance({ narrative: null })).toBe(false);
    expect(itemHasAcceptance({ narrative: [] as unknown as object })).toBe(false);
    expect(itemHasAcceptance({ items: [null, "x", { narrative: {} }] })).toBe(false);
    expect(itemHasAcceptance({ items: "not-array" as unknown as object[] })).toBe(false);
    expect(itemHasTraces({ narrative: { Traces: "  " } })).toBe(false);
    expect(itemHasTraces({ narrative: "x" as unknown as object })).toBe(false);
    expect(itemHasTraces({ items: [{ narrative: { Traces: "" } }] })).toBe(false);
    expect(itemsHaveAcceptance([])).toBe(false);
    expect(itemsHaveAcceptance([{ narrative: {} }])).toBe(false);
  });

  it("covers broad file_scope root variants and generic verify command", () => {
    expect(
      storyQualityIssues({
        ...BASE,
        swarm: { ...BASE.swarm, file_scope: ["backend"] },
      }).some((i) => i.includes("broad file_scope")),
    ).toBe(true);
    expect(
      storyQualityIssues({
        ...BASE,
        swarm: { ...BASE.swarm, file_scope: ["frontend/"] },
      }).some((i) => i.includes("broad file_scope")),
    ).toBe(true);
    expect(
      storyQualityIssues({
        ...BASE,
        swarm: { ...BASE.swarm, file_scope: ["docs/*"] },
      }).some((i) => i.includes("broad file_scope")),
    ).toBe(true);
    expect(
      storyQualityIssues({
        ...BASE,
        swarm: { ...BASE.swarm, verify_commands: ["task check"] },
      }).some((i) => i.includes("generic verify command")),
    ).toBe(true);
  });

  it("covers missing swarm string fields and userStory nullish", () => {
    expect(
      missingRequiredSwarmFields({
        file_scope: ["a"],
        verify_commands: ["b"],
        expected_outputs: ["c"],
        // depends_on omitted
        conflict_group: "  ",
        size: "",
        file_scope_confidence: 1 as unknown as string,
        model_tier: null as unknown as string,
      }),
    ).toEqual(
      expect.arrayContaining([
        "plan.metadata.swarm.depends_on",
        "plan.metadata.swarm.conflict_group",
        "plan.metadata.swarm.size",
        "plan.metadata.swarm.file_scope_confidence",
        "plan.metadata.swarm.model_tier",
      ]),
    );
    expect(
      storyQualityIssues({
        ...BASE,
        userStory: null as unknown as string,
      }).some((i) => i.includes("UserStory must match")),
    ).toBe(true);
  });

  it("covers sentenceCount edge terminators and stepCount bullet vs prose", () => {
    // version-like periods are not sentence boundaries; pad word count above 20
    expect(
      storyQualityIssues({
        ...BASE,
        description:
          "Uses v1.2.3 API surface for auth model persistence across requests. " +
          "Second concrete sentence covers load fixtures and identity return paths carefully.",
      }),
    ).not.toContain("plan.narratives.Description must contain at least two concrete sentences");

    // prose-only plan without bullets falls back to sentence count (<2 steps)
    expect(
      storyQualityIssues({
        ...BASE,
        implementationPlan: "Only one prose sentence about the model path and test evidence.",
      }).some((i) => i.includes("two concrete steps")),
    ).toBe(true);
  });
});
