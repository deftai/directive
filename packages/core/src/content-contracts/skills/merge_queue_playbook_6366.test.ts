import { describe, expect, it } from "vitest";
import { readRepoFile } from "./helpers.js";

/**
 * #6366 -- merge queue setup playbook, and the pointers agents read where they merge.
 * Also pins the #6379 pre-dispatch pointer in AGENTS.md, its template and the swarm skill.
 */

const PLAYBOOK = "docs/github-merge-queue-setup.md";

function section(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`);
  expect(start, `missing ${heading}`).not.toBe(-1);
  const end = text.indexOf("\n## ", start + heading.length + 1);
  return end === -1 ? text.slice(start) : text.slice(start, end);
}

describe("merge_queue_playbook_6366", () => {
  const playbook = readRepoFile(PLAYBOOK);

  it("playbook_covers_setup_verify_agent_merge_and_roll_back", () => {
    for (const heading of [
      "## Prerequisites (repository content, before the settings)",
      "## Settings (repository admin)",
      "## Verify",
      "## How agents merge afterwards",
      "## Roll back",
    ]) {
      expect(playbook).toContain(`\n${heading}\n`);
    }
    expect(playbook).toContain("merge_group");
    expect(playbook).toContain("task pr:wait-mergeable-and-merge");
  });

  it("playbook_known_issues_name_the_open_queue_bugs", () => {
    const known = section(playbook, "## Known issues");
    for (const ref of ["#6423", "#6296", "#6467", "#6424"]) {
      expect(known).toContain(ref);
    }
    expect(known).toContain("--resume");
    expect(known).toContain("absent-required");
    expect(known).toContain("one-pr-unit-merge-group");
  });

  it("playbook_saving_rounds_names_the_four_savers", () => {
    const saving = section(playbook, "## Saving rounds in the queue");
    expect(saving).toContain("changelog.d/");
    expect(saving).toContain("task scope:complete -- <active-path> --in-pr");
    expect(saving).toContain("#6277");
    expect(saving).toContain("@slizard label");
    expect(saving).toContain("#6377");
    expect(saving).toContain("swarm:pre-dispatch");
    expect(saving).toContain("#6379");
  });

  it("scm_github_merge_queue_mode_links_the_playbook", () => {
    const mode = section(readRepoFile("scm/github.md"), "### Merge queue mode (#6295)");
    expect(mode).toContain("](../docs/github-merge-queue-setup.md)");
  });

  it("review_cycle_merge_step_links_the_playbook", () => {
    const skill = readRepoFile("skills/deft-directive-review-cycle/SKILL.md");
    const caller = skill.indexOf("! **Caller order (MUST):**");
    expect(caller).not.toBe(-1);
    const link = skill.indexOf("](../../docs/github-merge-queue-setup.md)", caller);
    expect(link).toBeGreaterThan(caller);
    expect(link - caller).toBeLessThan(600);
  });

  it("pre_dispatch_pointer_in_agents_template_and_swarm_skill", () => {
    const files = [
      "templates/agents-entry.md",
      "AGENTS.md",
      "skills/deft-directive-swarm/SKILL.md",
    ];
    for (const rel of files) {
      const lines = readRepoFile(rel)
        .split("\n")
        .filter((l) => l.includes("swarm:pre-dispatch") && l.includes("(#6379)"));
      expect(lines, rel).toHaveLength(1);
      const line = lines[0] ?? "";
      expect(line, rel).toContain("(begin)");
      expect(line, rel).toMatch(/before (you start )?any implementation worker/i);
      expect(line, rel).toContain("binds th");
      expect(line, rel).toContain("commits are admitted");
    }
  });
});
