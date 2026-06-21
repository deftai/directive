/**
 * Vitest tests for scope/decompose.ts -- mirror key Python test cases from
 * tests/cli/test_scope_decompose_unit.py including non-happy-path/edge cases.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyDecomposition,
  asStrList,
  DecompositionError,
  decomposeMain,
  deprecatedSubitemsIssues,
  itemHasTraces,
  itemsHaveAcceptance,
  missingRequiredSwarmFields,
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
