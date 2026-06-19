import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pythonJsonPretty } from "../vbrief-build/json.js";
import {
  alignSpecNarratives,
  buildEdgesFromTasks,
  buildRequirementsNarrative,
  formatMigrationLogEntry,
  ingestSpecNarratives,
  mapSpecStatus,
  parseRequirementDefinitions,
  parseSpecTasks,
  taskScopeNarratives,
} from "./fidelity.js";
import {
  lookupCanonical,
  normalizeTitle,
  parseTopLevelSections,
  partitionSections,
  SPEC_KNOWN_MAPPINGS,
} from "./legacy-sections.js";
import {
  normalizeFixturePaths,
  sortedDiagnostics,
  sortFailureActions,
  sortFailureStderr,
} from "./normalize.js";
import {
  dirtyTreeRefusalMessage,
  isTreeDirty,
  planBackups,
  premigrateSibling,
  SafetyManifest,
  sha256Of,
  writeBackups,
} from "./safety.js";
import { storyQualityIssues } from "./story-quality.js";
import {
  finalizeMigration,
  HASH_SUFFIX_LENGTH,
  ID_MAX_LENGTH,
  isolateInvalidOutput,
  RECOVERY_HINT,
  slugFallbackId,
  slugifyId,
  validateMigrationOutput,
} from "./validation.js";

export interface ParityScenarioContext {
  readonly fixtureRoot: string;
}

export interface ParityScenarioResult {
  readonly scenario: string;
  readonly ok: boolean;
  readonly payload: unknown;
}

const SAMPLE_SPEC_TASKS = `## Overview

Intro.

### t1.1.1 -- Widget support [done]

Build the widget layer.

Depends on: t1.0.1, t1.0.2

**Traces**: FR-1, NFR-2

Acceptance criteria:

- Given a user, when they open the widget, then it renders.

- The widget persists state across reloads.

## Requirements

FR-1: Users can open widgets.
NFR-2: Widget state persists.
`;

const STORY_QUALITY_BASE = {
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
    expected_outputs: ["Updated auth model tests pass"],
    depends_on: [],
    conflict_group: "auth",
    size: "M",
    file_scope_confidence: "high",
    model_tier: "medium",
    parallel_safe: true,
  },
  concurrentReady: true,
};

// Edge-case batteries that stress the ReDoS-free regex rewrites (task headings,
// Depends/Traces/Acceptance lines, h2 heading parsing, slug edge strips, and the
// user-story template). Kept byte-identical to the Python driver so the harness
// proves equivalence on inputs the base fixtures do not reach (#1782 s2).
const EDGE_SPEC = `### t1.1.1 -- Title A [done]

Body line.

Depends on: t1.0.1, t1.0.2

**Traces**: FR-1, NFR-2

Acceptance criteria:

- crit one

#### \`t2.2\` Backtick title

**Depends on** : none

Traces: FR-9

Acceptance:

- crit two

### t3.3.3: colon title [pending]

Dependson: t1.0.1

##### t6.6.6 five hashes not a task

### t4.4.4    spaced   [wip]

### t5.5.5 title with [notend] tail
`;

const EDGE_HEADINGS = `## Title one  

body1

##   Spaced Title   

body2

## 

still body

### h3 not top

## Final

last
`;

const EDGE_SLUGS = [
  "---Hello---World---",
  "!!!",
  "  spaced  ",
  "Mix-Of_Things 42",
  `${"a".repeat(90)}----`,
];

