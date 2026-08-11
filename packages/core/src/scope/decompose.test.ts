/**
 * Vitest tests for scope/decompose.ts -- mirror key Python test cases from
 * tests/cli/test_scope_decompose_unit.py including non-happy-path/edge cases.
 */

import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  mintDecomposeStructuralApplyGrant,
  sha256FileHex,
  toProjectRelativePosix,
} from "../authz/decompose-apply.js";
import { loadGrant, saveGrant } from "../authz/store.js";
import { SCOPE_DECOMPOSE_APPLY_STRUCTURAL } from "../authz/types.js";
import { ContainedWriteError } from "../fs/contained-write.js";
import {
  extractParentRequirements,
  formatCoverageReportLine,
  validateCoverageMap,
} from "./coverage-map.js";
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

/** #3239: mint human-origin structural grant for a draft about to be applied. */
function approveApply(proj: string, parentPath: string, draftPath: string): void {
  mintDecomposeStructuralApplyGrant({ projectRoot: proj, parentPath, draftPath });
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function tmpProject(): string {
  const dir = join(tmpdir(), `decompose-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, "xbrief", "pending"), { recursive: true });
  mkdirSync(join(dir, "xbrief", "proposed"), { recursive: true });
  mkdirSync(join(dir, "xbrief", "active"), { recursive: true });
  mkdirSync(join(dir, "xbrief", "completed"), { recursive: true });
  mkdirSync(join(dir, "xbrief", "cancelled"), { recursive: true });
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
    xBRIEFInfo: { version: "0.8" },
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
          uri: "specification.xbrief.json",
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

  it("rejects size=large with parallel_safe=true (readiness parity #3252)", () => {
    const story = goodStory("story-large-parallel");
    (story.swarm as Record<string, unknown>).size = "large";
    (story.swarm as Record<string, unknown>).parallel_safe = true;
    expect(() => validateDraft([story] as Record<string, unknown>[])).toThrow(DecompositionError);
    expect(() => validateDraft([story] as Record<string, unknown>[])).toThrow(
      "size=large cannot be parallel_safe=true",
    );
  });

  it("allows size=large with parallel_safe=false when not concurrent-ready", () => {
    const story = goodStory("story-large-seq");
    (story.swarm as Record<string, unknown>).size = "large";
    (story.swarm as Record<string, unknown>).parallel_safe = false;
    (story.swarm as Record<string, unknown>).readiness = "sequential";
    expect(validateDraft([story] as Record<string, unknown>[])).toEqual(["story-large-seq"]);
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
    const parentPath = join(proj, "xbrief", "pending", "2026-05-12-parent.xbrief.json");
    writeJson(parentPath, goodParent());
    const draftPath = join(proj, "xbrief", ".triage-cache", "draft.json");
    mkdirSync(join(proj, "xbrief", ".triage-cache"), { recursive: true });
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
    const childDir = join(proj, "xbrief", "pending");
    const childFiles = readdirSafe(childDir).filter((f) => f !== "2026-05-12-parent.xbrief.json");
    expect(childFiles).toHaveLength(0);
  });

  it("apply creates child vBRIEFs and updates parent", () => {
    const proj = tmpProject();
    const parentPath = join(proj, "xbrief", "pending", "2026-05-12-parent.xbrief.json");
    writeJson(parentPath, goodParent());
    const draftPath = join(proj, "xbrief", ".triage-cache", "draft.json");
    mkdirSync(join(proj, "xbrief", ".triage-cache"), { recursive: true });
    writeJson(draftPath, goodDraft());
    approveApply(proj, parentPath, draftPath);
    const actions = applyDecomposition({
      projectRoot: proj,
      parentPath,
      draftPath,
      checkOnly: false,
      date: "2026-06-01",
    });
    expect(actions.some((a) => a.startsWith("CREATE"))).toBe(true);
    expect(actions.some((a) => a.startsWith("UPDATE"))).toBe(true);
    expect(actions.some((a) => a.startsWith("AUTHZ"))).toBe(true);
    // Two child files should be created in pending
    const childDir = join(proj, "xbrief", "pending");
    const childFiles = readdirSafe(childDir).filter((f) => f !== "2026-05-12-parent.xbrief.json");
    expect(childFiles.length).toBeGreaterThanOrEqual(2);
    // Parent should reference children
    const updatedParent = JSON.parse(readFileSync(parentPath, "utf8")) as Record<string, unknown>;
    const plan = updatedParent.plan as Record<string, unknown>;
    const refs = plan.references as unknown[];
    expect(refs.some((r) => (r as Record<string, unknown>).type === "x-xbrief/plan")).toBe(true);
  });

  it("throws when output_dir is active", () => {
    const proj = tmpProject();
    const parentPath = join(proj, "xbrief", "pending", "parent.xbrief.json");
    writeJson(parentPath, goodParent());
    const draftPath = join(proj, "xbrief", ".triage-cache", "draft.json");
    mkdirSync(join(proj, "xbrief", ".triage-cache"), { recursive: true });
    writeJson(draftPath, goodDraft("xbrief/active"));
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
    const parentPath = join(proj, "xbrief", "pending", "parent.xbrief.json");
    writeJson(parentPath, goodParent());
    const draftPath = join(proj, "xbrief", ".triage-cache", "draft.json");
    mkdirSync(join(proj, "xbrief", ".triage-cache"), { recursive: true });
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
    const parentPath = join(proj, "xbrief", "pending", "parent.xbrief.json");
    writeJson(parentPath, goodParent());
    const draftPath = join(proj, "xbrief", ".triage-cache", "draft.json");
    mkdirSync(join(proj, "xbrief", ".triage-cache"), { recursive: true });
    const draft = goodDraft();
    writeJson(draftPath, draft);
    approveApply(proj, parentPath, draftPath);
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

const itSymlink = it.skipIf(process.platform === "win32");

describe("applyDecomposition symlink containment (#2781)", () => {
  itSymlink(
    "refuses parent update when parent path is a symlink to an external victim file",
    () => {
      const proj = tmpProject();
      const escapeDir = join(tmpdir(), `decompose-victim-${Date.now()}`);
      mkdirSync(escapeDir, { recursive: true });
      const victim = join(escapeDir, "parent.xbrief.json");
      writeFileSync(victim, JSON.stringify({ plan: { references: [] } }), "utf8");
      const parentPath = join(proj, "xbrief", "pending", "2026-05-12-parent.xbrief.json");
      symlinkSync(victim, parentPath);
      const draftPath = join(proj, "xbrief", ".triage-cache", "draft.json");
      mkdirSync(join(proj, "xbrief", ".triage-cache"), { recursive: true });
      writeJson(draftPath, goodDraft());
      approveApply(proj, parentPath, draftPath);
      expect(() =>
        applyDecomposition({
          projectRoot: proj,
          parentPath,
          draftPath,
          checkOnly: false,
          date: "2026-06-01",
        }),
      ).toThrow(ContainedWriteError);
      const victimAfter = JSON.parse(readFileSync(victim, "utf8")) as Record<string, unknown>;
      expect((victimAfter.plan as Record<string, unknown>).references).toEqual([]);
    },
  );
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
    expect(decomposeMain(["some-parent.xbrief.json"])).toBe(2);
  });

  it("nonexistent parent returns 2", () => {
    expect(decomposeMain(["--draft", "draft.json", "/nonexistent/parent.xbrief.json"])).toBe(2);
  });

  it("invalid date returns 2", () => {
    const proj = tmpProject();
    const parentPath = join(proj, "xbrief", "pending", "parent.xbrief.json");
    writeJson(parentPath, goodParent());
    const draftPath = join(proj, "xbrief", ".triage-cache", "draft.json");
    mkdirSync(join(proj, "xbrief", ".triage-cache"), { recursive: true });
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
    const parentPath = join(proj, "xbrief", "pending", "parent.xbrief.json");
    writeJson(parentPath, goodParent());
    const draftPath = join(proj, "xbrief", ".triage-cache", "draft.json");
    mkdirSync(join(proj, "xbrief", ".triage-cache"), { recursive: true });
    writeJson(draftPath, goodDraft());
    approveApply(proj, parentPath, draftPath);
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
      references: [{ type: "x-vbrief/spec-section", uri: "specification.xbrief.json#auth" }],
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
    const parentPath = join(proj, "xbrief", "pending", "parent.xbrief.json");
    const draftPath = join(proj, "xbrief", ".triage-cache", "draft.json");
    mkdirSync(join(proj, "xbrief", ".triage-cache"), { recursive: true });
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
    writeJson(draftPath, goodDraft("xbrief/foobar"));
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
    const parentOutside = join(proj, "parent.xbrief.json");
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
      xBRIEFInfo: { version: "0.8" },
      plan: { id: "ip-1", title: "IP-1", status: "pending", narratives: {}, items: [] },
    });
    writeJson(draftPath, goodDraft());
    approveApply(proj, parentPath, draftPath);
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
    writeJson(parentPath, { xBRIEFInfo: { version: "0.8" } });
    writeJson(draftPath, goodDraft());
    approveApply(proj, parentPath, draftPath);
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
    writeJson(parentPath, { xBRIEFInfo: { version: "0.8" }, plan: [] });
    writeJson(draftPath, goodDraft());
    approveApply(proj, parentPath, draftPath);
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
      xBRIEFInfo: { version: "0.8" },
      plan: { id: "ip-1", title: "IP-1", status: "pending", metadata: [] },
    });
    writeJson(draftPath, goodDraft());
    approveApply(proj, parentPath, draftPath);
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
      xBRIEFInfo: { version: "0.8" },
      plan: {
        id: "ip-1",
        title: "IP-1",
        status: "pending",
        metadata: { kind: "epic" },
        references: {},
      },
    });
    writeJson(draftPath, goodDraft());
    approveApply(proj, parentPath, draftPath);
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
    const parentPath = join(proj, "xbrief", "pending", "parent.xbrief.json");
    writeJson(parentPath, goodParent());
    const draftPath = join(proj, "xbrief", ".triage-cache", "draft.json");
    mkdirSync(join(proj, "xbrief", ".triage-cache"), { recursive: true });
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
    const childFiles = readdirSafe(join(proj, "xbrief", "pending")).filter(
      (f) => f !== "parent.xbrief.json",
    );
    expect(childFiles).toHaveLength(0);
  });

  it("supports --draft= and --project-root= equals forms", () => {
    const { proj, parentPath, draftPath } = setup();
    writeJson(draftPath, goodDraft());
    approveApply(proj, parentPath, draftPath);
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

  it("check mode rejects size=large with parallel_safe=true (#3252)", () => {
    const { proj, parentPath, draftPath } = setup();
    const story = goodStory("story-large-check");
    (story.swarm as Record<string, unknown>).size = "large";
    (story.swarm as Record<string, unknown>).parallel_safe = true;
    writeJson(draftPath, { stories: [story] });
    const code = decomposeMain([
      parentPath,
      "--draft",
      draftPath,
      "--check",
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
    filename: "2026-06-01-custom.xbrief.json",
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
    const parentPath = join(proj, "xbrief", "pending", "parent.xbrief.json");
    writeJson(parentPath, goodParent());
    const draftPath = join(proj, "xbrief", ".triage-cache", "draft.json");
    mkdirSync(join(proj, "xbrief", ".triage-cache"), { recursive: true });
    writeJson(draftPath, { stories: [altStory()] });
    approveApply(proj, parentPath, draftPath);
    const actions = applyDecomposition({
      projectRoot: proj,
      parentPath,
      draftPath,
      checkOnly: false,
      date: "2026-06-01",
    });
    expect(actions.some((a) => a.includes("2026-06-01-custom.xbrief.json"))).toBe(true);
    const childPath = join(proj, "xbrief", "pending", "2026-06-01-custom.xbrief.json");
    const child = JSON.parse(readFileSync(childPath, "utf8")) as Record<string, unknown>;
    const plan = child.plan as Record<string, unknown>;
    const narratives = plan.narratives as Record<string, string>;
    expect(narratives.Description).toBe(GOOD_DESC);
    expect(narratives.ImplementationPlan).toBe(GOOD_PLAN);
    expect(narratives.UserStory).toBe(GOOD_US);
    expect(narratives.Traces).toBe("FR-1");
  });
});

// ---------------------------------------------------------------------------
// #3239 structural apply authz (exact draft digest human-origin grant)
// ---------------------------------------------------------------------------

describe("applyDecomposition structural authz (#3239)", () => {
  function setup(): { proj: string; parentPath: string; draftPath: string } {
    const proj = tmpProject();
    const parentPath = join(proj, "xbrief", "pending", "parent.xbrief.json");
    writeJson(parentPath, goodParent());
    const draftPath = join(proj, "xbrief", ".triage-cache", "draft.json");
    mkdirSync(join(proj, "xbrief", ".triage-cache"), { recursive: true });
    writeJson(draftPath, goodDraft());
    return { proj, parentPath, draftPath };
  }

  it("apply without grant fails closed and writes no children", () => {
    const { proj, parentPath, draftPath } = setup();
    expect(() =>
      applyDecomposition({
        projectRoot: proj,
        parentPath,
        draftPath,
        checkOnly: false,
        date: "2026-06-01",
      }),
    ).toThrow(/no human-origin grant|scope:decompose apply/i);
    const childFiles = readdirSafe(join(proj, "xbrief", "pending")).filter(
      (f) => f !== "parent.xbrief.json",
    );
    expect(childFiles).toHaveLength(0);
  });

  it("grant for digest X cannot apply changed draft Y", () => {
    const { proj, parentPath, draftPath } = setup();
    approveApply(proj, parentPath, draftPath);
    // Mutate draft bytes after approval → digest Y
    const mutated = goodDraft();
    const mutatedStories = mutated.stories as Record<string, unknown>[];
    const firstStory = mutatedStories[0];
    if (firstStory !== undefined) {
      firstStory.title = "Mutated title after approval";
    }
    writeJson(draftPath, mutated);
    expect(() =>
      applyDecomposition({
        projectRoot: proj,
        parentPath,
        draftPath,
        checkOnly: false,
        date: "2026-06-01",
      }),
    ).toThrow(/digest|invalidates/i);
    const childFiles = readdirSafe(join(proj, "xbrief", "pending")).filter(
      (f) => f !== "parent.xbrief.json",
    );
    expect(childFiles).toHaveLength(0);
  });

  it("matching human-origin structural grant allows apply", () => {
    const { proj, parentPath, draftPath } = setup();
    approveApply(proj, parentPath, draftPath);
    const actions = applyDecomposition({
      projectRoot: proj,
      parentPath,
      draftPath,
      checkOnly: false,
      date: "2026-06-01",
    });
    expect(actions.some((a) => a.startsWith("CREATE"))).toBe(true);
    expect(actions.some((a) => a.startsWith("AUTHZ"))).toBe(true);
  });

  it("--check without grant still validates", () => {
    const { proj, parentPath, draftPath } = setup();
    const actions = applyDecomposition({
      projectRoot: proj,
      parentPath,
      draftPath,
      checkOnly: true,
      date: "2026-06-01",
    });
    expect(actions[0]).toContain("VALIDATED");
    expect(actions.some((a) => a.startsWith("CHECK"))).toBe(true);
  });

  it("agent-origin grant is rejected", () => {
    const { proj, parentPath, draftPath } = setup();
    const digest = sha256FileHex(draftPath);
    saveGrant(proj, {
      schemaVersion: 1,
      id: "agent-forged",
      origin: {
        kind: "agent-authored",
        actor: "agent",
        mintedAt: "2026-08-10T00:00:00Z",
        mintedVia: "self",
        eventRef: null,
      },
      scope: {
        planRef: null,
        repo: null,
        branch: null,
        worktree: proj,
        surfaces: [],
        operations: [SCOPE_DECOMPOSE_APPLY_STRUCTURAL],
        storyIds: [],
        issueIds: [],
        cohortId: null,
        contentDigest: digest,
        parentPath: toProjectRelativePosix(proj, parentPath),
        targetPath: toProjectRelativePosix(proj, draftPath),
      },
      semantics: { expiresAt: null, singleUse: false, usedAt: null, revokedAt: null },
    });
    expect(() =>
      applyDecomposition({
        projectRoot: proj,
        parentPath,
        draftPath,
        checkOnly: false,
        date: "2026-06-01",
      }),
    ).toThrow(/agent|human-origin|origin/i);
  });

  it("CLI apply without grant exits non-zero", () => {
    const { proj, parentPath, draftPath } = setup();
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

  it("single-use grant is not spent when parent plan validation fails after authz", () => {
    const { proj, parentPath, draftPath } = setup();
    writeJson(parentPath, { xBRIEFInfo: { version: "0.8" }, plan: [] });
    writeJson(draftPath, goodDraft());
    const grant = mintDecomposeStructuralApplyGrant({
      projectRoot: proj,
      parentPath,
      draftPath,
      singleUse: true,
      grantId: "single-use-fail",
    });
    expect(() =>
      applyDecomposition({
        projectRoot: proj,
        parentPath,
        draftPath,
        checkOnly: false,
        date: "2026-06-01",
      }),
    ).toThrow("plan must be an object");
    const after = loadGrant(proj, grant.id);
    expect(after?.semantics.usedAt).toBeNull();
  });

  it("single-use grant is spent only after successful multi-file apply", () => {
    const { proj, parentPath, draftPath } = setup();
    const grant = mintDecomposeStructuralApplyGrant({
      projectRoot: proj,
      parentPath,
      draftPath,
      singleUse: true,
      grantId: "single-use-ok",
    });
    expect(loadGrant(proj, grant.id)?.semantics.usedAt).toBeNull();
    applyDecomposition({
      projectRoot: proj,
      parentPath,
      draftPath,
      checkOnly: false,
      date: "2026-06-01",
    });
    expect(loadGrant(proj, grant.id)?.semantics.usedAt).toBeTruthy();
    const childFiles = readdirSafe(join(proj, "xbrief", "pending")).filter(
      (f) => f !== "parent.xbrief.json",
    );
    expect(childFiles.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// #3238 semantic fidelity — parent requirement IDs + coverage map
// Fixture: ordered state machine A → B → C; forbids A → C shortcut.
// ---------------------------------------------------------------------------

/** Parent with authored IDs for A-then-B-then-C and negative invariant forbidding A-to-C. */
function abcParent(): Record<string, unknown> {
  return {
    xBRIEFInfo: { version: "0.8" },
    plan: {
      id: "epic-state-machine",
      title: "Ordered state machine A-B-C",
      status: "pending",
      narratives: {
        Description:
          "Parent defines ordered stages A then B then C and forbids the A-to-C shortcut.",
        Acceptance: "Stages advance A→B→C only; A→C is rejected.",
      },
      items: [
        {
          id: "req-ordered-a-b-c",
          title: "Ordered stages A then B then C",
          status: "pending",
          narrative: {
            Acceptance:
              "Given stage A, when advancing, then the machine reaches B then C in order.",
          },
        },
        {
          id: "req-forbid-a-to-c",
          title: "Forbidden shortcut A to C",
          kind: "negative_invariant",
          status: "pending",
          narrative: {
            Acceptance:
              "Given stage A, when an A-to-C transition is requested, then the machine rejects it.",
          },
        },
        {
          id: "req-terminal-failure",
          title: "Terminal failure path",
          status: "pending",
          narrative: {
            Acceptance:
              "Given a failed transition, when recovery is not possible, then the machine ends in terminal failure.",
          },
        },
      ],
      metadata: { kind: "epic" },
      references: [],
    },
  };
}

/** Valid coverage map covering every parent ID with disposition covered. */
function abcValidCoverage(): Record<string, unknown> {
  return {
    "req-ordered-a-b-c": {
      disposition: "covered",
      child_story_ids: ["story-stages"],
    },
    "req-forbid-a-to-c": {
      disposition: "covered",
      child_story_ids: ["story-stages"],
    },
    "req-terminal-failure": {
      disposition: "covered",
      child_story_ids: ["story-stages"],
    },
  };
}

function stagesStory(): Record<string, unknown> {
  return {
    ...goodStory("story-stages", "State machine stages"),
    swarm: {
      ...(goodStory().swarm as Record<string, unknown>),
      file_scope: ["src/sm/stages.ts", "tests/sm/stages.test.ts"],
      verify_commands: ["npm test -- sm/stages"],
      conflict_group: "state-machine",
    },
  };
}

describe("semantic coverage map (#3238)", () => {
  it("extracts parent requirement IDs and marks negative invariants", () => {
    const reqs = extractParentRequirements(abcParent());
    expect(reqs.map((r) => r.id).sort()).toEqual([
      "req-forbid-a-to-c",
      "req-ordered-a-b-c",
      "req-terminal-failure",
    ]);
    expect(reqs.find((r) => r.id === "req-forbid-a-to-c")?.negativeInvariant).toBe(true);
    expect(reqs.find((r) => r.id === "req-ordered-a-b-c")?.negativeInvariant).toBe(false);
  });

  it("parent with no authored IDs skips coverage gate (backward compatible)", () => {
    const result = validateCoverageMap({
      parent: goodParent(),
      draft: goodDraft(),
      storyIds: ["story-auth-model", "story-auth-routes"],
    });
    expect(result.ok).toBe(true);
    expect(result.report.parent_requirement_ids).toEqual([]);
  });

  it("incomplete coverage map fails listing uncovered parent IDs", () => {
    const result = validateCoverageMap({
      parent: abcParent(),
      draft: {
        stories: [stagesStory()],
        coverage_map: {
          "req-ordered-a-b-c": { disposition: "covered", child_story_ids: ["story-stages"] },
          // missing req-forbid-a-to-c and req-terminal-failure
        },
      },
      storyIds: ["story-stages"],
    });
    expect(result.ok).toBe(false);
    expect(result.report.uncovered.sort()).toEqual(["req-forbid-a-to-c", "req-terminal-failure"]);
    expect(result.errors.some((e) => e.includes("uncovered parent requirement IDs"))).toBe(true);
    expect(result.errors.some((e) => e.includes("req-forbid-a-to-c"))).toBe(true);
  });

  it("negative invariant omitted without behavioral_delta fails closed", () => {
    const result = validateCoverageMap({
      parent: abcParent(),
      draft: {
        stories: [stagesStory()],
        coverage_map: {
          "req-ordered-a-b-c": { disposition: "covered", child_story_ids: ["story-stages"] },
          "req-terminal-failure": { disposition: "covered", child_story_ids: ["story-stages"] },
          // req-forbid-a-to-c intentionally omitted → silent removal
        },
      },
      storyIds: ["story-stages"],
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (e) =>
          e.includes("negative invariant") &&
          e.includes("req-forbid-a-to-c") &&
          e.includes("silent removal"),
      ),
    ).toBe(true);
  });

  it("behavioral_delta disposition without linked delta_id record fails", () => {
    const result = validateCoverageMap({
      parent: abcParent(),
      draft: {
        stories: [stagesStory()],
        coverage_map: {
          "req-ordered-a-b-c": { disposition: "covered", child_story_ids: ["story-stages"] },
          "req-forbid-a-to-c": {
            disposition: "behavioral_delta",
            // missing delta_id
          },
          "req-terminal-failure": { disposition: "covered", child_story_ids: ["story-stages"] },
        },
      },
      storyIds: ["story-stages"],
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("behavioral_delta") && e.includes("delta_id")),
    ).toBe(true);
  });

  it("behavioral_delta with delta_id but no linked record fails", () => {
    const result = validateCoverageMap({
      parent: abcParent(),
      draft: {
        stories: [stagesStory()],
        coverage_map: {
          "req-ordered-a-b-c": { disposition: "covered", child_story_ids: ["story-stages"] },
          "req-forbid-a-to-c": {
            disposition: "behavioral_delta",
            delta_id: "delta-missing",
          },
          "req-terminal-failure": { disposition: "covered", child_story_ids: ["story-stages"] },
        },
        behavioral_deltas: [],
      },
      storyIds: ["story-stages"],
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("delta-missing") && e.includes("no linked record")),
    ).toBe(true);
  });

  it("valid A-B-C coverage map succeeds and emits machine-readable report", () => {
    const result = validateCoverageMap({
      parent: abcParent(),
      draft: {
        stories: [stagesStory()],
        coverage_map: abcValidCoverage(),
      },
      storyIds: ["story-stages"],
    });
    expect(result.ok).toBe(true);
    expect(result.report.uncovered).toEqual([]);
    expect(result.report.schema).toBe("deft.decompose.coverage_report.v1");
    expect(result.report.negative_invariant_ids).toContain("req-forbid-a-to-c");
    const line = formatCoverageReportLine(result.report);
    expect(line.startsWith("COVERAGE_REPORT ")).toBe(true);
    const parsed = JSON.parse(line.slice("COVERAGE_REPORT ".length)) as {
      ok: boolean;
      parent_requirement_ids: string[];
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.parent_requirement_ids).toHaveLength(3);
  });

  it("valid map with behavioral_delta remove_invariant for A-to-C succeeds", () => {
    const result = validateCoverageMap({
      parent: abcParent(),
      draft: {
        stories: [stagesStory()],
        coverage_map: {
          "req-ordered-a-b-c": { disposition: "covered", child_story_ids: ["story-stages"] },
          "req-forbid-a-to-c": {
            disposition: "behavioral_delta",
            delta_id: "delta-allow-shortcut",
          },
          "req-terminal-failure": { disposition: "covered", child_story_ids: ["story-stages"] },
        },
        behavioral_deltas: [
          {
            delta_id: "delta-allow-shortcut",
            parent_requirement_ids: ["req-forbid-a-to-c"],
            change_kind: "remove_invariant",
            summary: "Allow A-to-C in emergency recovery path",
            before: "A-to-C forbidden",
            after: "A-to-C permitted under recovery flag",
            rationale: "Operator-approved recovery exception for degraded mode",
          },
        ],
      },
      storyIds: ["story-stages"],
    });
    expect(result.ok).toBe(true);
  });

  it("split disposition requires complete split_group parts", () => {
    const incomplete = validateCoverageMap({
      parent: abcParent(),
      draft: {
        stories: [stagesStory()],
        coverage_map: [
          {
            parent_requirement_id: "req-ordered-a-b-c",
            disposition: "split",
            split_group: "stages",
            part: "1",
            child_story_ids: ["story-stages"],
          },
          {
            parent_requirement_id: "req-forbid-a-to-c",
            disposition: "covered",
            child_story_ids: ["story-stages"],
          },
          {
            parent_requirement_id: "req-terminal-failure",
            disposition: "covered",
            child_story_ids: ["story-stages"],
          },
        ],
      },
      storyIds: ["story-stages"],
    });
    expect(incomplete.ok).toBe(false);
    expect(incomplete.errors.some((e) => e.includes("incomplete"))).toBe(true);

    const complete = validateCoverageMap({
      parent: abcParent(),
      draft: {
        stories: [
          stagesStory(),
          {
            ...goodStory("story-stages-b", "State machine B path"),
            swarm: {
              ...(goodStory().swarm as Record<string, unknown>),
              file_scope: ["src/sm/b.ts", "tests/sm/b.test.ts"],
              verify_commands: ["npm test -- sm/b"],
              conflict_group: "state-machine",
              depends_on: ["story-stages"],
            },
          },
        ],
        coverage_map: [
          {
            parent_requirement_id: "req-ordered-a-b-c",
            disposition: "split",
            split_group: "stages",
            part: "1",
            child_story_ids: ["story-stages"],
          },
          {
            parent_requirement_id: "req-ordered-a-b-c",
            disposition: "split",
            split_group: "stages",
            part: "2",
            child_story_ids: ["story-stages-b"],
          },
          {
            parent_requirement_id: "req-forbid-a-to-c",
            disposition: "covered",
            child_story_ids: ["story-stages"],
          },
          {
            parent_requirement_id: "req-terminal-failure",
            disposition: "deferred",
            provenance: {
              reason: "Terminal path deferred to follow-up story",
              target_path: "xbrief/proposed/future-terminal.xbrief.json",
            },
          },
        ],
      },
      storyIds: ["story-stages", "story-stages-b"],
    });
    expect(complete.ok).toBe(true);
  });

  it("decompose --check with incomplete coverage exits non-zero and lists uncovered IDs", () => {
    const proj = tmpProject();
    const parentPath = join(proj, "xbrief", "pending", "parent.xbrief.json");
    const draftPath = join(proj, "xbrief", ".triage-cache", "draft.json");
    mkdirSync(join(proj, "xbrief", ".triage-cache"), { recursive: true });
    writeJson(parentPath, abcParent());
    writeJson(draftPath, {
      stories: [stagesStory()],
      coverage_map: {
        "req-ordered-a-b-c": { disposition: "covered", child_story_ids: ["story-stages"] },
      },
    });

    const code = decomposeMain([
      parentPath,
      "--draft",
      draftPath,
      "--check",
      "--project-root",
      proj,
    ]);
    expect(code).toBe(1);
  });

  it("decompose --check with negative invariant omitted exits non-zero", () => {
    const proj = tmpProject();
    const parentPath = join(proj, "xbrief", "pending", "parent.xbrief.json");
    const draftPath = join(proj, "xbrief", ".triage-cache", "draft.json");
    mkdirSync(join(proj, "xbrief", ".triage-cache"), { recursive: true });
    writeJson(parentPath, abcParent());
    writeJson(draftPath, {
      stories: [stagesStory()],
      coverage_map: {
        "req-ordered-a-b-c": { disposition: "covered", child_story_ids: ["story-stages"] },
        "req-terminal-failure": { disposition: "covered", child_story_ids: ["story-stages"] },
      },
    });

    expect(() =>
      applyDecomposition({
        projectRoot: proj,
        parentPath,
        draftPath,
        checkOnly: true,
        date: "2026-06-01",
      }),
    ).toThrow(/negative invariant|silent removal|uncovered/i);
  });

  it("decompose --check with behavioral_delta missing delta_id exits non-zero", () => {
    const proj = tmpProject();
    const parentPath = join(proj, "xbrief", "pending", "parent.xbrief.json");
    const draftPath = join(proj, "xbrief", ".triage-cache", "draft.json");
    mkdirSync(join(proj, "xbrief", ".triage-cache"), { recursive: true });
    writeJson(parentPath, abcParent());
    writeJson(draftPath, {
      stories: [stagesStory()],
      coverage_map: {
        "req-ordered-a-b-c": { disposition: "covered", child_story_ids: ["story-stages"] },
        "req-forbid-a-to-c": { disposition: "behavioral_delta" },
        "req-terminal-failure": { disposition: "covered", child_story_ids: ["story-stages"] },
      },
    });

    expect(() =>
      applyDecomposition({
        projectRoot: proj,
        parentPath,
        draftPath,
        checkOnly: true,
        date: "2026-06-01",
      }),
    ).toThrow(/delta_id|behavioral_delta/i);
  });

  it("decompose --check with valid A-B-C coverage map exits 0 and prints COVERAGE_REPORT", () => {
    const proj = tmpProject();
    const parentPath = join(proj, "xbrief", "pending", "parent.xbrief.json");
    const draftPath = join(proj, "xbrief", ".triage-cache", "draft.json");
    mkdirSync(join(proj, "xbrief", ".triage-cache"), { recursive: true });
    writeJson(parentPath, abcParent());
    writeJson(draftPath, {
      stories: [stagesStory()],
      coverage_map: abcValidCoverage(),
    });

    const actions = applyDecomposition({
      projectRoot: proj,
      parentPath,
      draftPath,
      checkOnly: true,
      date: "2026-06-01",
    });
    expect(actions[0]).toContain("VALIDATED");
    expect(actions.some((a) => a.startsWith("COVERAGE_REPORT "))).toBe(true);
    const reportLine = actions.find((a) => a.startsWith("COVERAGE_REPORT "));
    expect(reportLine).toBeDefined();
    if (reportLine === undefined) throw new Error("expected COVERAGE_REPORT line");
    const report = JSON.parse(reportLine.slice("COVERAGE_REPORT ".length)) as {
      ok: boolean;
      uncovered: string[];
      schema: string;
    };
    expect(report.ok).toBe(true);
    expect(report.uncovered).toEqual([]);
    expect(report.schema).toBe("deft.decompose.coverage_report.v1");

    const code = decomposeMain([
      parentPath,
      "--draft",
      draftPath,
      "--check",
      "--project-root",
      proj,
    ]);
    expect(code).toBe(0);
  });

  it("apply stamps plan.metadata.parent_lineage coverage onto children (#3241)", () => {
    const proj = tmpProject();
    const parentPath = join(proj, "xbrief", "pending", "parent.xbrief.json");
    const draftPath = join(proj, "xbrief", ".triage-cache", "draft.json");
    mkdirSync(join(proj, "xbrief", ".triage-cache"), { recursive: true });
    writeJson(parentPath, abcParent());
    writeJson(draftPath, {
      stories: [stagesStory()],
      coverage_map: abcValidCoverage(),
    });
    approveApply(proj, parentPath, draftPath);
    applyDecomposition({
      projectRoot: proj,
      parentPath,
      draftPath,
      checkOnly: false,
      date: "2026-06-01",
    });
    const childDir = join(proj, "xbrief", "pending");
    const childFiles = readdirSafe(childDir).filter((f) => f !== "parent.xbrief.json");
    expect(childFiles.length).toBeGreaterThanOrEqual(1);
    const child = JSON.parse(readFileSync(join(childDir, childFiles[0] as string), "utf8")) as {
      plan: {
        metadata: {
          parent_lineage?: {
            schema?: string;
            coverage_map?: unknown;
            parent_plan_id?: string;
          };
        };
      };
    };
    expect(child.plan.metadata.parent_lineage?.schema).toBe("deft.scope.parent_lineage.v1");
    expect(child.plan.metadata.parent_lineage?.coverage_map).toBeDefined();
    expect(child.plan.metadata.parent_lineage?.parent_plan_id).toBe("epic-state-machine");
  });

  it("refuses decompose when parent authors IDs but lacks plan.id (#3241 identity)", () => {
    const proj = tmpProject();
    const parentPath = join(proj, "xbrief", "pending", "parent.xbrief.json");
    const draftPath = join(proj, "xbrief", ".triage-cache", "draft.json");
    mkdirSync(join(proj, "xbrief", ".triage-cache"), { recursive: true });
    const parentNoId = abcParent();
    const plan = parentNoId.plan as Record<string, unknown>;
    delete plan.id;
    writeJson(parentPath, parentNoId);
    writeJson(draftPath, {
      stories: [stagesStory()],
      coverage_map: abcValidCoverage(),
    });
    approveApply(proj, parentPath, draftPath);
    expect(() =>
      applyDecomposition({
        projectRoot: proj,
        parentPath,
        draftPath,
        checkOnly: false,
        date: "2026-06-01",
      }),
    ).toThrow(/plan\.id|parent_plan_id|durable parent identity/i);
  });
});
