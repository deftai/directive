import { describe, expect, it } from "vitest";
import {
  acceptanceTextsFromItems,
  asStrList,
  deprecatedSubitemsIssues,
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

describe("story-quality branch matrix", () => {
  it("covers helper edge types", () => {
    expect(asStrList([" a ", ""])).toEqual(["a"]);
    expect(asStrList(42)).toEqual([]);
    expect(acceptanceTextsFromItems("x")).toEqual([]);
    expect(itemHasAcceptance({ items: [{ narrative: { Acceptance: "x" } }] })).toBe(true);
    expect(itemHasTraces({ subItems: [{ narrative: { Traces: "FR-1" } }] })).toBe(true);
    expect(itemsHaveAcceptance("nope")).toBe(false);
    expect(
      missingRequiredSwarmFields({
        file_scope: ["a"],
        verify_commands: ["b"],
        expected_outputs: ["c"],
        depends_on: [],
        conflict_group: "g",
        size: "S",
        file_scope_confidence: "high",
        model_tier: "low",
      }),
    ).toEqual([]);
    expect(deprecatedSubitemsIssues(null)).toEqual([]);
    expect(itemHasAcceptance({ subItems: [{ narrative: { Acceptance: "nested" } }] })).toBe(true);
  });

  it("flags description and implementation plan failures", () => {
    expect(storyQualityIssues({ ...BASE, description: "" })).toContain(
      "plan.narratives.Description is required",
    );
    expect(
      storyQualityIssues({ ...BASE, description: "Too short sentence." }).some((i) =>
        i.includes("two concrete sentences"),
      ),
    ).toBe(true);
    expect(storyQualityIssues({ ...BASE, implementationPlan: "" })).toContain(
      "plan.narratives.ImplementationPlan is required",
    );
    expect(
      storyQualityIssues({ ...BASE, implementationPlan: "- Only one short step." }).some((i) =>
        i.includes("two concrete steps"),
      ),
    ).toBe(true);
    expect(
      storyQualityIssues({
        ...BASE,
        implementationPlan: "- TODO placeholder\n- TBD again here now",
      }).some((i) => i.includes("placeholder text")),
    ).toBe(true);
    expect(
      storyQualityIssues({
        ...BASE,
        implementationPlan: "- Update the code so it works as expected.\n- Add tests so it works.",
      }).some((i) => i.includes("concrete code paths")),
    ).toBe(true);
  });

  it("flags acceptance criterion quality issues", () => {
    expect(
      storyQualityIssues({
        ...BASE,
        acceptanceTexts: ["to refine from parent scope", BASE.acceptanceTexts[1] ?? ""],
      }).some((i) => i.includes("placeholder acceptance")),
    ).toBe(true);
    expect(
      storyQualityIssues({
        ...BASE,
        acceptanceTexts: ["docs updated for behavior", BASE.acceptanceTexts[1] ?? ""],
      }).some((i) => i.includes("docs-only")),
    ).toBe(true);
    expect(
      storyQualityIssues({
        ...BASE,
        acceptanceTexts: [BASE.title, BASE.acceptanceTexts[1] ?? ""],
      }).some((i) => i.includes("duplicates title")),
    ).toBe(true);
    expect(
      storyQualityIssues({
        ...BASE,
        acceptanceTexts: ["It is updated.", BASE.acceptanceTexts[1] ?? ""],
      }).some((i) => i.includes("specific observable behavior")),
    ).toBe(true);
  });

  it("flags swarm readiness issues", () => {
    expect(
      storyQualityIssues({
        ...BASE,
        swarm: { ...BASE.swarm, file_scope: ["src/*.ts"] },
      }).some((i) => i.includes("broad file_scope")),
    ).toBe(true);
    expect(
      storyQualityIssues({
        ...BASE,
        swarm: { ...BASE.swarm, parallel_safe: false },
      }).some((i) => i.includes("parallel_safe=true")),
    ).toBe(true);
    expect(
      storyQualityIssues({
        ...BASE,
        swarm: { ...BASE.swarm, file_scope_confidence: "low" },
      }).some((i) => i.includes("file_scope_confidence above low")),
    ).toBe(true);
  });
});