const EDGE_STORIES = [
  "As  a   maintainer ,  I want   x , so   that   y .",
  "As an engineer, I want feature, so that benefit.",
  "as a x, i want y, so that z.",
  "As a role, I want cap, so that out",
  "As a, I want y, so that z.",
  "As a role, I want cap, so that done.",
  // multi-line via DOTALL (\n inside the want/so-that clauses)
  "As a dev, I want\nmulti line, so that\noutcome.\n",
  // extra internal commas in both clauses
  "As a dev, I want a, b, c, so that x, y, z.",
  // multiple spaces after As a / want / that
  "As a   role,   I   want   cap,   so   that   out.",
  // leading whitespace + trailing newline
  "   As a role, I want cap, so that out.  \n",
  // invalid: missing trailing period
  "As a role, I want cap, so that out",
  // invalid: missing the so-that clause
  "As a role, I want cap.",
  // invalid: missing the want clause
  "As a role, so that out.",
  // invalid: wrong clause order
  "I want cap, As a role, so that out.",
  // invalid: "As a" not followed by whitespace (role glued on)
  "As animal, I want cap, so that out.",
  // invalid: empty capability before the comma
  "As a role, I want , so that out.",
  // invalid: empty outcome before the period
  "As a role, I want cap, so that .",
  // valid: period inside the outcome, real terminator at end
  "As a role, I want cap, so that v1.2 ships.",
  // invalid: trailing non-space after the terminating period
  "As a role, I want cap, so that out.x",
];

function writeValidProjectDefinition(vbriefDir: string): void {
  const data = {
    vBRIEFInfo: { version: "0.6" },
    plan: {
      title: "PROJECT-DEFINITION",
      status: "running",
      narratives: {
        Overview: "Test overview narrative.",
        "tech stack": "Python 3.12",
      },
      items: [],
    },
  };
  writeFileSync(join(vbriefDir, "PROJECT-DEFINITION.vbrief.json"), JSON.stringify(data), "utf8");
}

