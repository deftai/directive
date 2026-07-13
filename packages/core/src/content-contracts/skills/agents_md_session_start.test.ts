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
    expect(entrySection).toContain("addressing-name");
    expect(entrySection).toContain("Mutation boundary");
    const commandsSection = extractSection(commandsText, "Session-start ritual \\(#1149\\)");
    expect(commandsSection).toContain("Session routing (#2176)");
    expect(commandsSection).toContain("read-only posture");
    expect(commandsSection).toContain(".deft/ritual-state.json");
    expect(commandsSection).toContain("deft session:start -- --read-only");
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
    const required =
      'When the operator asks "what should I work on next?" / "build a cohort" / ' +
      '"what\'s the queue?", the agent MUST run `task triage:queue --limit=10`';
    expect(agentsMdText).toContain(required);
    expect(agentsMdText).toContain("(D11 / #1128)");
  });

  it("cache_as_authoritative_anti_pattern_present", () => {
    expect(agentsMdText).toContain(
      "Recommend a specific issue or xBRIEF without consulting `task triage:queue`",
    );
  });

  it("cache_as_authoritative_uses_canonical_markers", () => {
    const section = extractSection(
      agentsMdText,
      "Cache-as-authoritative work selection \\(#1149\\)",
    );
    expect(section).toBeTruthy();
    expect(/^!\s+When the operator asks/m.test(section)).toBe(true);
    expect(/^\u2297\s+Recommend/m.test(section)).toBe(true);
  });

  // #838: the `## Skill Routing` keyword->path table moved to the REFERENCES.md
  // Skills Index. AGENTS.md keeps only a `## Skills` pointer + the behavioral
  // "Before Improvising" gate. The welcome/onboard-triage invocation is asserted
  // via the propagation command markers in agents_entry_contract.test.ts.
  it("skill_routing_table_replaced_with_pointer", () => {
    expect(agentsMdText).not.toContain("## Skill Routing");
    const skills = extractSection(agentsMdText, "Skills");
    expect(skills).toBeTruthy();
    expect(skills).toContain("Skills Index");
    expect(skills).toContain("REFERENCES.md");
    expect(skills).toContain("task triage:welcome --onboard");
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
