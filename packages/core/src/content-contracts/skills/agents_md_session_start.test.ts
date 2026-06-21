import { describe, expect, it } from "vitest";
import { readRepoFile } from "./helpers.js";

/** Port of tests/content/test_agents_md_session_start.py (#1838 #1530) */

const agentsMdText = readRepoFile("AGENTS.md");

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

function extractGateStackParagraph(agentsMd: string): string {
  const intentGate = extractSection(agentsMd, "Development Process \\(always follow\\)");
  const stackMatch = intentGate.match(
    /\*\*Pre-`start_agent` gate stack \(#1149\/#1348\):\*\*[\s\S]*?(?=\r?\n\r?\n|^#{2,3}\s)/m,
  );
  return stackMatch?.[0] ?? "";
}

describe("test_agents_md_session_start", () => {
  it("session_start_ritual_header_present", () => {
    expect(/^##\s+Session-start ritual\s+\(#1149\)\s*$/m.test(agentsMdText)).toBe(true);
  });

  it("session_start_ritual_documents_two_tier_verifier_order", () => {
    const section = extractSection(agentsMdText, "Session-start ritual \\(#1149\\)");
    expect(section).toBeTruthy();
    const pStart = section.indexOf("`task session:start`");
    const pState = section.indexOf(".deft/ritual-state.json");
    const pVerify = section.indexOf("`task verify:session-ritual -- --tier=gated`");
    const pDoctor = section.indexOf("`task doctor`");
    const pTriage = section.indexOf("`task triage:welcome`");
    expect(pStart).toBeGreaterThanOrEqual(0);
    expect(pStart).toBeLessThan(pState);
    expect(pState).toBeLessThan(pTriage);
    expect(pTriage).toBeLessThan(pVerify);
    expect(pVerify).toBeLessThan(pDoctor);
    expect(section).toContain("plan.policy.sessionRitualStalenessHours");
    expect(section).toContain("DEFT_SESSION_RITUAL_SKIP=1");
    expect(section).toContain("--defer step=reason");
  });

  it("session_start_ritual_documents_d2_suppression_window", () => {
    const section = extractSection(agentsMdText, "Session-start ritual \\(#1149\\)");
    expect(/4[ -]hour/.test(section)).toBe(true);
  });

  it("session_start_ritual_marks_cache_fresh_as_stale_only", () => {
    const section = extractSection(agentsMdText, "Session-start ritual \\(#1149\\)");
    expect(section.toLowerCase()).toContain("stale");
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
      "Recommend a specific issue or vBRIEF without consulting `task triage:queue`",
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

  it("skill_routing_triage_hygiene_entry_present", () => {
    const routing = extractSection(agentsMdText, "Skill Routing");
    expect(routing).toBeTruthy();
    expect(routing).toContain('"triage hygiene"');
    expect(routing).toContain('"work the cache"');
    expect(routing).toContain("skills/deft-directive-triage/SKILL.md");
  });

  it("skill_routing_whats_next_entry_present", () => {
    const routing = extractSection(agentsMdText, "Skill Routing");
    expect(routing).toContain('"what\'s next"');
    expect(routing).toContain('"queue"');
    expect(routing).toContain('"build a cohort"');
    expect(routing).toContain("skills/deft-directive-triage/SKILL.md");
  });

  it("skill_routing_welcome_entry_present", () => {
    const routing = extractSection(agentsMdText, "Skill Routing");
    expect(routing).toContain('"welcome"');
    expect(routing).toContain('"onboard triage"');
    expect(routing).toContain("task triage:welcome");
    expect(routing).toContain("(N3 / #1143)");
  });

  it("skill_routing_refinement_amendment_present", () => {
    const routing = extractSection(agentsMdText, "Skill Routing");
    expect(routing).toContain("Phase 0 consults the triage cache first (see N1 / #1141)");
  });

  it("skill_routing_swarm_amendment_present", () => {
    const routing = extractSection(agentsMdText, "Skill Routing");
    expect(routing).toContain("Phase 0 is queue-driven (see N2 / #1142)");
  });

  it("pre_start_agent_gate_stack_paragraph_present", () => {
    const intentGate = extractSection(agentsMdText, "Development Process \\(always follow\\)");
    expect(intentGate).toBeTruthy();
    expect(intentGate).toContain("Pre-`start_agent` gate stack (#1149/#1348)");
  });

  it("pre_start_agent_gate_stack_canonical_order", () => {
    const stack = extractGateStackParagraph(agentsMdText);
    expect(stack).toBeTruthy();
    const pSession = stack.indexOf("session ritual gate");
    const pStory = stack.indexOf("story-start Gate 0");
    const pVbrief = stack.indexOf("vBRIEF implementation-intent gate");
    const pCache = stack.indexOf("task verify:cache-fresh");
    const pBranch = stack.indexOf("branch-policy gate");
    const pStart = stack.lastIndexOf("start_agent");
    expect(pSession).toBeGreaterThanOrEqual(0);
    expect(pSession).toBeLessThan(pStory);
    expect(pStory).toBeLessThan(pVbrief);
    expect(pVbrief).toBeLessThan(pCache);
    expect(pCache).toBeLessThan(pBranch);
    expect(pBranch).toBeLessThan(pStart);
  });

  it("pre_start_agent_gate_stack_cites_downstream_owners", () => {
    const stack = extractGateStackParagraph(agentsMdText);
    expect(stack).toContain("#1348");
    expect(stack).toContain("#810");
    expect(stack).toContain("#1127");
  });
});
