import { describe, expect, it } from "vitest";
import { isFile, readText } from "./_helpers.js";

const PATH = "patterns/role-as-overlay.md";
const RFC2119_LEGEND = "!=MUST, ~=SHOULD";

describe("test_patterns_role_as_overlay.py", () => {
  it("test_patterns_role_as_overlay_exists", () => {
    expect(isFile(PATH)).toBe(true);
    expect(readText(PATH).trim().length).toBeGreaterThan(0);
  });
  it("test_patterns_role_as_overlay_has_rfc2119_legend", () => {
    expect(readText(PATH)).toContain(RFC2119_LEGEND);
  });
  it("test_patterns_role_as_overlay_cites_issue_number", () => {
    expect(readText(PATH)).toContain("#816");
  });
  for (const heading of [
    "## The principle",
    "## Why this matters",
    "## Precedence",
    "## Implementation contract for skills and agents",
    "### Provider mapping",
    "## Anti-patterns",
    "## Cross-references",
  ]) {
    it(`test_patterns_role_as_overlay_required_sections ${heading}`, () => {
      expect(readText(PATH)).toContain(heading);
    });
  }
  it("test_principle_carries_configuration_not_content_framing", () => {
    const text = readText(PATH).toLowerCase();
    expect(text).toContain("configuration");
    expect(text).toContain("content");
    expect(text).toContain("ephemeral");
  });
  for (const mode of [
    "History pollution",
    "Retrieval corruption",
    "Context rot acceleration",
    "False memory propagation",
    "Resumption breakage",
  ]) {
    it(`test_why_this_matters_enumerates_failure_modes ${mode}`, () => {
      expect(readText(PATH)).toContain(mode);
    });
  }
  for (const token of ["call role", "session role", "agent role"]) {
    it(`test_precedence_chain_tokens_present ${token}`, () => {
      expect(readText(PATH).toLowerCase()).toContain(token);
    });
  }
  it("test_precedence_section_pins_call_greater_than_session_greater_than_agent", () => {
    const text = readText(PATH).toLowerCase();
    expect(
      text.includes("call > session > agent") ||
        text.includes("call role > session role > agent role"),
    ).toBe(true);
  });
  for (const skill of [
    "deft-directive-review-cycle",
    "deft-directive-build",
    "deft-directive-pre-pr",
  ]) {
    it(`test_implementation_contract_names_directive_skills ${skill}`, () => {
      expect(readText(PATH)).toContain(skill);
    });
  }
  for (const token of [
    "Anthropic",
    "OpenAI Chat",
    "OpenAI Responses",
    "Gemini",
    "system_instruction",
    "instructions",
  ]) {
    it(`test_provider_mapping_carries_canonical_surfaces ${token}`, () => {
      expect(readText(PATH)).toContain(token);
    });
  }
  it("test_role_as_overlay_uses_must_and_must_not_tokens", () => {
    const text = readText(PATH);
    expect((text.match(/- ! /g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect((text.match(/- ⊗ /g) ?? []).length).toBeGreaterThanOrEqual(5);
  });
  it("test_role_as_overlay_cross_references_neighbouring_patterns", () => {
    const text = readText(PATH);
    expect(text.includes("patterns/llm-app.md") || text.includes("llm-app.md")).toBe(true);
    expect(text.includes("coding/security.md") || text.includes("security.md")).toBe(true);
    expect(text.includes("patterns/multi-agent.md") || text.includes("multi-agent.md")).toBe(true);
  });
  it("test_references_md_has_role_as_overlay_lazy_load_entry", () => {
    const text = readText("REFERENCES.md");
    expect(text).toContain(PATH);
    expect(text).toContain("#816");
  });
  it("test_references_md_role_as_overlay_under_llm_applications_section", () => {
    const text = readText("REFERENCES.md");
    const marker = "### When Building LLM Applications";
    const sectionIdx = text.indexOf(marker);
    expect(sectionIdx).toBeGreaterThanOrEqual(0);
    const nextSection = text.indexOf("\n### ", sectionIdx + marker.length);
    const section = text.slice(sectionIdx, nextSection === -1 ? undefined : nextSection);
    expect(section).toContain(PATH);
  });
});