/** Execute a named parity scenario and return structured payload. */
export function runParityScenario(name: string, ctx: ParityScenarioContext): ParityScenarioResult {
  switch (name) {
    case "slugify-basic":
      return {
        scenario: name,
        ok: true,
        payload: {
          hello: slugifyId("Hello World"),
          special: slugifyId("Add widget (v2)!"),
          untitled: slugifyId(""),
          constants: { ID_MAX_LENGTH, HASH_SUFFIX_LENGTH, RECOVERY_HINT },
        },
      };
    case "slugify-collision": {
      const existing = new Set<string>(["hello"]);
      const first = slugifyId("hello world", existing);
      const second = slugifyId("hello world", existing);
      return {
        scenario: name,
        ok: true,
        payload: { first, second, size: existing.size },
      };
    }
    case "slug-fallback-id":
      return {
        scenario: name,
        ok: true,
        payload: {
          number: slugFallbackId({ number: "42", task_id: "1.1", title: "foo" }),
          taskId: slugFallbackId({ number: "", task_id: "1.1.2", title: "foo" }),
          synthetic: slugFallbackId({
            number: "",
            task_id: "",
            synthetic_id: "roadmap-3",
            title: "foo",
          }),
          title: slugFallbackId({ title: "Fix login bug" }),
          untitled: slugFallbackId({}),
        },
      };
    case "validate-migration-missing-dir": {
      const missing = join(ctx.fixtureRoot, "nonexistent");
      const [errors, warnings] = validateMigrationOutput(missing);
      return {
        scenario: name,
        ok: true,
        payload: sortedDiagnostics(errors, warnings),
      };
    }
    case "validate-migration-empty-dir": {
      const vbrief = join(ctx.fixtureRoot, "vbrief");
      mkdirSync(vbrief, { recursive: true });
      const [errors, warnings] = validateMigrationOutput(vbrief);
      return { scenario: name, ok: true, payload: sortedDiagnostics(errors, warnings) };
    }
    case "validate-migration-valid-pd": {
      const vbrief = join(ctx.fixtureRoot, "vbrief-valid");
      mkdirSync(vbrief, { recursive: true });
      writeValidProjectDefinition(vbrief);
      const [errors, warnings] = validateMigrationOutput(vbrief);
      return { scenario: name, ok: true, payload: sortedDiagnostics(errors, warnings) };
    }
    case "validate-migration-invalid-status": {
      const vbrief = join(ctx.fixtureRoot, "vbrief-bad");
      mkdirSync(vbrief, { recursive: true });
      writeFileSync(
        join(vbrief, "PROJECT-DEFINITION.vbrief.json"),
        JSON.stringify({
          vBRIEFInfo: { version: "0.6" },
          plan: { title: "Bad", status: "in_progress", items: [] },
        }),
        "utf8",
      );
      const [errors, warnings] = validateMigrationOutput(vbrief);
      return { scenario: name, ok: true, payload: sortedDiagnostics(errors, warnings) };
    }
    case "isolate-invalid-output": {
      const projectRoot = join(ctx.fixtureRoot, "isolate");
      mkdirSync(projectRoot, { recursive: true });
      const vbrief = join(projectRoot, "vbrief");
      mkdirSync(vbrief, { recursive: true });
      writeFileSync(join(vbrief, "sentinel.txt"), "marker", "utf8");
      mkdirSync(join(projectRoot, "vbrief.invalid"), { recursive: true });
      mkdirSync(join(projectRoot, "vbrief.invalid.2"), { recursive: true });
      const target = isolateInvalidOutput(projectRoot, vbrief);
      return {
        scenario: name,
        ok: true,
        payload: {
          target: target?.split("\\").join("/").replace(ctx.fixtureRoot, "<FIXTURE>") ?? null,
          sentinel: readFileSync(join(projectRoot, "vbrief.invalid.3", "sentinel.txt"), "utf8"),
        },
      };
    }
    case "finalize-migration-success": {
      const projectRoot = join(ctx.fixtureRoot, "finalize-ok");
      const vbrief = join(projectRoot, "vbrief");
      mkdirSync(vbrief, { recursive: true });
      writeValidProjectDefinition(vbrief);
      const stderr: string[] = [];
      const [ok, actions] = finalizeMigration(projectRoot, vbrief, ["CREATE ok"], {
        stderrWriter: (chunk) => stderr.push(chunk),
      });
      return { scenario: name, ok: true, payload: { ok, actions, stderr: stderr.join("") } };
    }
    case "finalize-migration-failure": {
      const projectRoot = join(ctx.fixtureRoot, "finalize-fail");
      const vbrief = join(projectRoot, "vbrief");
      mkdirSync(vbrief, { recursive: true });
      writeFileSync(
        join(vbrief, "PROJECT-DEFINITION.vbrief.json"),
        JSON.stringify({ vBRIEFInfo: { version: "0.6" }, plan: {} }),
        "utf8",
      );
      const stderr: string[] = [];
      const [ok, actions] = finalizeMigration(projectRoot, vbrief, ["CREATE bad"], {
        stderrWriter: (chunk) => stderr.push(chunk),
      });
      return {
        scenario: name,
        ok: true,
        payload: {
          ok,
          actions: sortFailureActions(actions),
          stderr: sortFailureStderr(stderr.join("")),
        },
      };
    }
    case "legacy-normalize-title":
      return {
        scenario: name,
        ok: true,
        payload: {
          techStack: normalizeTitle("Tech Stack"),
          camel: normalizeTitle("ProblemStatement"),
          trailingNewline: normalizeTitle("Branching Strategy\n"),
          empty: normalizeTitle(""),
        },
      };
    case "legacy-lookup-canonical":
      return {
        scenario: name,
        ok: true,
        payload: {
          overview: lookupCanonical("Summary", SPEC_KNOWN_MAPPINGS),
          unknown: lookupCanonical("Mystery Section", SPEC_KNOWN_MAPPINGS),
        },
      };
    case "legacy-parse-sections": {
      const content =
        "## Overview\n\nAn overview.\n\n### Sub-section\n\ninside overview\n\n## Goals\n\nSome goals.\n";
      const sections = parseTopLevelSections(content);
      return {
        scenario: name,
        ok: true,
        payload: {
          count: sections.length,
          firstTitle: sections[0]?.[0],
          hasSubsection: sections[0]?.[1].includes("### Sub-section"),
          trailingEmpty: parseTopLevelSections("## Only\n\nBody\n"),
        },
      };
    }
    case "legacy-partition-sections": {
      const sections = parseTopLevelSections(
        "## Summary\n\nOverview body.\n\n## Mystery\n\nLegacy body.\n",
      );
      const [canonical, legacy] = partitionSections(sections, SPEC_KNOWN_MAPPINGS);
      return { scenario: name, ok: true, payload: { canonical, legacyCount: legacy.length } };
    }
    case "fidelity-map-spec-status":
      return {
        scenario: name,
        ok: true,
        payload: {
          done: mapSpecStatus("done"),
          unknown: mapSpecStatus("weird"),
          empty: mapSpecStatus(""),
          trailing: mapSpecStatus("completed\n"),
        },
      };
    case "fidelity-parse-spec-tasks": {
      const tasks = parseSpecTasks(SAMPLE_SPEC_TASKS);
      return {
        scenario: name,
        ok: true,
        payload: {
          tasks,
          empty: parseSpecTasks(""),
          trailingNewline: parseSpecTasks(`${SAMPLE_SPEC_TASKS}\n`),
        },
      };
    }
    case "fidelity-requirements":
      return {
        scenario: name,
        ok: true,
        payload: {
          requirements: parseRequirementDefinitions(SAMPLE_SPEC_TASKS),
          narrative: buildRequirementsNarrative(parseRequirementDefinitions(SAMPLE_SPEC_TASKS)),
          empty: buildRequirementsNarrative({}),
        },
      };
    case "fidelity-edges-and-narratives": {
      const tasks = parseSpecTasks(SAMPLE_SPEC_TASKS);
      return {
        scenario: name,
        ok: true,
        payload: {
          edges: buildEdgesFromTasks(tasks),
          scope: taskScopeNarratives(tasks[0] ?? {}),
          aligned: alignSpecNarratives({ "tech stack": "Rust", Overview: "Hi" }),
        },
      };
    }
    case "fidelity-ingest-spec": {
      const [canonical, logEntries, legacy] = ingestSpecNarratives(SAMPLE_SPEC_TASKS);
      return {
        scenario: name,
        ok: true,
        payload: {
          canonicalKeys: Object.keys(canonical),
          firstLog: logEntries[0] ? formatMigrationLogEntry(logEntries[0]) : null,
          legacyCount: legacy.length,
        },
      };
    }
    case "story-quality-happy":
      return {
        scenario: name,
        ok: true,
        payload: { issues: storyQualityIssues(STORY_QUALITY_BASE) },
      };
    case "story-quality-failures":
      return {
        scenario: name,
        ok: true,
        payload: {
          userStory: storyQualityIssues({ ...STORY_QUALITY_BASE, userStory: "Just build it." }),
          broadScope: storyQualityIssues({
            ...STORY_QUALITY_BASE,
            swarm: { ...STORY_QUALITY_BASE.swarm, file_scope: ["backend"] },
          }),
          genericVerify: storyQualityIssues({
            ...STORY_QUALITY_BASE,
            swarm: { ...STORY_QUALITY_BASE.swarm, verify_commands: ["task check"] },
          }),
          endOfStringObservable: storyQualityIssues({
            ...STORY_QUALITY_BASE,
            acceptanceTexts: [
              "A user with valid credentials logs into the system successfully today.",
              "Given an existing user, when the auth model loads it, then the saved identity returns.",
            ],
          }),
        },
      };
    case "safety-premigrate-sibling":
      return {
        scenario: name,
        ok: true,
        payload: {
          md: premigrateSibling("/tmp/SPECIFICATION.md"),
          json: premigrateSibling("/tmp/specification.vbrief.json"),
          noExt: premigrateSibling("/tmp/README"),
        },
      };
    case "safety-plan-backups": {
      const projectRoot = join(ctx.fixtureRoot, "safety-backups");
      mkdirSync(projectRoot, { recursive: true });
      writeFileSync(join(projectRoot, "SPECIFICATION.md"), "spec", "utf8");
      writeFileSync(join(projectRoot, "PROJECT.md"), DEPRECATION_SENTINEL, "utf8");
      const pairs = planBackups(projectRoot);
      return {
        scenario: name,
        ok: true,
        payload: {
          pairs: pairs.map(([src, dst]) => [src.split("/").pop(), dst.split("/").pop()]),
          dirtyMessage: dirtyTreeRefusalMessage(),
          isDirty: isTreeDirty(projectRoot),
        },
      };
    }
    case "safety-manifest-roundtrip": {
      const manifest = new SafetyManifest({
        version: "1",
        migration_timestamp: "2026-04-22T00:00:00Z",
        created_files: ["vbrief/migration/LEGACY-REPORT.md"],
        renames: [
          {
            original: "vbrief/migration/LEGACY-REPORT.md",
            current: "vbrief/migration/LEGACY-REPORT.reviewed.md",
            renamed_by: "deft-directive-sync Phase 6c",
            renamed_at: "2026-04-22T00:45:00Z",
          },
        ],
      });
      const clone = SafetyManifest.fromJson(manifest.toJson());
      return {
        scenario: name,
        ok: true,
        payload: {
          resolved: clone.currentPathFor("vbrief/migration/LEGACY-REPORT.md"),
          shaEmpty: sha256Of(join(ctx.fixtureRoot, "missing-file")),
        },
      };
    }
    case "safety-write-backups-dryrun": {
      const projectRoot = join(ctx.fixtureRoot, "safety-write");
      mkdirSync(projectRoot, { recursive: true });
      const src = join(projectRoot, "SPECIFICATION.md");
      writeFileSync(src, "hello", "utf8");
      const dst = premigrateSibling(src);
      const [records, actions] = writeBackups(projectRoot, [[src, dst]], { dryRun: true });
      return { scenario: name, ok: true, payload: { records, actions } };
    }
    case "regex-edge-cases":
      return {
        scenario: name,
        ok: true,
        payload: {
          tasks: parseSpecTasks(EDGE_SPEC),
          headings: parseTopLevelSections(EDGE_HEADINGS),
          slugs: EDGE_SLUGS.map((s) => slugifyId(s)),
          stories: EDGE_STORIES.map((s) =>
            storyQualityIssues({ ...STORY_QUALITY_BASE, userStory: s }).some((i) =>
              i.includes("UserStory must match"),
            ),
          ),
        },
      };
    default:
      return { scenario: name, ok: false, payload: { error: `unknown scenario: ${name}` } };
  }
}

