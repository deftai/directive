import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  alignSpecNarratives,
  buildEdgesFromTasks,
  buildRequirementsNarrative,
  ingestSpecNarratives,
  mapSpecStatus,
  parseRequirementDefinitions,
  parseSpecTasks,
} from "./fidelity.js";
import {
  lookupCanonical,
  normalizeTitle,
  parseTopLevelSections,
  partitionSections,
  SPEC_KNOWN_MAPPINGS,
} from "./legacy-sections.js";
import { run } from "./main.js";
import {
  dirtyTreeRefusalMessage,
  isTreeDirty,
  loadSafetyManifest,
  planBackups,
  premigrateSibling,
  rollback,
  SafetyManifest,
  sha256Of,
  writeSafetyManifest,
} from "./safety.js";
import {
  deprecatedSubitemsIssues,
  itemHasTraces,
  missingRequiredSwarmFields,
  storyQualityIssues,
} from "./story-quality.js";
import {
  finalizeMigration,
  isolateInvalidOutput,
  slugFallbackId,
  slugifyId,
  validateMigrationOutput,
} from "./validation.js";

describe("vbrief-validation module branch coverage", () => {
  it("covers validation slug and path branches", () => {
    expect(slugifyId("standalone-slug")).toBe("standalone-slug");
    expect(slugFallbackId({ synthetic_id: "syn-1", title: "Title" })).toBe("syn-1");
    expect(slugFallbackId({ title: "Only title" })).toBe("Only title");

    const root = mkdtempSync(join(tmpdir(), "vb-val-br-"));
    const filePath = join(root, "not-a-dir");
    writeFileSync(filePath, "x", "utf8");
    const [fileErrors] = validateMigrationOutput(filePath);
    expect(fileErrors[0]).toContain("expected vbrief directory does not exist");

    mkdirSync(join(root, "vbrief"), { recursive: true });
    writeFileSync(join(root, "vbrief.invalid"), "old", "utf8");
    const isolated = isolateInvalidOutput(root, join(root, "vbrief"));
    expect(isolated).toContain("vbrief.invalid.2");

    mkdirSync(join(root, "vbrief.invalid.2"), { recursive: true });
    writeFileSync(
      join(root, "vbrief.invalid.2", "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({ vBRIEFInfo: { version: "0.6" }, plan: {} }),
      "utf8",
    );
    const stderr: string[] = [];
    const [ok] = finalizeMigration(root, join(root, "vbrief.invalid.2"), ["seed"], {
      stderrWriter: (chunk) => stderr.push(chunk),
      isolateInvalid: () => null,
    });
    expect(ok).toBe(false);
    expect(stderr.join("")).not.toContain("Isolated partial output");
    rmSync(root, { recursive: true, force: true });
  });

  it("covers legacy section merge and normalize branches", () => {
    expect(normalizeTitle("Problem_Statement")).toBe("problem statement");
    expect(lookupCanonical("Unknown Section", SPEC_KNOWN_MAPPINGS)).toBeNull();
    const sections = parseTopLevelSections(
      "Preamble\n\n## Goals\n\nFirst.\n\n## goals\n\nSecond.\n",
    );
    const [canonical, legacy] = partitionSections(sections, SPEC_KNOWN_MAPPINGS);
    expect(canonical.Goals).toContain("First.");
    expect(canonical.Goals).toContain("Second.");
    expect(legacy).toHaveLength(0);
  });

  it("covers safety planning and rollback edge branches", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-safety-mod-"));
    writeFileSync(join(root, "README"), "no extension", "utf8");
    expect(premigrateSibling(join(root, "README"))).toContain(".premigrate");

    writeFileSync(join(root, "SPECIFICATION.md"), "<!-- deft:deprecated-redirect -->\n", "utf8");
    mkdirSync(join(root, "vbrief"), { recursive: true });
    writeFileSync(join(root, "vbrief", "specification.vbrief.json"), "{}", "utf8");
    expect(planBackups(root).some(([src]) => src.endsWith("specification.vbrief.json"))).toBe(true);
    expect(planBackups(root).some(([src]) => src.endsWith("SPECIFICATION.md"))).toBe(false);

    expect(sha256Of(join(root, "missing.txt"))).toBe("");
    expect(loadSafetyManifest(root)).toBeNull();

    writeFileSync(join(root, ".gitignore"), "unchanged\n", "utf8");
    const preHash = sha256Of(join(root, ".gitignore"));
    const manifest = SafetyManifest.fromJson(
      JSON.stringify({
        version: "1",
        migration_timestamp: "2026-01-01T00:00:00Z",
        backups: [],
        created_files: [],
        created_dirs: ["non-empty-dir"],
        file_modifications: [
          {
            path: ".gitignore",
            operation: "append",
            pre_hash: preHash,
            post_hash: "1".repeat(64),
            appended_content: "never\n",
          },
        ],
      }),
    );
    mkdirSync(join(root, "non-empty-dir"), { recursive: true });
    writeFileSync(join(root, "non-empty-dir", "child.txt"), "x", "utf8");
    writeSafetyManifest(root, manifest, { dryRun: false });

    const [ok, actions] = rollback(root, { force: true, confirmFn: () => true });
    expect(ok).toBe(true);
    expect(actions.some((a) => a.includes("already at pre-migration hash"))).toBe(true);
    expect(actions.some((a) => a.includes("not empty"))).toBe(true);
    expect(dirtyTreeRefusalMessage()).toContain("Working tree is not clean");

    execSync("git init", { cwd: root, stdio: "ignore" });
    writeFileSync(join(root, "dirty.txt"), "x", "utf8");
    expect(isTreeDirty(root)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("covers validateAll migration branches and slugify collision", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-bridge-"));
    mkdirSync(join(root, "vbrief"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({
        vBRIEFInfo: { version: "0.6" },
        plan: {
          title: "PROJECT-DEFINITION",
          status: "running",
          narratives: { Overview: "Test overview narrative.", "tech stack": "Python 3.12" },
          items: [],
        },
      }),
      "utf8",
    );
    const [errors, warnings] = validateMigrationOutput(join(root, "vbrief"));
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);

    const existing = new Set<string>(["hello"]);
    expect(slugifyId("hello", existing)).toMatch(/^hello-[0-9a-f]{6}$/);
    rmSync(root, { recursive: true, force: true });
  });

  it("covers fidelity parser and align branches", () => {
    expect(mapSpecStatus("unknown-status")).toBe("pending");
    expect(buildRequirementsNarrative({})).toBe("");
    expect(parseRequirementDefinitions("## Requirements\n\n- FR-1: First req\n")).toEqual({
      "FR-1": "First req",
    });
    expect(
      parseRequirementDefinitions("## Non Functional Requirements\n\n- NFR-2: Second req\n"),
    ).toEqual({ "NFR-2": "Second req" });
    const taskMd =
      "#### t1.2.3 -- Widget title [done]\n\n" +
      "Depends on: t1.1.1, bad id\n\n" +
      "**Traces**: FR-1, NFR-2\n\n" +
      "**Acceptance criteria**\n\n" +
      "- saves state\n\n" +
      "Body paragraph.\n\n" +
      "## End section\n";
    const tasks = parseSpecTasks(taskMd);
    expect(tasks[0]?.status).toBe("completed");
    expect(tasks[0]?.acceptance).toEqual(["saves state"]);
    expect(tasks[0]?.traces).toEqual(["FR-1", "NFR-2"]);
    expect(
      buildEdgesFromTasks([
        { task_id: "t1.2.3", depends_on: ["t1.1.1", "t1.2.3", "bad id"] },
        { task_id: "t1.2.3", depends_on: ["t1.1.1"] },
      ]),
    ).toHaveLength(1);
    expect(alignSpecNarratives({ Overview: "a", summary: "b", count: 3 }).Overview).toContain("a");
    const [, logs] = ingestSpecNarratives("## Legacy\n\nx\n", "CUSTOM.md");
    expect(logs[0]?.source).toBe("CUSTOM.md");
    expect(run(["--fixture-root", "/tmp", "--scenario", "slugify-basic"])).toBe(0);
    expect(run([])).toBe(2);
  });

  it("covers story-quality generic verify and description duplicate acceptance", () => {
    const base = {
      title: "Auth model",
      description:
        "Auth model persistence stores user identity and session state. The story covers focused model changes plus matching unit tests for save and load behavior.",
      implementationPlan:
        "- Update the src/auth model persistence code so valid payloads are saved through the model boundary.\n" +
        "- Add focused tests for successful persistence and a missing-record fixture in tests/auth/model.",
      userStory:
        "As an auth maintainer, I want persisted user records, so that login state survives requests.",
      acceptanceTexts: [
        "Auth model",
        "Given an existing user, when the auth model loads it, then the saved identity returns.",
      ],
      acceptanceCountJustification: "",
      swarm: {
        file_scope: ["src/auth/model.ts"],
        verify_commands: ["task check"],
        expected_outputs: ["ok"],
        depends_on: [],
        conflict_group: "auth",
        size: "M",
        file_scope_confidence: "high",
        model_tier: "medium",
        parallel_safe: true,
      },
    };
    const issues = storyQualityIssues(base);
    expect(issues.some((i) => i.includes("generic verify command"))).toBe(true);
    expect(issues.some((i) => i.includes("duplicates title or description"))).toBe(true);
  });

  it("covers story-quality and safety residual branches", () => {
    expect(
      storyQualityIssues({
        title: "Widget",
        description: "First sentence here. Second sentence with enough words to pass.",
        implementationPlan:
          "- Update src/widget.ts so the handler persists records.\n- Add tests/widget.test.ts fixtures to verify save behavior.",
        userStory: "Bad user story format",
        acceptanceTexts: ["Shows a message only", "Given valid input, when saved, then persists."],
        acceptanceCountJustification: "",
        swarm: {
          file_scope: ["frontend/*", "docs", "src/**/x.ts"],
          verify_commands: ["npm test -- x", "task check"],
          expected_outputs: ["ok"],
          depends_on: [],
          conflict_group: "g",
          size: "S",
          file_scope_confidence: "high",
          model_tier: "low",
          parallel_safe: true,
        },
      }).some((i) => i.includes("UserStory must match")),
    ).toBe(true);

    const root = mkdtempSync(join(tmpdir(), "vb-safety-residual-"));
    const [noManifestOk, noManifestLines] = rollback(root);
    expect(noManifestOk).toBe(false);
    expect(noManifestLines[0]).toContain("No safety manifest found");

    writeSafetyManifest(
      root,
      new SafetyManifest({
        backups: [
          {
            source: "A.md",
            backup: "A.premigrate.md",
            source_sha256: "abc",
            size_bytes: 1,
          },
        ],
        created_files: ["gone.txt"],
        renames: [
          { original: "gone.txt", current: "renamed.txt", renamed_by: "x", renamed_at: "t" },
        ],
      }),
      { dryRun: false },
    );
    writeFileSync(join(root, "A.premigrate.md"), "orig", "utf8");
    const [ok, actions] = rollback(root, { force: true, confirmFn: () => true });
    expect(ok).toBe(true);
    expect(actions.some((a) => a.includes("already absent; renamed from gone.txt"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("covers remaining parser and main branches", () => {
    const noneDeps = parseSpecTasks("### t1.1.1 -- Title\n\nDepends on: none\n\nBody text.\n");
    expect(noneDeps[0]?.depends_on).toEqual([]);
    expect(run(["--scenario"])).toBe(2);
    expect(
      new SafetyManifest({
        renames: [
          { original: "a.txt", current: "b.txt", renamed_by: "s1", renamed_at: "t1" },
          { original: "b.txt", current: "c.txt", renamed_by: "s2", renamed_at: "t2" },
        ],
      }).currentPathFor("a.txt"),
    ).toBe("c.txt");
    expect(normalizeTitle(undefined as unknown as string)).toBe("");
    expect(
      storyQualityIssues({
        title: "Widget",
        description: "First sentence here. Second sentence with enough words to pass.",
        implementationPlan:
          "1. Update src/widget.ts so the handler persists records.\n2. Add tests/widget.test.ts fixtures to verify save behavior.",
        userStory: "As a user, I want widgets, so that I can see them.",
        acceptanceTexts: [
          "No observable verbs here at all",
          "Given valid input, when saved, then persists.",
        ],
        acceptanceCountJustification: "",
        swarm: {
          file_scope: ["vbrief/*"],
          verify_commands: ["npm test -- x", "task check"],
          expected_outputs: ["ok"],
          depends_on: [],
          conflict_group: "g",
          size: "S",
          file_scope_confidence: "high",
          model_tier: "low",
          parallel_safe: true,
        },
      }).some((i) => i.includes("observable behavior")),
    ).toBe(true);
  });

  it("covers slug truncation, spec bullets, backups, and narrative sort", () => {
    const longSlug = `${"widget-".repeat(20)}end`;
    expect(slugifyId(longSlug).length).toBeLessThanOrEqual(80);
    expect(slugifyId(longSlug).endsWith("-")).toBe(false);

    expect(buildRequirementsNarrative({ "NFR-1": "n", "FR-2": "f" }).indexOf("FR-2")).toBeLessThan(
      buildRequirementsNarrative({ "NFR-1": "n", "FR-2": "f" }).indexOf("NFR-1"),
    );

    const root = mkdtempSync(join(tmpdir(), "vb-plan-md-"));
    writeFileSync(join(root, "ROADMAP.md"), "# Roadmap\n", "utf8");
    expect(planBackups(root).some(([src]) => src.endsWith("ROADMAP.md"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("covers safety load failures and rollback append drift", () => {
    const loadRoot = mkdtempSync(join(tmpdir(), "vb-safety-load-"));
    mkdirSync(join(loadRoot, "vbrief", "migration"), { recursive: true });
    mkdirSync(join(loadRoot, "vbrief", "migration", "safety-manifest.json"));
    expect(loadSafetyManifest(loadRoot)).toBeNull();
    rmSync(loadRoot, { recursive: true, force: true });

    const root = mkdtempSync(join(tmpdir(), "vb-safety-drift-"));
    const target = join(root, "TRACK.md");
    writeFileSync(target, "different content\n", "utf8");
    writeSafetyManifest(
      root,
      new SafetyManifest({
        backups: [],
        file_modifications: [
          {
            path: "TRACK.md",
            operation: "append",
            pre_hash: "0".repeat(64),
            post_hash: sha256Of(target),
            appended_content: "appended\n",
          },
        ],
      }),
      { dryRun: false },
    );
    const [ok, actions] = rollback(root, { force: true, confirmFn: () => true });
    expect(ok).toBe(true);
    expect(actions.some((a) => a.includes("cannot strip append cleanly"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("covers story-quality swarm field gaps and deprecated nesting", () => {
    expect(
      missingRequiredSwarmFields({
        file_scope: ["a"],
        verify_commands: ["b"],
        expected_outputs: ["c"],
      }),
    ).toContain("plan.metadata.swarm.depends_on");
    expect(deprecatedSubitemsIssues([{ subItems: [] }])).toEqual([
      "plan.items[0].subItems is deprecated; use items",
    ]);
    expect(
      storyQualityIssues({
        title: "Widget",
        description: "First sentence here. Second sentence with enough words to pass.",
        implementationPlan:
          "- Update src/widget.ts so the handler persists records.\n- Add tests/widget.test.ts fixtures to verify save behavior.",
        userStory: "As a user, I want widgets, so that I can see them.",
        acceptanceTexts: [
          "Given valid input, when saved, then persists.",
          "Given invalid input, when rejected, then fails.",
        ],
        acceptanceCountJustification: "",
        swarm: {
          file_scope: ["backend"],
          verify_commands: ["npm test -- x", "task check"],
          expected_outputs: ["ok"],
          depends_on: [],
          conflict_group: "g",
          size: "S",
          file_scope_confidence: "high",
          model_tier: "low",
          parallel_safe: true,
        },
      }).some((i) => i.includes("broad file_scope")),
    ).toBe(true);
  });

  it("covers fidelity status defaults and main fixture-root flag", () => {
    expect(mapSpecStatus(null)).toBe("pending");
    expect(mapSpecStatus("")).toBe("pending");
    const root = mkdtempSync(join(tmpdir(), "vb-main-fixture-"));
    try {
      mkdirSync(join(root, "vbrief"), { recursive: true });
      writeFileSync(
        join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json"),
        JSON.stringify({
          vBRIEFInfo: { version: "0.6" },
          plan: {
            title: "PROJECT-DEFINITION",
            status: "running",
            narratives: { Overview: "Test overview narrative.", "tech stack": "Python 3.12" },
            items: [],
          },
        }),
        "utf8",
      );
      expect(run(["--all", "--fixture-root", root])).toBe(0);
      expect(run(["--fixture-root"])).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("covers nested trace detection and slug fallback ordering", () => {
    expect(itemHasTraces({ subItems: [{ narrative: { Traces: "FR-9" } }] })).toBe(true);
    expect(slugFallbackId({ task_id: "t1.1.1", synthetic_id: "syn" })).toBe("t1.1.1");
    const [missingErrors] = validateMigrationOutput("/path/that/does/not/exist/vbrief");
    expect(missingErrors[0]).toContain("does not exist");
    expect(
      storyQualityIssues({
        title: "Widget",
        description: "First sentence here. Second sentence with enough words to pass.",
        implementationPlan:
          "- Update src/widget.ts so the handler persists records.\n- Add tests/widget.test.ts fixtures to verify save behavior.",
        userStory: "As a user, I want widgets, so that I can see them.",
        acceptanceTexts: [
          "Given valid input, when saved, then persists.",
          "Given invalid input, when rejected, then fails.",
        ],
        acceptanceCountJustification: "",
        swarm: {
          file_scope: ["docs/"],
          verify_commands: ["npm test -- x", "task check"],
          expected_outputs: ["ok"],
          depends_on: [],
          conflict_group: "g",
          size: "S",
          file_scope_confidence: "high",
          model_tier: "low",
          parallel_safe: true,
        },
      }).some((i) => i.includes("broad file_scope")),
    ).toBe(true);
  });

  it("rollback skips create operations when files are already absent", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-safety-create-"));
    writeSafetyManifest(
      root,
      new SafetyManifest({
        backups: [],
        file_modifications: [
          {
            path: "CREATED.txt",
            operation: "create",
            pre_hash: "",
            post_hash: "abc",
            appended_content: "",
          },
        ],
      }),
      { dryRun: false },
    );
    const [ok, actions] = rollback(root, { force: true, confirmFn: () => true });
    expect(ok).toBe(true);
    expect(actions.some((a) => a.includes("CREATED.txt (already absent)"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
