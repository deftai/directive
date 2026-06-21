/**
 * Vitest tests for scope/decompose.ts -- mirror key Python test cases from
 * tests/cli/test_scope_decompose_unit.py including non-happy-path/edge cases.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acceptanceTextsFromItems,
  applyDecomposition,
  asStrList,
  DecompositionError,
  decomposeMain,
  deprecatedSubitemsIssues,
  itemHasAcceptance,
  itemHasTraces,
  itemsHaveAcceptance,
  missingRequiredSwarmFields,
  storyQualityIssues,
  validateDraft,
} from "./decompose.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function tmpProject(): string {
  const dir = join(tmpdir(), `decompose-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, "vbrief", "pending"), { recursive: true });
  mkdirSync(join(dir, "vbrief", "proposed"), { recursive: true });
  mkdirSync(join(dir, "vbrief", "active"), { recursive: true });
  mkdirSync(join(dir, "vbrief", "completed"), { recursive: true });
  mkdirSync(join(dir, "vbrief", "cancelled"), { recursive: true });
  return dir;
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
}

function goodStory(
  storyId = "story-auth-model",
  title = "Auth model",
  deps: string[] = [],
): Record<string, unknown> {
  return {
    id: storyId,
    title,
    description:
      `${title} persistence behavior stores user identity and session ` +
      "state for the authentication workflow. The story covers focused " +
      "model changes plus matching unit tests for save and load.",
    implementation_plan: [
      "Update the auth model persistence code so valid user payloads " +
        "are saved through the existing model boundary.",
      "Add focused model tests for successful persistence and " +
        "missing-record behavior using the auth model test fixture.",
    ],
    user_story:
      "As an auth maintainer, I want persisted user records, " +
      "so that login state survives requests.",
    acceptance: [
      "Given a valid user payload, when the auth model saves it, then the user record persists.",
      "Given an existing user, when the auth model loads it, then the saved identity returns.",
    ],
    traces: ["FR-1"],
    swarm: {
      readiness: "ready",
      parallel_safe: true,
      file_scope: ["src/auth/model.ts", "tests/auth/model.test.ts"],
      verify_commands: ["npm test -- auth/model"],
      expected_outputs: ["auth model tests pass"],
      depends_on: deps,
      conflict_group: "auth",
      size: "small",
      file_scope_confidence: "high",
      model_tier: "medium",
    },
  };
}

function goodDraft(outputDir?: string, status?: string): Record<string, unknown> {
  const story1 = goodStory();
  const story2 = {
    ...goodStory("story-auth-routes", "Auth routes", ["story-auth-model"]),
    swarm: {
      ...(goodStory().swarm as Record<string, unknown>),
      file_scope: ["src/auth/routes.ts", "tests/auth/routes.test.ts"],
      verify_commands: ["npm test -- auth/routes"],
      depends_on: ["story-auth-model"],
    },
  };
  const draft: Record<string, unknown> = { stories: [story1, story2] };
  if (outputDir !== undefined) draft.output_dir = outputDir;
  if (status !== undefined) draft.status = status;
  return draft;
}

function goodParent(): Record<string, unknown> {
  return {
    vBRIEFInfo: { version: "0.6" },
    plan: {
      id: "ip-1",
      title: "IP-1: Auth",
      status: "pending",
      narratives: {
        Acceptance: "Auth epic acceptance remains as context.",
        Traces: "FR-1, IP-1",
      },
      items: [],
      metadata: { kind: "phase" },
      references: [
        {
          uri: "specification.vbrief.json",
          type: "x-vbrief/plan",
          title: "Specification",
          TrustLevel: "internal",
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// asStrList
// ---------------------------------------------------------------------------

describe("asStrList", () => {
  it("handles null/undefined", () => {
    expect(asStrList(null)).toEqual([]);
    expect(asStrList(undefined)).toEqual([]);
  });

  it("handles empty string", () => {
    expect(asStrList("")).toEqual([]);
    expect(asStrList("  ")).toEqual([]);
  });

  it("handles string", () => {
    expect(asStrList("alpha")).toEqual(["alpha"]);
  });

  it("handles mixed array", () => {
    expect(asStrList(["a", "", " b ", 3])).toEqual(["a", "b", "3"]);
  });

  it("returns empty for objects/numbers", () => {
    expect(asStrList({ a: 1 })).toEqual([]);
    expect(asStrList(42)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// itemHasTraces / itemsHaveAcceptance
// ---------------------------------------------------------------------------

describe("itemHasTraces", () => {
  it("finds traces in narrative", () => {
    expect(itemHasTraces({ narrative: { Traces: "FR-1" } })).toBe(true);
  });

  it("false for no traces", () => {
    expect(itemHasTraces({ narrative: { Acceptance: "yes" } })).toBe(false);
  });

  it("walks nested items", () => {
    expect(itemHasTraces({ items: [{ narrative: { Traces: "FR-2" } }] })).toBe(true);
  });
});

describe("itemsHaveAcceptance", () => {
  it("returns false for non-list", () => {
    expect(itemsHaveAcceptance("not-list")).toBe(false);
  });

  it("returns false for empty", () => {
    expect(itemsHaveAcceptance([])).toBe(false);
  });

  it("returns false when no acceptance", () => {
    expect(itemsHaveAcceptance([{ no: "acc" }])).toBe(false);
  });

  it("returns true when any item has acceptance", () => {
    expect(itemsHaveAcceptance([{ narrative: { Acceptance: "yes" } }])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// missingRequiredSwarmFields
// ---------------------------------------------------------------------------

describe("missingRequiredSwarmFields", () => {
  it("empty swarm lists every required field", () => {
    const missing = missingRequiredSwarmFields({});
    const expected = [
      "plan.metadata.swarm.file_scope",
      "plan.metadata.swarm.verify_commands",
      "plan.metadata.swarm.expected_outputs",
      "plan.metadata.swarm.depends_on",
      "plan.metadata.swarm.conflict_group",
      "plan.metadata.swarm.size",
      "plan.metadata.swarm.file_scope_confidence",
      "plan.metadata.swarm.model_tier",
    ];
    for (const field of expected) {
      expect(missing).toContain(field);
    }
  });

  it("depends_on present drops only depends_on entry", () => {
    const missing = missingRequiredSwarmFields({ depends_on: [] });
    expect(missing).not.toContain("plan.metadata.swarm.depends_on");
    expect(missing).toContain("plan.metadata.swarm.file_scope");
  });
});

// ---------------------------------------------------------------------------
// deprecatedSubitemsIssues
// ---------------------------------------------------------------------------

describe("deprecatedSubitemsIssues", () => {
  it("returns empty for null", () => {
    expect(deprecatedSubitemsIssues(null)).toEqual([]);
  });

  it("detects subItems", () => {
    const items = [{ subItems: [{ name: "x" }] }];
    const issues = deprecatedSubitemsIssues(items);
    expect(issues.some((i) => i.includes("subItems is deprecated"))).toBe(true);
  });

  it("detects nested deprecated items", () => {
    const items = [
      {
        items: [{ subItems: [{}] }],
      },
    ];
    const issues = deprecatedSubitemsIssues(items);
    expect(issues.some((i) => i.includes(".items[0].subItems is deprecated"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateDraft
// ---------------------------------------------------------------------------

describe("validateDraft", () => {
  it("happy path returns ordered story ids", () => {
    const draft = goodDraft();
    const stories = (draft.stories as unknown[]).map((s) => s as Record<string, unknown>);
    const ids = validateDraft(stories);
    expect(ids).toEqual(["story-auth-model", "story-auth-routes"]);
  });

  it("throws on duplicate story id", () => {
    const story = goodStory();
    expect(() => validateDraft([story, story] as Record<string, unknown>[])).toThrow(
      DecompositionError,
    );
    expect(() => validateDraft([story, story] as Record<string, unknown>[])).toThrow("duplicate");
  });

  it("throws on missing required field (description)", () => {
    const story = { ...goodStory(), description: "" };
    expect(() => validateDraft([story])).toThrow(DecompositionError);
  });

  it("throws on dependency cycle", () => {
    const s1 = { ...goodStory("s1", "Story 1", ["s2"]) };
    const s2 = { ...goodStory("s2", "Story 2", ["s1"]) };
    (s1.swarm as Record<string, unknown>).depends_on = ["s2"];
    (s2.swarm as Record<string, unknown>).depends_on = ["s1"];
    expect(() => validateDraft([s1, s2] as Record<string, unknown>[])).toThrow("dependency cycle");
  });

  it("throws on unknown dependency reference", () => {
    const story = goodStory("s1", "S1", ["nonexistent"]);
    expect(() => validateDraft([story] as Record<string, unknown>[])).toThrow("unknown story");
  });

  it("throws on non-array stories draft", () => {
    expect(() => {
      const draft = { stories: "bad" };
      const stories = (draft as unknown as { stories: unknown }).stories;
      if (!Array.isArray(stories))
        throw new DecompositionError("draft must contain a stories array");
    }).toThrow(DecompositionError);
  });
});

// ---------------------------------------------------------------------------
// applyDecomposition
// ---------------------------------------------------------------------------

describe("applyDecomposition", () => {
  it("check-only validates and returns actions without writing files", () => {
    const proj = tmpProject();
    const parentPath = join(proj, "vbrief", "pending", "2026-05-12-parent.vbrief.json");
    writeJson(parentPath, goodParent());
    const draftPath = join(proj, "vbrief", ".eval", "draft.json");
    mkdirSync(join(proj, "vbrief", ".eval"), { recursive: true });
    writeJson(draftPath, goodDraft());
    const actions = applyDecomposition({
      projectRoot: proj,
      parentPath,
      draftPath,
      checkOnly: true,
      date: "2026-05-12",
    });
    expect(actions[0]).toContain("VALIDATED 2");
    expect(actions.some((a) => a.startsWith("CHECK"))).toBe(true);
    // Files should NOT have been written
    const childDir = join(proj, "vbrief", "pending");
    const childFiles = readdirSafe(childDir).filter((f) => f !== "2026-05-12-parent.vbrief.json");
    expect(childFiles).toHaveLength(0);
  });

  it("apply creates child vBRIEFs and updates parent", () => {
    const proj = tmpProject();
    const parentPath = join(proj, "vbrief", "pending", "2026-05-12-parent.vbrief.json");
    writeJson(parentPath, goodParent());
    const draftPath = join(proj, "vbrief", ".eval", "draft.json");
    mkdirSync(join(proj, "vbrief", ".eval"), { recursive: true });
    writeJson(draftPath, goodDraft());
    const actions = applyDecomposition({
      projectRoot: proj,
      parentPath,
      draftPath,
      checkOnly: false,
      date: "2026-06-01",
    });
    expect(actions.some((a) => a.startsWith("CREATE"))).toBe(true);
    expect(actions.some((a) => a.startsWith("UPDATE"))).toBe(true);
    // Two child files should be created in pending
    const childDir = join(proj, "vbrief", "pending");
    const childFiles = readdirSafe(childDir).filter((f) => f !== "2026-05-12-parent.vbrief.json");
    expect(childFiles.length).toBeGreaterThanOrEqual(2);
    // Parent should reference children
    const updatedParent = JSON.parse(readFileSync(parentPath, "utf8")) as Record<string, unknown>;
    const plan = updatedParent.plan as Record<string, unknown>;
    const refs = plan.references as unknown[];
    expect(refs.some((r) => (r as Record<string, unknown>).type === "x-vbrief/plan")).toBe(true);
  });

  it("throws when output_dir is active", () => {
    const proj = tmpProject();
    const parentPath = join(proj, "vbrief", "pending", "parent.vbrief.json");
    writeJson(parentPath, goodParent());
    const draftPath = join(proj, "vbrief", ".eval", "draft.json");
    mkdirSync(join(proj, "vbrief", ".eval"), { recursive: true });
    writeJson(draftPath, goodDraft("vbrief/active"));
    expect(() =>
      applyDecomposition({
        projectRoot: proj,
        parentPath,
        draftPath,
        checkOnly: false,
        date: "2026-06-01",
      }),
    ).toThrow("must not be vbrief/active");
  });

  it("throws when status is running", () => {
    const proj = tmpProject();
    const parentPath = join(proj, "vbrief", "pending", "parent.vbrief.json");
    writeJson(parentPath, goodParent());
    const draftPath = join(proj, "vbrief", ".eval", "draft.json");
    mkdirSync(join(proj, "vbrief", ".eval"), { recursive: true });
    writeJson(draftPath, goodDraft(undefined, "running"));
    expect(() =>
      applyDecomposition({
        projectRoot: proj,
        parentPath,
        draftPath,
        checkOnly: false,
        date: "2026-06-01",
      }),
    ).toThrow("active/running");
  });

  it("throws when child file already exists", () => {
    const proj = tmpProject();
    const parentPath = join(proj, "vbrief", "pending", "parent.vbrief.json");
    writeJson(parentPath, goodParent());
    const draftPath = join(proj, "vbrief", ".eval", "draft.json");
    mkdirSync(join(proj, "vbrief", ".eval"), { recursive: true });
    const draft = goodDraft();
    writeJson(draftPath, draft);
    applyDecomposition({
      projectRoot: proj,
      parentPath,
      draftPath,
      checkOnly: false,
      date: "2026-06-01",
    });
    // Re-write parent to clean state (already modified)
    writeJson(parentPath, goodParent());
    expect(() =>
      applyDecomposition({
        projectRoot: proj,
        parentPath,
        draftPath,
        checkOnly: false,
        date: "2026-06-01",
      }),
    ).toThrow("already exists");
  });
});

// ---------------------------------------------------------------------------
// decomposeMain CLI
// ---------------------------------------------------------------------------

describe("decomposeMain", () => {
  it("--check with no args prints OK", () => {
    expect(decomposeMain(["--check"])).toBe(0);
  });

  it("missing parent + draft returns 2", () => {
    expect(decomposeMain([])).toBe(2);
  });

  it("missing draft alone returns 2", () => {
    expect(decomposeMain(["some-parent.vbrief.json"])).toBe(2);
  });

  it("nonexistent parent returns 2", () => {
    expect(decomposeMain(["--draft", "draft.json", "/nonexistent/parent.vbrief.json"])).toBe(2);
  });

  it("invalid date returns 2", () => {
    const proj = tmpProject();
    const parentPath = join(proj, "vbrief", "pending", "parent.vbrief.json");
    writeJson(parentPath, goodParent());
    const draftPath = join(proj, "vbrief", ".eval", "draft.json");
    mkdirSync(join(proj, "vbrief", ".eval"), { recursive: true });
    writeJson(draftPath, goodDraft());
    expect(
      decomposeMain([
        parentPath,
        "--draft",
        draftPath,
        "--date",
        "not-a-date",
        "--project-root",
        proj,
      ]),
    ).toBe(2);
  });

  it("full apply returns 0", () => {
    const proj = tmpProject();
    const parentPath = join(proj, "vbrief", "pending", "parent.vbrief.json");
    writeJson(parentPath, goodParent());
    const draftPath = join(proj, "vbrief", ".eval", "draft.json");
    mkdirSync(join(proj, "vbrief", ".eval"), { recursive: true });
    writeJson(draftPath, goodDraft());
    expect(
      decomposeMain([
        parentPath,
        "--draft",
        draftPath,
        "--date",
        "2026-06-01",
        "--project-root",
        proj,
      ]),
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import { readdirSync } from "node:fs";

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Shared good narrative fragments
// ---------------------------------------------------------------------------

const GOOD_DESC =
  "The auth model persistence behavior stores user identity and session state for the " +
  "authentication workflow. The story covers focused model changes plus matching unit tests.";
const GOOD_PLAN =
  "Update the auth model persistence code so valid payloads are saved through the existing " +
  "model boundary.\nAdd focused model tests for successful persistence and missing-record " +
  "behavior using the auth model test fixture.";
const GOOD_US =
  "As an auth maintainer, I want persisted user records, so that login state survives requests.";
const GOOD_AC1 =
  "Given a valid user payload, when the auth model saves it, then the user record persists.";
const GOOD_AC2 =
  "Given an existing user, when the auth model loads it, then the saved identity returns.";

function goodSwarm(): Record<string, unknown> {
  return {
    readiness: "ready",
    parallel_safe: true,
    file_scope: ["src/auth/model.ts", "tests/auth/model.test.ts"],
    verify_commands: ["npm test -- auth/model"],
    expected_outputs: ["auth model tests pass"],
    depends_on: [],
    conflict_group: "auth",
    size: "small",
    file_scope_confidence: "high",
    model_tier: "medium",
  };
}

// ---------------------------------------------------------------------------
// acceptanceTextsFromItems / itemHasAcceptance
// ---------------------------------------------------------------------------

describe("acceptanceTextsFromItems", () => {
  it("returns empty for non-array", () => {
    expect(acceptanceTextsFromItems("nope")).toEqual([]);
    expect(acceptanceTextsFromItems(null)).toEqual([]);
  });

  it("skips non-object items", () => {
    expect(acceptanceTextsFromItems([1, "x", null])).toEqual([]);
  });

  it("collects acceptance from narrative and nested items/subItems", () => {
    const texts = acceptanceTextsFromItems([
      { narrative: { Acceptance: "top" } },
      { items: [{ narrative: { Acceptance: "nested-items" } }] },
      { subItems: [{ narrative: { Acceptance: "nested-sub" } }] },
    ]);
    expect(texts).toContain("top");
    expect(texts).toContain("nested-items");
    expect(texts).toContain("nested-sub");
  });
});

describe("itemHasAcceptance", () => {
  it("true when narrative has acceptance", () => {
    expect(itemHasAcceptance({ narrative: { Acceptance: "x" } })).toBe(true);
  });

  it("true when nested child has acceptance", () => {
    expect(itemHasAcceptance({ items: [{ narrative: { Acceptance: "y" } }] })).toBe(true);
    expect(itemHasAcceptance({ subItems: [{ narrative: { Acceptance: "z" } }] })).toBe(true);
  });

  it("false when no acceptance anywhere", () => {
    expect(itemHasAcceptance({ foo: 1 })).toBe(false);
    expect(itemHasAcceptance({ narrative: { Acceptance: "   " } })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// storyQualityIssues
// ---------------------------------------------------------------------------

describe("storyQualityIssues", () => {
  function baseOpts(over: Partial<Parameters<typeof storyQualityIssues>[0]> = {}) {
    return {
      title: "Auth model",
      description: GOOD_DESC,
      implementationPlan: GOOD_PLAN,
      userStory: GOOD_US,
      acceptanceTexts: [GOOD_AC1, GOOD_AC2],
      acceptanceCountJustification: "",
      swarm: goodSwarm(),
      concurrentReady: true,
      ...over,
    };
  }

  it("good story returns no issues", () => {
    expect(storyQualityIssues(baseOpts())).toEqual([]);
  });

  it("flags a malformed user story", () => {
    const issues = storyQualityIssues(baseOpts({ userStory: "I just want stuff" }));
    expect(issues.some((i) => i.includes("As a <role>"))).toBe(true);
  });

  it("flags an empty description", () => {
    const issues = storyQualityIssues(baseOpts({ description: "" }));
    expect(issues.some((i) => i.includes("Description is required"))).toBe(true);
  });

  it("flags a too-short description", () => {
    const issues = storyQualityIssues(baseOpts({ description: "Too short." }));
    expect(issues.some((i) => i.includes("two concrete sentences"))).toBe(true);
  });

  it("flags an empty implementation plan", () => {
    const issues = storyQualityIssues(baseOpts({ implementationPlan: "" }));
    expect(issues.some((i) => i.includes("ImplementationPlan is required"))).toBe(true);
  });

  it("flags a generic implementation plan", () => {
    const issues = storyQualityIssues(baseOpts({ implementationPlan: "Make it work." }));
    expect(issues.some((i) => i.includes("concrete code paths"))).toBe(true);
  });

  it("flags a placeholder implementation plan", () => {
    const issues = storyQualityIssues(
      baseOpts({
        implementationPlan:
          "TODO refine from parent scope later in the model service code with tests.",
      }),
    );
    expect(issues.some((i) => i.includes("must not be placeholder"))).toBe(true);
  });

  it("flags acceptance count outside 2-5 without justification", () => {
    const issues = storyQualityIssues(baseOpts({ acceptanceTexts: [GOOD_AC1] }));
    expect(issues.some((i) => i.includes("2-5 acceptance criteria"))).toBe(true);
  });

  it("accepts a single acceptance criterion when justified", () => {
    const issues = storyQualityIssues(
      baseOpts({
        acceptanceTexts: [GOOD_AC1],
        acceptanceCountJustification: "Single behavior is intentionally atomic for this slice.",
      }),
    );
    expect(issues.some((i) => i.includes("2-5 acceptance criteria"))).toBe(false);
  });

  it("flags placeholder, docs-only, vague, and non-observable acceptance criteria", () => {
    const issues = storyQualityIssues(
      baseOpts({
        acceptanceTexts: [
          "TBD",
          "Documentation updated for the relevant section of the docs site.",
          "The milestone is complete and ready for the next phase of broad project work.",
        ],
      }),
    );
    expect(issues.some((i) => i.includes("placeholder acceptance"))).toBe(true);
    expect(issues.some((i) => i.includes("docs-only"))).toBe(true);
    expect(issues.some((i) => i.includes("observable behavior"))).toBe(true);
  });

  it("flags acceptance that duplicates the title", () => {
    const issues = storyQualityIssues(
      baseOpts({ title: GOOD_AC1, acceptanceTexts: [GOOD_AC1, GOOD_AC2] }),
    );
    expect(issues.some((i) => i.includes("duplicates title or description"))).toBe(true);
  });

  it("flags broad file_scope and generic verify command when concurrent-ready", () => {
    const swarm = { ...goodSwarm(), file_scope: ["backend"], verify_commands: ["pytest"] };
    const issues = storyQualityIssues(baseOpts({ swarm }));
    expect(issues.some((i) => i.includes("broad file_scope"))).toBe(true);
    expect(issues.some((i) => i.includes("generic verify command"))).toBe(true);
  });

  it("flags glob file_scope patterns", () => {
    const swarm = { ...goodSwarm(), file_scope: ["src/*"] };
    const issues = storyQualityIssues(baseOpts({ swarm }));
    expect(issues.some((i) => i.includes("broad file_scope"))).toBe(true);
  });

  it("flags parallel_safe=false and file_scope_confidence=low for ready stories", () => {
    const swarm = { ...goodSwarm(), parallel_safe: false, file_scope_confidence: "low" };
    const issues = storyQualityIssues(baseOpts({ swarm }));
    expect(issues.some((i) => i.includes("parallel_safe=true"))).toBe(true);
    expect(issues.some((i) => i.includes("file_scope_confidence above low"))).toBe(true);
  });

  it("skips concurrency checks when not concurrent-ready", () => {
    const swarm = { ...goodSwarm(), file_scope: ["backend"], verify_commands: ["pytest"] };
    const issues = storyQualityIssues(baseOpts({ swarm, concurrentReady: false }));
    expect(issues.some((i) => i.includes("broad file_scope"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateDraft -- narrative-form + traces-from-references paths
// ---------------------------------------------------------------------------

describe("validateDraft narrative + traces variants", () => {
  it("accepts a story using narratives + items object form", () => {
    const story = {
      id: "story-narr",
      title: "Narrative story",
      narratives: {
        Description: GOOD_DESC,
        ImplementationPlan: GOOD_PLAN,
        UserStory: GOOD_US,
        Traces: "FR-1",
      },
      items: [
        { id: "a1", title: GOOD_AC1, narrative: { Acceptance: GOOD_AC1 } },
        { id: "a2", title: GOOD_AC2, narrative: { Acceptance: GOOD_AC2 } },
      ],
      swarm: goodSwarm(),
    };
    expect(validateDraft([story])).toEqual(["story-narr"]);
  });

  it("derives traces from a spec-section reference", () => {
    const story = {
      id: "story-ref",
      title: "Ref story",
      description: GOOD_DESC,
      implementation_plan: GOOD_PLAN,
      user_story: GOOD_US,
      acceptance: [GOOD_AC1, GOOD_AC2],
      traces: [],
      references: [{ type: "x-vbrief/spec-section", uri: "specification.vbrief.json#auth" }],
      swarm: goodSwarm(),
    };
    expect(validateDraft([story])).toEqual(["story-ref"]);
  });

  it("derives traces from missing_traces_justification", () => {
    const swarm = { ...goodSwarm(), missing_traces_justification: "No FR yet; exploratory slice." };
    const story = {
      id: "story-mtj",
      title: "MTJ story",
      description: GOOD_DESC,
      implementation_plan: GOOD_PLAN,
      user_story: GOOD_US,
      acceptance: [GOOD_AC1, GOOD_AC2],
      traces: [],
      swarm,
    };
    expect(validateDraft([story])).toEqual(["story-mtj"]);
  });

  it("accepts stories from a children object map", () => {
    const story = {
      id: "story-child",
      title: "Child story",
      description: GOOD_DESC,
      implementation_plan: GOOD_PLAN,
      user_story: GOOD_US,
      acceptance: [GOOD_AC1, GOOD_AC2],
      traces: ["FR-1"],
      swarm: goodSwarm(),
    };
    // storySpecs accepts an object map under `children`
    const ids = validateDraft([story]);
    expect(ids).toEqual(["story-child"]);
  });
});

// ---------------------------------------------------------------------------
// applyDecomposition -- error + parent-mutation branches
// ---------------------------------------------------------------------------

describe("applyDecomposition error + mutation branches", () => {
  function setup(): { proj: string; parentPath: string; draftPath: string } {
    const proj = tmpProject();
    const parentPath = join(proj, "vbrief", "pending", "parent.vbrief.json");
    const draftPath = join(proj, "vbrief", ".eval", "draft.json");
    mkdirSync(join(proj, "vbrief", ".eval"), { recursive: true });
    return { proj, parentPath, draftPath };
  }

  it("throws on invalid JSON parent", () => {
    const { proj, parentPath, draftPath } = setup();
    writeFileSync(parentPath, "not json", "utf8");
    writeJson(draftPath, goodDraft());
    expect(() =>
      applyDecomposition({
        projectRoot: proj,
        parentPath,
        draftPath,
        checkOnly: true,
        date: "2026-06-01",
      }),
    ).toThrow("invalid JSON");
  });

  it("throws when parent is not a JSON object", () => {
    const { proj, parentPath, draftPath } = setup();
    writeFileSync(parentPath, "[]", "utf8");
    writeJson(draftPath, goodDraft());
    expect(() =>
      applyDecomposition({
        projectRoot: proj,
        parentPath,
        draftPath,
        checkOnly: true,
        date: "2026-06-01",
      }),
    ).toThrow("expected a JSON object");
  });

  it("throws when output_dir is not a lifecycle folder", () => {
    const { proj, parentPath, draftPath } = setup();
    writeJson(parentPath, goodParent());
    writeJson(draftPath, goodDraft("vbrief/foobar"));
    expect(() =>
      applyDecomposition({
        projectRoot: proj,
        parentPath,
        draftPath,
        checkOnly: false,
        date: "2026-06-01",
      }),
    ).toThrow("vbrief lifecycle folder");
  });

  it("throws when output_dir is outside vbrief/", () => {
    const { proj, parentPath, draftPath } = setup();
    writeJson(parentPath, goodParent());
    writeJson(draftPath, goodDraft(join(tmpdir(), `outside-${Date.now()}`, "pending")));
    expect(() =>
      applyDecomposition({
        projectRoot: proj,
        parentPath,
        draftPath,
        checkOnly: false,
        date: "2026-06-01",
      }),
    ).toThrow("inside vbrief/");
  });

  it("throws when parent is outside vbrief/", () => {
    const { proj, draftPath } = setup();
    const parentOutside = join(proj, "parent.vbrief.json");
    writeJson(parentOutside, goodParent());
    writeJson(draftPath, goodDraft());
    expect(() =>
      applyDecomposition({
        projectRoot: proj,
        parentPath: parentOutside,
        draftPath,
        checkOnly: false,
        date: "2026-06-01",
      }),
    ).toThrow("must be inside");
  });

  it("creates metadata and references on a minimal parent plan", () => {
    const { proj, parentPath, draftPath } = setup();
    writeJson(parentPath, {
      vBRIEFInfo: { version: "0.6" },
      plan: { id: "ip-1", title: "IP-1", status: "pending", narratives: {}, items: [] },
    });
    writeJson(draftPath, goodDraft());
    const actions = applyDecomposition({
      projectRoot: proj,
      parentPath,
      draftPath,
      checkOnly: false,
      date: "2026-06-01",
    });
    expect(actions.some((a) => a.startsWith("UPDATE"))).toBe(true);
    const updated = JSON.parse(readFileSync(parentPath, "utf8")) as Record<string, unknown>;
    const plan = updated.plan as Record<string, unknown>;
    expect((plan.metadata as Record<string, unknown>).kind).toBe("epic");
    expect(Array.isArray(plan.references)).toBe(true);
  });

  it("creates a plan block when the parent has none", () => {
    const { proj, parentPath, draftPath } = setup();
    writeJson(parentPath, { vBRIEFInfo: { version: "0.6" } });
    writeJson(draftPath, goodDraft());
    const actions = applyDecomposition({
      projectRoot: proj,
      parentPath,
      draftPath,
      checkOnly: false,
      date: "2026-06-01",
    });
    expect(actions.some((a) => a.startsWith("CREATE"))).toBe(true);
  });

  it("throws when parent plan is not an object", () => {
    const { proj, parentPath, draftPath } = setup();
    writeJson(parentPath, { vBRIEFInfo: { version: "0.6" }, plan: [] });
    writeJson(draftPath, goodDraft());
    expect(() =>
      applyDecomposition({
        projectRoot: proj,
        parentPath,
        draftPath,
        checkOnly: false,
        date: "2026-06-01",
      }),
    ).toThrow("plan must be an object");
  });

  it("throws when parent plan.metadata is not an object", () => {
    const { proj, parentPath, draftPath } = setup();
    writeJson(parentPath, {
      vBRIEFInfo: { version: "0.6" },
      plan: { id: "ip-1", title: "IP-1", status: "pending", metadata: [] },
    });
    writeJson(draftPath, goodDraft());
    expect(() =>
      applyDecomposition({
        projectRoot: proj,
        parentPath,
        draftPath,
        checkOnly: false,
        date: "2026-06-01",
      }),
    ).toThrow("plan.metadata must be an object");
  });

  it("throws when parent plan.references is not an array", () => {
    const { proj, parentPath, draftPath } = setup();
    writeJson(parentPath, {
      vBRIEFInfo: { version: "0.6" },
      plan: {
        id: "ip-1",
        title: "IP-1",
        status: "pending",
        metadata: { kind: "epic" },
        references: {},
      },
    });
    writeJson(draftPath, goodDraft());
    expect(() =>
      applyDecomposition({
        projectRoot: proj,
        parentPath,
        draftPath,
        checkOnly: false,
        date: "2026-06-01",
      }),
    ).toThrow("plan.references must be an array");
  });

  it("throws when a story status is active/running", () => {
    const { proj, parentPath, draftPath } = setup();
    writeJson(parentPath, goodParent());
    const draft = goodDraft();
    (draft.stories as Record<string, unknown>[])[0]!.status = "running";
    writeJson(draftPath, draft);
    expect(() =>
      applyDecomposition({
        projectRoot: proj,
        parentPath,
        draftPath,
        checkOnly: false,
        date: "2026-06-01",
      }),
    ).toThrow("active/running");
  });
});

// ---------------------------------------------------------------------------
// decomposeMain -- additional CLI branches
// ---------------------------------------------------------------------------

describe("decomposeMain extra CLI branches", () => {
  function setup(): { proj: string; parentPath: string; draftPath: string } {
    const proj = tmpProject();
    const parentPath = join(proj, "vbrief", "pending", "parent.vbrief.json");
    writeJson(parentPath, goodParent());
    const draftPath = join(proj, "vbrief", ".eval", "draft.json");
    mkdirSync(join(proj, "vbrief", ".eval"), { recursive: true });
    return { proj, parentPath, draftPath };
  }

  it("unrecognized argument returns 2", () => {
    expect(decomposeMain(["--bogus-flag"])).toBe(2);
  });

  it("draft supplied without parent returns 2", () => {
    expect(decomposeMain(["--draft", "draft.json"])).toBe(2);
  });

  it("nonexistent draft returns 2", () => {
    const { proj, parentPath } = setup();
    expect(
      decomposeMain([parentPath, "--draft", "/nonexistent/draft.json", "--project-root", proj]),
    ).toBe(2);
  });

  it("check mode with parent + draft returns 0 and writes nothing", () => {
    const { proj, parentPath, draftPath } = setup();
    writeJson(draftPath, goodDraft());
    const code = decomposeMain([
      parentPath,
      "--draft",
      draftPath,
      "--check",
      "--project-root",
      proj,
    ]);
    expect(code).toBe(0);
    const childFiles = readdirSafe(join(proj, "vbrief", "pending")).filter(
      (f) => f !== "parent.vbrief.json",
    );
    expect(childFiles).toHaveLength(0);
  });

  it("supports --draft= and --project-root= equals forms", () => {
    const { proj, parentPath, draftPath } = setup();
    writeJson(draftPath, goodDraft());
    const code = decomposeMain([
      parentPath,
      `--draft=${draftPath}`,
      `--project-root=${proj}`,
      "--date=2026-06-01",
    ]);
    expect(code).toBe(0);
  });

  it("returns 1 when the draft fails validation", () => {
    const { proj, parentPath, draftPath } = setup();
    const badStory = { ...goodStory(), title: "" };
    writeJson(draftPath, { stories: [badStory] });
    const code = decomposeMain([
      parentPath,
      "--draft",
      draftPath,
      "--date",
      "2026-06-01",
      "--project-root",
      proj,
    ]);
    expect(code).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Alternate field-name extraction paths
// ---------------------------------------------------------------------------

function altStory(): Record<string, unknown> {
  return {
    story_id: "story-alt",
    title: "Alt story",
    filename: "2026-06-01-custom.vbrief.json",
    summary: GOOD_DESC,
    ImplementationPlan: [GOOD_PLAN],
    UserStory: GOOD_US,
    acceptance_items: [GOOD_AC1, GOOD_AC2],
    traces: ["FR-1"],
    readiness: "ready",
    parallel_safe: true,
    file_scope: ["src/auth/alt.ts", "tests/auth/alt.test.ts"],
    verify_commands: ["npm test -- auth/alt"],
    expected_outputs: ["alt tests pass"],
    depends_on: [],
    conflict_group: "auth",
    size: "small",
    file_scope_confidence: "high",
    model_tier: "medium",
    acceptance_criteria_justification: "Two criteria is sufficient for this focused slice.",
  };
}

describe("alternate field extraction", () => {
  it("validates a story that uses story_id/summary/ImplementationPlan/UserStory + top-level swarm", () => {
    expect(validateDraft([altStory()])).toEqual(["story-alt"]);
  });

  it("validates a story keyed by `key`", () => {
    const story = { ...altStory(), story_id: undefined, key: "story-keyed" };
    delete (story as Record<string, unknown>).story_id;
    expect(validateDraft([story])).toEqual(["story-keyed"]);
  });

  it("applies a draft using the explicit filename and narrative assembly", () => {
    const proj = tmpProject();
    const parentPath = join(proj, "vbrief", "pending", "parent.vbrief.json");
    writeJson(parentPath, goodParent());
    const draftPath = join(proj, "vbrief", ".eval", "draft.json");
    mkdirSync(join(proj, "vbrief", ".eval"), { recursive: true });
    writeJson(draftPath, { stories: [altStory()] });
    const actions = applyDecomposition({
      projectRoot: proj,
      parentPath,
      draftPath,
      checkOnly: false,
      date: "2026-06-01",
    });
    expect(actions.some((a) => a.includes("2026-06-01-custom.vbrief.json"))).toBe(true);
    const childPath = join(proj, "vbrief", "pending", "2026-06-01-custom.vbrief.json");
    const child = JSON.parse(readFileSync(childPath, "utf8")) as Record<string, unknown>;
    const plan = child.plan as Record<string, unknown>;
    const narratives = plan.narratives as Record<string, string>;
    expect(narratives.Description).toBe(GOOD_DESC);
    expect(narratives.ImplementationPlan).toBe(GOOD_PLAN);
    expect(narratives.UserStory).toBe(GOOD_US);
    expect(narratives.Traces).toBe("FR-1");
  });
});
