import { describe, expect, it } from "vitest";
import { isFile, readText } from "./_helpers.js";

describe("test_patterns_llm_app.py", () => {
  it("test_patterns_llm_app_exists", () => {
    expect(isFile("patterns/llm-app.md")).toBe(true);
    const text = readText("patterns/llm-app.md");
    expect(text.trim().length).toBeGreaterThan(0);
  });
  it("test_patterns_llm_app_has_rfc2119_legend", () => {
    const text = readText("patterns/llm-app.md");
    expect(text).toContain("!=MUST, ~=SHOULD");
  });
  it("test_patterns_llm_app_cites_issue_number", () => {
    const text = readText("patterns/llm-app.md");
    expect(text).toContain("#481");
  });
  it("test_patterns_llm_app_required_sections[## Prompt construction]", () => {
    const text = readText("patterns/llm-app.md");
    expect(text).toContain("## Prompt construction");
  });
  it("test_patterns_llm_app_required_sections[## Trust tiers]", () => {
    const text = readText("patterns/llm-app.md");
    expect(text).toContain("## Trust tiers");
  });
  it("test_patterns_llm_app_required_sections[## Tool / function calling]", () => {
    const text = readText("patterns/llm-app.md");
    expect(text).toContain("## Tool / function calling");
  });
  it("test_patterns_llm_app_required_sections[## RAG and retrieval]", () => {
    const text = readText("patterns/llm-app.md");
    expect(text).toContain("## RAG and retrieval");
  });
  it("test_patterns_llm_app_required_sections[## Output handling]", () => {
    const text = readText("patterns/llm-app.md");
    expect(text).toContain("## Output handling");
  });
  it("test_patterns_llm_app_required_sections[## Multi-agent and orchestration]", () => {
    const text = readText("patterns/llm-app.md");
    expect(text).toContain("## Multi-agent and orchestration");
  });
  it("test_patterns_llm_app_required_sections[## LLM-specific observability]", () => {
    const text = readText("patterns/llm-app.md");
    expect(text).toContain("## LLM-specific observability");
  });
  it("test_patterns_llm_app_trust_tier_ordering_tokens[system prompt]", () => {
    const text = readText("patterns/llm-app.md");
    expect(text).toContain("system prompt");
  });
  it("test_patterns_llm_app_trust_tier_ordering_tokens[few-shot examples]", () => {
    const text = readText("patterns/llm-app.md");
    expect(text).toContain("few-shot examples");
  });
  it("test_patterns_llm_app_trust_tier_ordering_tokens[user turn]", () => {
    const text = readText("patterns/llm-app.md");
    expect(text).toContain("user turn");
  });
  it("test_patterns_llm_app_trust_tier_ordering_tokens[retrieved content]", () => {
    const text = readText("patterns/llm-app.md");
    expect(text).toContain("retrieved content");
  });
  it("test_patterns_llm_app_trust_tier_ordering_tokens[web / file content]", () => {
    const text = readText("patterns/llm-app.md");
    expect(text).toContain("web / file content");
  });
  it("test_prompt_construction_carries_delimiter_envelope_tokens", () => {
    const text = readText("patterns/llm-app.md");
    // for token in ...
    expect(text).toContain("<user_input>");
    // for token in ...
    expect(text).toContain("<document>");
    // for token in ...
    expect(text).toContain("<tool_result>");
  });
  it("test_tool_calling_carries_confused_deputy_rule", () => {
    const text = readText("patterns/llm-app.md").toLowerCase();
    expect(text).toContain("confused deputy");
  });
  it("test_rag_section_carries_no_writeback_rule", () => {
    const text = readText("patterns/llm-app.md").toLowerCase();
    expect(text.includes("rag poisoning") || text.includes("rag-poisoning")).toBe(true);
    expect(text).toContain("provenance");
  });
  it("test_output_handling_carries_schema_validation_rule", () => {
    const text = readText("patterns/llm-app.md").toLowerCase();
    expect(text).toContain("schema");
    expect(text).toContain("xss");
  });
  it("test_multi_agent_carries_compositional_fragment_rule", () => {
    const text = readText("patterns/llm-app.md").toLowerCase();
    expect(text).toContain("compositional fragment");
  });
  it("test_observability_carries_per_call_audit_log_rule", () => {
    const text = readText("patterns/llm-app.md").toLowerCase();
    expect(text).toContain("audit log");
    expect(text.includes("token count") || text.includes("token budget")).toBe(true);
  });
  it("test_patterns_llm_app_uses_must_and_must_not_tokens", () => {
    const text = readText("patterns/llm-app.md");
    const must_count = text.split("- ! ").length - 1;
    const must_not_count = text.split("- ⊗ ").length - 1;
    expect(must_count >= 5).toBe(true);
    expect(must_not_count >= 5).toBe(true);
  });
  it("test_references_md_carries_lazy_load_trigger", () => {
    const text = readText("REFERENCES.md");
    expect(text).toContain("patterns/llm-app.md");
  });
  it("test_coding_coding_md_carries_addendum", () => {
    const text = readText("coding/coding.md");
    expect(text).toContain("patterns/llm-app.md");
    expect(text).toContain("#481");
  });
  it("test_tools_telemetry_md_carries_llm_observability_section", () => {
    const text = readText("tools/telemetry.md");
    expect(text).toContain("LLM-specific observability");
    expect(text).toContain("patterns/llm-app.md");
    expect(text).toContain("#481");
  });
});
