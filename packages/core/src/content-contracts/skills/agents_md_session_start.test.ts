import { describe, expect, it } from "vitest";
import { readRepoFile } from "./helpers.js";

/** Port of tests/content/test_agents_md_session_start.py (#1838 #1530); #2453 pointer relocation. */

const agentsMdText = readRepoFile("AGENTS.md");
const agentsEntryText = readRepoFile("templates/agents-entry.md");
const commandsText = readRepoFile("commands.md");

function extractSection(text: string, headingPattern: string): string {
  const headingRe = new RegExp(`^##\\s+${headingPattern}`, "m");
  const match = headingRe.exec(text);
  if (!match || match.index === undefined) {
    return "";
  }
  const start = match.index;
  const afterHeading = text.slice(start + match[0].length);
  const nextHeading = afterHeading.search(/^##\s/m);
  return nextHeading === -1
    ? text.slice(start)
    : text.slice(start, start + match[0].length + nextHeading);
}

function extractManagedSection(text: string): string {
  const start = text.search(/<!-- deft:managed-section v3\b/);
  const end = text.indexOf("<!-- /deft:managed-section -->");
  if (start < 0 || end < start) {
    return "";
  }
  return text.slice(start, end);
}

describe("test_agents_md_session_start", () => {
  it("session_start_ritual_header_present", () => {
    expect(/^##\s+Session-start ritual\s+\(#1149\)\s*$/m.test(agentsMdText)).toBe(true);
    expect(/^##\s+Session-start ritual\s+\(#1149\)\s*$/m.test(agentsEntryText)).toBe(true);
    expect(/^##\s+Session routing\s+\(#2176\)\s*$/m.test(agentsEntryText)).toBe(true);
  });

  it("session_routing_read_only_posture_present", () => {
    const entrySection = extractSection(agentsEntryText, "Session routing \\(#2176\\)");
    expect(entrySection).toBeTruthy();
    expect(entrySection.toLowerCase()).toContain("read-only");
    expect(entrySection).toContain("deft session:start -- --read-only");
    expect(entrySection).not.toMatch(/Task-only/i);
    expect(entrySection).toContain("addressing-name");
    // #2535: mutation discoverability via "mutation intent" / "Mutation →" pointer tokens.
    expect(entrySection.toLowerCase()).toContain("mutation intent");
    expect(entrySection).toContain("Mutation →");
    // #2544: Windows USER.md path surfaced in always-on bootstrap.
    expect(entrySection).toContain("%APPDATA%\\deft\\USER.md");
    expect(entrySection).toContain("USER.md resolved");
    expect(entrySection).toMatch(/⊗.*\.config\/deft.*Windows/i);
    const commandsSection = extractSection(commandsText, "Session-start ritual \\(#1149\\)");
    expect(commandsSection).toContain("Session routing (#2176)");
    expect(commandsSection).toContain("read-only posture");
    expect(commandsSection).toContain(".deft/ritual-state.json");
    expect(commandsSection).toContain("deft session:start --read-only");
    expect(commandsSection).toContain("task session:start -- --read-only");
    expect(commandsSection).not.toContain("deft session:start -- --read-only");
    expect(commandsSection).not.toMatch(/Task-only/i);
    expect(commandsSection).toContain("%APPDATA%\\deft\\USER.md");
  });

  it("session_start_ritual_pointer_surface_in_managed_section", () => {
    for (const text of [agentsMdText, agentsEntryText]) {
      const managed = extractManagedSection(text);
      const section = extractSection(managed, "Session-start ritual \\(#1149\\)");
      expect(section).toBeTruthy();
      expect(section).toContain("deft session:start");
      expect(section).toContain("deft verify:session-ritual");
      expect(section).toContain("plan.policy.sessionRitualStalenessHours");
      expect(section).toContain("commands.md");
    }
  });

  it("session_start_ritual_bulk_in_commands_canonical_home", () => {
    const section = extractSection(commandsText, "Session-start ritual \\(#1149\\)");
    expect(section).toBeTruthy();
    expect(section).toContain("plan.policy.sessionRitualStalenessHours");
    expect(section).toContain("DEFT_SESSION_RITUAL_SKIP=1");
    expect(section).toContain("--defer step=reason");
    expect(section.toLowerCase()).toContain("stale");
    expect(section).toContain("Pre-`start_agent` gate stack (#1149/#1348)");
  });

  it("session_start_ritual_maintainer_substitution_line_present", () => {
    const section = extractSection(agentsMdText, "Session-start ritual \\(#1149\\)");
    expect(section).toContain("`task session:start`");
    expect(section).toContain("`task verify:session-ritual -- --tier=gated`");
    expect(section).toContain("`task verify:cache-fresh`");
  });

  it("cache_as_authoritative_section_present", () => {
    expect(/^##\s+Cache-as-authoritative work selection\s+\(#1149\)\s*$/m.test(agentsMdText)).toBe(
      true,
    );
  });

  it("cache_as_authoritative_must_rule_present", () => {
    // #2402: ordered-plan precedence amends #1149 — plan-first when active, else queue.
    expect(agentsMdText).toContain("ordered-plan first");
    expect(agentsMdText).toContain("#2402");
    expect(agentsMdText).toContain("deft triage:queue --limit=10");
    expect(agentsMdText).toContain("(D11)");
    expect(agentsMdText).toContain("task triage:queue");
    expect(agentsMdText).toContain("task plan-sequence:current");
  });

  it("cache_as_authoritative_anti_pattern_present", () => {
    expect(agentsMdText).toContain("Recommend work without queue/plan consult");
    expect(agentsMdText).toContain("widen past an exhausted plan");
  });

  it("cache_as_authoritative_uses_canonical_markers", () => {
    // Managed section (consumer template shape) carries the ! / ⊗ markers.
    const managedStart = agentsMdText.indexOf("<!-- deft:managed-section");
    const managed = managedStart >= 0 ? agentsMdText.slice(managedStart) : agentsMdText;
    const section = extractSection(managed, "Cache-as-authoritative work selection \\(#1149\\)");
    expect(section).toBeTruthy();
    expect(/^!\s+"what next\?"/m.test(section)).toBe(true);
    expect(/^\u2297\s+Recommend work without queue\/plan consult/m.test(section)).toBe(true);
  });

  // #838: the `## Skill Routing` keyword->path table moved to the REFERENCES.md
  // Skills Index. AGENTS.md keeps only a `## Skills` pointer + the behavioral
  // "Before Improvising" gate. The welcome/onboard-triage invocation is asserted
  // via the propagation command markers in agents_entry_contract.test.ts.
  it("skill_routing_table_replaced_with_pointer", () => {
    expect(agentsMdText).not.toContain("## Skill Routing");
    const maintainerSkills = extractSection(agentsMdText, "Skills");
    expect(maintainerSkills).toBeTruthy();
    expect(maintainerSkills).toContain("Skills Index");
    expect(maintainerSkills).toContain("REFERENCES.md");
    expect(maintainerSkills).toContain("task triage:welcome --onboard");
    const consumerSkills = extractSection(extractManagedSection(agentsMdText), "Skills");
    expect(consumerSkills).toContain("packs:slice skills list");
  });

  it("pre_start_agent_gate_stack_in_commands_canonical_home", () => {
    const section = extractSection(commandsText, "Session-start ritual \\(#1149\\)");
    const stackLine = section.match(/\*\*Pre-`start_agent` gate stack[^\n]*/)?.[0] ?? "";
    expect(stackLine).toContain("Pre-`start_agent` gate stack (#1149/#1348)");
    const pSession = stackLine.indexOf("verify:session-ritual");
    const pStory = stackLine.indexOf("verify:story-ready");
    const pVbrief = stackLine.indexOf("xbrief:preflight");
    const pCache = stackLine.indexOf("verify:cache-fresh");
    const pBranch = stackLine.indexOf("verify:branch");
    const pStart = stackLine.lastIndexOf("start_agent");
    expect(pSession).toBeGreaterThanOrEqual(0);
    expect(pSession).toBeLessThan(pStory);
    expect(pStory).toBeLessThan(pVbrief);
    expect(pVbrief).toBeLessThan(pCache);
    expect(pCache).toBeLessThan(pBranch);
    expect(pBranch).toBeLessThan(pStart);
    expect(section).toContain("#1348");
    expect(section).toContain("verify:cache-fresh");
  });
});
