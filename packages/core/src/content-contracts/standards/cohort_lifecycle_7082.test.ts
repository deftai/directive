/**
 * Cohort lifecycle rule texts (#7082, cohort-lifecycle slice of #7062).
 *
 * The preamble, AGENTS.md, the agents-entry template and the swarm and build
 * skills send a cohort's post-merge completion to the cohort closer: in-PR
 * completion first, else one `swarm:finalize-cohort` run. A solo story keeps the
 * unbatched path. The skills pack source and the rendered skills agree, and the
 * managed AGENTS.md section mirrors the agents-entry template (#1309).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function readRepo(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
}

const RULE_SURFACES = [
  "content/templates/agent-prompt-preamble.md",
  "content/templates/agents-entry.md",
  "AGENTS.md",
  "content/skills/deft-directive-swarm/SKILL.md",
  "content/skills/deft-directive-build/SKILL.md",
] as const;

interface PackSkill {
  readonly id: string;
  readonly body: string;
}

function packBody(id: string): string {
  const pack = JSON.parse(readRepo("content/packs/skills/skills-pack-0.1.json")) as {
    skills: PackSkill[];
  };
  const skill = pack.skills.find((s) => s.id === id);
  if (skill === undefined) throw new Error(`skill ${id} missing from the pack`);
  return skill.body.replace(/\r\n/g, "\n");
}

describe("cohort post-merge completion goes to the cohort closer (#7082 clauses 3, 7)", () => {
  it("each rule surface names in-PR completion first, the cohort closer and the solo path", () => {
    for (const rel of RULE_SURFACES) {
      const text = readRepo(rel);
      expect(text, rel).toContain("#7082");
      expect(text, rel).toContain("--in-pr");
      expect(text, rel).toMatch(/cohort closer/i);
      expect(text, rel).toMatch(/solo/i);
    }
  });

  it("the preamble keeps the DONE reservation and adds the cohort carve-out", () => {
    const text = readRepo("content/templates/agent-prompt-preamble.md");
    expect(text).toContain("`drive-to: merge-ready` DONE reservation (#2843)");
    expect(text).toContain("**Cohort carve-out (#7082):**");
    expect(text).toContain("**Cohort closer (#7082):**");
    expect(text).toContain("--pr <merged PRs only> --cohort <story ids>");
    expect(text).toMatch(/names each unmerged, omitted or refused story/);
    expect(text).toContain("A solo story keeps worker-owned completion.");
  });

  it("the swarm skill and its Phase 6 reference run one finalize with --cohort over merged PRs only", () => {
    for (const rel of [
      "content/skills/deft-directive-swarm/SKILL.md",
      "content/skills/deft-directive-swarm/references/core-phase-5-6.md",
    ]) {
      const text = readRepo(rel);
      expect(text, rel).toMatch(/swarm:finalize-cohort -- --pr <merged[^>]*>.*--cohort/);
      expect(text, rel).toMatch(/no changelog fragment/);
      expect(text, rel).toContain("verify:completed-tracked");
      expect(text, rel).toContain("verify:orphan-active");
    }
    expect(readRepo("content/skills/deft-directive-swarm/references/core-phase-0.md")).toContain(
      "**Cohort completion (#7082):**",
    );
    expect(readRepo("content/skills/deft-directive-swarm/references/core-phase-3.md")).toContain(
      "**Cohort carve-out (#7082):**",
    );
  });

  it("the build skill's swarm-cohort text no longer runs scope:complete after each story", () => {
    const text = readRepo("content/skills/deft-directive-build/SKILL.md");
    expect(text).not.toContain("checkpoint-commit + `task scope:complete` discipline");
    expect(text).not.toContain("after each story's checkpoint commit + `task scope:complete`");
    expect(text).toContain("not a `task scope:complete` after each story");
  });

  it("the skills pack source and the rendered skills agree", () => {
    for (const id of ["deft-directive-swarm", "deft-directive-build"]) {
      const rendered = readRepo(`content/skills/${id}/SKILL.md`);
      expect(rendered, id).toContain(packBody(id).trim());
    }
  });

  it("the managed AGENTS.md section mirrors the agents-entry cohort rule (#1309)", () => {
    const template = readRepo("content/templates/agents-entry.md");
    const line = template.split("\n").find((l) => l.includes("**Cohort (#7082):**"));
    expect(line).toBeDefined();
    expect(readRepo("AGENTS.md")).toContain(line ?? "");
    expect(readRepo("content/commands.md")).toContain("**Cohort closer (#7082):**");
  });
});