const DEPRECATION_SENTINEL = "<!-- deft:deprecated-redirect -->";

export const PARITY_SCENARIO_NAMES = [
  "slugify-basic",
  "slugify-collision",
  "slug-fallback-id",
  "validate-migration-missing-dir",
  "validate-migration-empty-dir",
  "validate-migration-valid-pd",
  "validate-migration-invalid-status",
  "isolate-invalid-output",
  "finalize-migration-success",
  "finalize-migration-failure",
  "legacy-normalize-title",
  "legacy-lookup-canonical",
  "legacy-parse-sections",
  "legacy-partition-sections",
  "fidelity-map-spec-status",
  "fidelity-parse-spec-tasks",
  "fidelity-requirements",
  "fidelity-edges-and-narratives",
  "fidelity-ingest-spec",
  "story-quality-happy",
  "story-quality-failures",
  "safety-premigrate-sibling",
  "safety-plan-backups",
  "safety-manifest-roundtrip",
  "safety-write-backups-dryrun",
  "regex-edge-cases",
] as const;

/** Render scenario output bytes for parity compare. */
export function renderScenarioOutput(result: ParityScenarioResult, fixtureRoot?: string): string {
  const normalized =
    fixtureRoot !== undefined
      ? (normalizeFixturePaths(result, fixtureRoot) as ParityScenarioResult)
      : result;
  return pythonJsonPretty(normalized);
}
