import { describe, expect, it } from "vitest";
import { readAgentsMd, returningSessionsSection } from "./helpers.js";

/** Port of tests/content/test_agents_md.py (#1838 #1530) */

describe("test_agents_md", () => {
  it("agents_md_headless_bypass_present", () => {
    const text = readAgentsMd();
    expect(text.toLowerCase()).toContain("headless bypass");
  });

  it("agents_md_headless_bypass_before_user_md_check", () => {
    const text = readAgentsMd();
    const bypassPos = text.toLowerCase().indexOf("headless bypass");
    const userMdPos = text.indexOf("USER.md missing");
    expect(bypassPos).not.toBe(-1);
    expect(userMdPos).not.toBe(-1);
    expect(bypassPos).toBeLessThan(userMdPos);
  });

  it("agents_md_headless_bypass_mentions_cloud_agent", () => {
    const text = readAgentsMd();
    expect(text.toLowerCase()).toContain("cloud agent");
  });

  it("agents_md_before_code_changes_must_markers", () => {
    const text = readAgentsMd();
    expect(text).toContain("! Check `./vbrief/` lifecycle folders");
  });

  it("agents_md_pre_implementation_anti_pattern", () => {
    const text = readAgentsMd();
    expect(text).toContain("\u2297");
    expect(text.toLowerCase()).toContain("editing files before");
  });

  it("agents_md_deft_alignment_confirmation_rule", () => {
    const text = readAgentsMd();
    expect(text.toLowerCase()).toContain("deft directive active");
  });

  it("agents_md_deft_alignment_context_reset_recovery", () => {
    const text = readAgentsMd();
    expect(
      text.toLowerCase().includes("context window") || text.toLowerCase().includes("re-confirm"),
    ).toBe(true);
  });

  it("agents_md_deft_alignment_anti_pattern", () => {
    const text = readAgentsMd();
    expect(text).toContain("\u2297");
    expect(text.toLowerCase()).toContain("confirming deft alignment");
  });

  it("agents_md_skill_completion_gate_rule", () => {
    const text = readAgentsMd();
    expect(text.toLowerCase()).toContain("skill completion gate");
  });

  it("agents_md_skill_completion_gate_chaining", () => {
    const text = readAgentsMd();
    expect(text.toLowerCase()).toContain("chains to");
  });

  it("agents_md_returning_sessions_has_must_marker", () => {
    const section = returningSessionsSection();
    expect(section).toContain("! When all config exists");
  });

  it("agents_md_returning_sessions_anti_pattern_present", () => {
    const section = returningSessionsSection();
    expect(section).toContain("\u2297");
    expect(section.toLowerCase()).toContain("test-path");
  });

  it("agents_md_alignment_requires_name_echo", () => {
    const text = readAgentsMd();
    const lowered = text.toLowerCase();
    expect(lowered).toContain("addressing-name");
    expect(lowered).toContain("addressing you as");
    expect(text).toContain("\u2297");
    expect(lowered).toContain("presence");
  });

  it("agents_md_external_context_precedence_documented", () => {
    const section = returningSessionsSection();
    const lowered = section.toLowerCase();
    expect(lowered).toContain("personal (always wins)");
    expect(lowered).toContain("external context");
  });
});
