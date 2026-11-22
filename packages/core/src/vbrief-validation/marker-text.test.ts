import { describe, expect, it } from "vitest";
import { storyQualityIssues as decomposeStoryQualityIssues } from "../scope/decompose.js";
import { isPlaceholderText, storyQualityIssues } from "./story-quality.js";

const BASE = {
  title: "Desk widgets",
  description:
    "The desk page shows section widgets for each area of the workspace. The story adds the widget component and the matching unit tests for render and empty states.",
  implementationPlan:
    "- Update the web/src/components/desk/section-placeholder-widget.tsx component so placeholder widgets render until content ships.\n" +
    "- Add focused tests for the widget render and empty states in web/src/components/desk/widget.test.tsx.",
  userStory:
    "As a desk user, I want section widgets, so that each area shows where content will appear.",
  acceptanceTexts: [
    "Given a section with no content, when the desk page renders, then the placeholder widgets show a grey card.",
    "Given the top bar, when the page renders, then the repo chip placeholder shows the repository name.",
  ],
  acceptanceCountJustification: "",
  swarm: {
    file_scope: [
      "web/src/app/crm/pipeline/[id]/page.tsx",
      "web/src/pages/[slug].tsx",
      "web/src/app/[...slug]/page.tsx",
    ],
    verify_commands: ["npm test -- desk"],
    expected_outputs: ["tests pass"],
    depends_on: [],
    conflict_group: "desk",
    size: "M",
    file_scope_confidence: "high",
    model_tier: "medium",
    parallel_safe: true,
  },
};

describe("readiness file_scope brackets (#6936)", () => {
  it("reports no broad file_scope issue for dynamic-route paths", () => {
    expect(storyQualityIssues(BASE).filter((i) => i.includes("broad file_scope"))).toEqual([]);
  });

  it("still reports * and ? entries", () => {
    for (const entry of ["src/*.ts", "src/?.ts"]) {
      const issues = storyQualityIssues({ ...BASE, swarm: { ...BASE.swarm, file_scope: [entry] } });
      expect(issues).toContain(`broad file_scope is not swarm-ready: ${entry}`);
    }
  });
});

describe("placeholder text (#6929)", () => {
  it("does not flag file names or domain terms", () => {
    expect(storyQualityIssues(BASE)).toEqual([]);
    expect(isPlaceholderText("web/src/components/desk/section-placeholder-widget.tsx")).toBe(false);
    expect(isPlaceholderText("Render placeholder widgets until content ships.")).toBe(false);
    expect(isPlaceholderText("The repo chip placeholder shows the repository name.")).toBe(false);
    expect(isPlaceholderText("Remove the todo_list.ts stub and tbd-flag.json file.")).toBe(false);
  });

  it("still flags marker lines, labels, template tokens and stub phrases", () => {
    for (const text of [
      "TBD",
      "TODO.",
      "TODO: write criteria",
      "TBD - decide later",
      "<placeholder>",
      "Return {tbd} for now.",
      "- TODO placeholder\n- TBD again here now",
      "1. Update the model.\n2. Placeholder",
      "The limit is TBD until product review.",
      "Acceptance criteria for IP-3 (copy from specification.vbrief.json).",
      "to refine from parent scope",
    ]) {
      expect(isPlaceholderText(text)).toBe(true);
    }
  });

  it("is the check readiness and scope:decompose both apply", () => {
    const stub = {
      ...BASE,
      acceptanceTexts: ["TODO: write criteria", BASE.acceptanceTexts[1] ?? ""],
    };
    expect(storyQualityIssues(stub)).toContain("placeholder acceptance criterion");
    const decomposeOpts = {
      title: BASE.title,
      description: BASE.description,
      implementationPlan: BASE.implementationPlan,
      userStory: BASE.userStory,
      acceptanceTexts: BASE.acceptanceTexts,
      acceptanceCountJustification: "",
      swarm: BASE.swarm,
    };
    const clean = decomposeStoryQualityIssues(decomposeOpts);
    expect(clean.some((i) => i.includes("placeholder"))).toBe(false);
    expect(clean.some((i) => i.includes("broad file_scope"))).toBe(false);
    const flagged = decomposeStoryQualityIssues({
      ...decomposeOpts,
      acceptanceTexts: ["TBD", BASE.acceptanceTexts[1] ?? ""],
    });
    expect(flagged).toContain("placeholder acceptance criterion");
  });

  it("flags a Markdown-bold TODO label in readiness and scope:decompose", () => {
    const bold =
      "**TODO:** define when the API returns an error and add assertions for each response field.";
    expect(isPlaceholderText(bold)).toBe(true);
    expect(isPlaceholderText("_TBD_: pick the limit")).toBe(true);
    expect(isPlaceholderText("`TODO`: fill in")).toBe(true);
    const texts = [bold, BASE.acceptanceTexts[1] ?? ""];
    expect(storyQualityIssues({ ...BASE, acceptanceTexts: texts })).toContain(
      "placeholder acceptance criterion",
    );
    expect(
      decomposeStoryQualityIssues({
        title: BASE.title,
        description: BASE.description,
        implementationPlan: BASE.implementationPlan,
        userStory: BASE.userStory,
        acceptanceTexts: texts,
        acceptanceCountJustification: "",
        swarm: BASE.swarm,
      }),
    ).toContain("placeholder acceptance criterion");
  });
});
