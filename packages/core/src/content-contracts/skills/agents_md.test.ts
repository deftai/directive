import { describe, expect, it } from "vitest";
import { readAgentsMd, readAgentsPreamble, returningSessionsSection } from "./helpers.js";

/** Port of tests/content/test_agents_md.py (#1838 #1530). Product SoT = agents-entry (+ preamble). */

describe("test_agents_md", () => {
  // Gone from tip agents-entry/preamble: "headless bypass" session-routing carve-out.
  // Headless ritual bypass now lives in preamble as DEFT_SESSION_RITUAL_SKIP (covered elsewhere).

  it("agents_md_pre_implementation_anti_pattern", () => {
    const text = readAgentsPreamble();
    expect(text).toContain("\u2297");
    expect(text.toLowerCase()).toContain("editing files before");
  });

  it("agents_md_deft_alignment_confirmation_rule", () => {
    // Alignment confirm phrase moved to preamble §1 (agents-entry only says "confirm Deft alignment").
    const text = readAgentsPreamble();
    expect(text).toContain("Deft Directive active");
  });

  it("agents_md_returning_sessions_has_must_marker", () => {
    const section = returningSessionsSection();
    expect(section).toContain("!");
    expect(section.toLowerCase()).toContain("read-only default");
  });

  it("agents_md_returning_sessions_anti_pattern_present", () => {
    const section = returningSessionsSection();
    expect(section).toContain("\u2297");
    expect(section).toContain("invent `~/.config/deft` on Windows");
  });

  it("agents_md_alignment_requires_name_echo", () => {
    const text = readAgentsMd();
    const lowered = text.toLowerCase();
    expect(lowered).toContain("addressing-name");
    const managedStart = text.indexOf("<!-- deft:managed-section");
    expect(managedStart).toBeGreaterThanOrEqual(0);
    expect(text.slice(managedStart).toLowerCase()).toContain("addressing-name");
    expect(text).toContain("confirm Deft alignment");
  });

  it("agents_md_external_context_precedence_documented", () => {
    const section = returningSessionsSection();
    const lowered = section.toLowerCase();
    expect(lowered).toContain("personal (always wins)");
    expect(lowered).toContain("external context");
  });

  it("agents_md_external_context_names_host_agent_memory (#5321)", () => {
    const section = returningSessionsSection();
    const lowered = section.toLowerCase();
    expect(lowered).toContain("host agent memory");
    expect(lowered).toContain("warp drive");
    expect(lowered).toContain("zero personal authority");
    expect(section).toContain("\u2297 treat host-memory prefs as USER.md");
  });
});
