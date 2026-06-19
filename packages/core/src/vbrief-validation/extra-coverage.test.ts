import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  alignSpecNarratives,
  buildEdgesFromTasks,
  buildRequirementsNarrative,
  formatMigrationLogEntry,
  ingestSpecNarratives,
  parseSpecTasks,
  taskScopeNarratives,
} from "./fidelity.js";
import { cmdVbriefValidation, run } from "./main.js";
import { sortFailureActions, sortFailureStderr } from "./normalize.js";
import { storyQualityIssues } from "./story-quality.js";
import { finalizeMigration, setValidateAllForTests } from "./validation.js";

describe("vbrief-validation extra branch coverage", () => {
  it("covers main CLI branches", () => {
    expect(run(["--help"])).toBe(0);
    expect(run(["--unexpected"])).toBe(2);
  });

  it("covers fidelity edge parsing", () => {
    const content =
      "### t1.1.1 -- Title\n\nDepends on: none\n\n**Traces**: FR-1\n\n- bullet at start\n\nBody after.\n";
    const tasks = parseSpecTasks(content);
    expect(tasks[0]?.depends_on).toEqual([]);
    expect(tasks[0]?.traces).toContain("FR-1");
    expect(tasks[0]?.body.length).toBeGreaterThan(0);
    expect(buildEdgesFromTasks([{ task_id: "bad id", depends_on: ["x"] }])).toEqual([]);
    expect(taskScopeNarratives({})).toEqual({});
    expect(buildRequirementsNarrative({ "NFR-2": "b", "FR-1": "a" })).toMatch(/^FR-1:/);
    const [, logs] = ingestSpecNarratives("## Summary\n\nx\n");
    expect(formatMigrationLogEntry(logs[0] ?? {})).toContain("ROUTE");
    expect(alignSpecNarratives({ Overview: "a", summary: "b" }).Overview).toContain("a");
  });

  it("covers story-quality non-concurrent and edge acceptance paths", () => {
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
        "Given a valid user payload, when the auth model saves it, then the user record persists.",
        "Given an existing user, when the auth model loads it, then the saved identity returns.",
      ],
      acceptanceCountJustification: "only one outcome",
      swarm: {
        file_scope: ["backend"],
        verify_commands: ["task check"],
        parallel_safe: false,
        file_scope_confidence: "low",
      },
      concurrentReady: false,
    };
    const issues = storyQualityIssues(base);
    expect(issues.some((i) => i.includes("2-5 acceptance criteria"))).toBe(false);
    expect(issues.some((i) => i.includes("Description is required"))).toBe(false);
  });

  it("covers normalize failure sorting helpers", () => {
    const actions = ["FAIL", "  b.vbrief.json: err", "  a.vbrief.json: err", "MOVE"];
    expect(sortFailureActions(actions)[1]).toBe("  a.vbrief.json: err");
    expect(sortFailureStderr("HEAD\n  b.vbrief.json: err\n  a.vbrief.json: err\nTAIL\n")).toContain(
      "  a.vbrief.json: err",
    );
  });

  it("covers finalize success with warnings", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-finalize-ok-"));
    mkdirSync(join(root, "vbrief"), { recursive: true });
    setValidateAllForTests(() => [[], ["warn-one"]]);
    const stderr: string[] = [];
    const [ok] = finalizeMigration(root, join(root, "vbrief"), ["seed"], {
      stderrWriter: (c) => stderr.push(c),
    });
    expect(ok).toBe(true);
    expect(stderr.join("")).toContain("WARNING: warn-one");
    setValidateAllForTests(null);
    rmSync(root, { recursive: true, force: true });
  });

  it("cmdVbriefValidation surfaces errors", () => {
    expect(cmdVbriefValidation(["--scenario", "does-not-exist", "--fixture-root", "/tmp"])).toBe(0);
  });
});
