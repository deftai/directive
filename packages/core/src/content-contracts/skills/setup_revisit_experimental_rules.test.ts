/**
 * Content contracts for setup skill Revisit experimental rules (#46).
 */
import { describe, expect, it } from "vitest";
import { readRepoFile } from "./helpers.js";

const SETUP_SKILL = "skills/deft-directive-setup/SKILL.md";

function packedSetupBody(): string {
  const pack = JSON.parse(readRepoFile("packs/skills/skills-pack-0.1.json")) as {
    skills: Array<{ id: string; body: string }>;
  };
  const setup = pack.skills.find((skill) => skill.id === "deft-directive-setup");
  if (setup === undefined) throw new Error("deft-directive-setup pack entry missing");
  return setup.body;
}

describe("setup revisit experimental rules (#46)", () => {
  const text = readRepoFile(SETUP_SKILL);

  it("documents Returning-user re-entry with Revisit experimental rules", () => {
    expect(text).toContain("### Returning-user re-entry (#46)");
    expect(text).toContain("## Revisit experimental rules (#46)");
    expect(text).toContain("**Revisit experimental rules**");
  });

  it("lists experimental-meta triggers in When to Use", () => {
    expect(text).toContain("revisit experimental rules");
    expect(text).toContain("toggle experimental meta");
  });

  it("shows current state and reuses Phase 1 5a–5c explainers", () => {
    expect(text).toContain("current state");
    expect(text).toContain("5a–5c");
    expect(text).toContain("meta/SOUL.md");
    expect(text).toContain("meta/morals.md");
    expect(text).toContain("meta/code-field.md");
  });

  it("requires non-clobber of Personal and Defaults on toggle", () => {
    expect(text).toContain("byte-identical");
    expect(text).toContain("Personal");
    expect(text).toContain("Defaults");
    expect(text).toContain("UTF-8");
  });

  it("forbids inventing a deft config verb family for this slice", () => {
    expect(text).toContain("deft config");
    expect(text).toMatch(/⊗ Invent.*deft config|setup skill re-entry is the product surface/i);
  });

  it("points at applyExperimentalRulesState helper", () => {
    expect(text).toContain("applyExperimentalRulesState");
    expect(text).toContain("experimental-rules.ts");
  });

  it("keeps revisit section before Phase 2", () => {
    const revisit = text.indexOf("## Revisit experimental rules (#46)");
    const phase2 = text.indexOf("## Phase 2 — Project Configuration");
    expect(revisit).toBeGreaterThan(0);
    expect(phase2).toBeGreaterThan(revisit);
  });
});

describe("setup namespaced branch-policy contract (#3609)", () => {
  const rendered = readRepoFile(SETUP_SKILL);
  const packed = packedSetupBody();

  for (const [surface, text] of [
    ["packed", packed],
    ["rendered", rendered],
  ] as const) {
    it(`${surface} setup checks re-entry shadow state before mutation`, () => {
      expect(text).toContain("### Re-entry shadow guard (#3609)");
      expect(text).toContain("deft policy:show --field=plan.policy.allowDirectCommitsToMaster");
      expect(text).toContain("inspect **stderr as well as the exit code**");
      expect(text).toContain("resolve every collision explicitly");
      expect(text).toContain("delete bare `plan.policy`");
    });

    it(`${surface} setup invokes the exact public writer commands on every track`, () => {
      expect(text).toContain("This gate applies to **every track**");
      expect(text).toContain("deft policy:enforce-branches --actor agent:deft-directive-setup");
      expect(text).toContain(
        "deft policy:allow-direct-commits --confirm --actor agent:deft-directive-setup",
      );
      expect(text).toContain("Default `false` (enforce branches)");
      expect(text).toContain("A keep choice still runs the selected writer");
      expect(text).toContain(
        "keep a legacy-only bare `plan.policy` intact until the shared writer",
      );
      expect(text).toContain("Never delete or reconstruct a legacy-only block before the writer");
    });

    it(`${surface} setup preserves re-entry true and binds commands to the selected root`, () => {
      expect(text).toContain("Pass `--project-root <policy-project-root>` to every Phase 2 policy");
      expect(text).toContain("public policy writer, inspector, lock, and conformance gate honor");
      expect(text).toContain("Do not unset or rewrite `$DEFT_PROJECT_PATH`");
      expect(text).not.toContain("Halt when the override is outside that canonical layout");
      expect(text).toContain("Never replace an existing `true`");
      expect(text).toContain("Track 2 or 3 existing-true");
      expect(text).toContain("--project-root <policy-project-root>");
    });

    it(`${surface} setup blocks completion until namespaced read-back and conformance`, () => {
      expect(text).toContain("A nonzero writer exit halts Phase 2 immediately");
      expect(text).toContain('plan["x-directive/policy"].allowDirectCommitsToMaster');
      expect(text).toContain("bare `plan.policy` is absent");
      expect(text).toContain("deft verify:vbrief-conformance --project-root <policy-project-root>");
    });

    it(`${surface} setup stores Phase 2 narratives through project:write-narratives (#4663)`, () => {
      expect(text).toContain("deft project:write-narratives");
      expect(text).toContain("Overview, TechStack, Strategy, Quality, ProjectRules, and Branching");
      expect(text).toContain("It is not an agent patch of that file");
      expect(text).toContain("It does not set policy keys");
      expect(text).toContain("while `xbrief/active/` is empty");
    });

    it(`${surface} setup contains no legacy branch-policy output recipe`, () => {
      expect(text).not.toContain("Allow direct commits to master: true");
      expect(text).not.toContain("write `plan.policy.allowDirectCommitsToMaster");
      expect(text).not.toContain("plan.ProjectConfig.policy");
    });
  }
});
