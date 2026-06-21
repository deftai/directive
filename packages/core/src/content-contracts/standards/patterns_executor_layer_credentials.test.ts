import { describe, expect, it } from "vitest";
import { isFile, readText } from "./_helpers.js";

describe("test_patterns_executor_layer_credentials.py", () => {
  it("test_patterns_executor_layer_credentials_exists", () => {
    expect(isFile("patterns/executor-layer-credentials.md")).toBe(true);
    const text = readText("patterns/executor-layer-credentials.md");
    expect(text.trim().length).toBeGreaterThan(0);
  });
  it("test_patterns_executor_layer_credentials_has_rfc2119_legend", () => {
    const text = readText("patterns/executor-layer-credentials.md");
    expect(text).toContain("!=MUST, ~=SHOULD");
  });
  it("test_patterns_executor_layer_credentials_cites_required_issues[#587]", () => {
    const text = readText("patterns/executor-layer-credentials.md");
    expect(text).toContain("#587");
  });
  it("test_patterns_executor_layer_credentials_cites_required_issues[#686]", () => {
    const text = readText("patterns/executor-layer-credentials.md");
    expect(text).toContain("#686");
  });
  it("test_patterns_executor_layer_credentials_cites_required_issues[#806]", () => {
    const text = readText("patterns/executor-layer-credentials.md");
    expect(text).toContain("#806");
  });
  it("test_patterns_executor_layer_credentials_required_sections[## The principle]", () => {
    const text = readText("patterns/executor-layer-credentials.md");
    expect(text).toContain("## The principle");
  });
  it("test_patterns_executor_layer_credentials_required_sections[## Implementation-agnostic examples]", () => {
    const text = readText("patterns/executor-layer-credentials.md");
    expect(text).toContain("## Implementation-agnostic examples");
  });
  it("test_patterns_executor_layer_credentials_required_sections[### CLI tools]", () => {
    const text = readText("patterns/executor-layer-credentials.md");
    expect(text).toContain("### CLI tools");
  });
  it("test_patterns_executor_layer_credentials_required_sections[### HTTP APIs]", () => {
    const text = readText("patterns/executor-layer-credentials.md");
    expect(text).toContain("### HTTP APIs");
  });
  it("test_patterns_executor_layer_credentials_required_sections[### SDKs]", () => {
    const text = readText("patterns/executor-layer-credentials.md");
    expect(text).toContain("### SDKs");
  });
  it("test_patterns_executor_layer_credentials_required_sections[### MCP servers]", () => {
    const text = readText("patterns/executor-layer-credentials.md");
    expect(text).toContain("### MCP servers");
  });
  it("test_patterns_executor_layer_credentials_required_sections[### Shells and arbitrary subprocesses]", () => {
    const text = readText("patterns/executor-layer-credentials.md");
    expect(text).toContain("### Shells and arbitrary subprocesses");
  });
  it("test_patterns_executor_layer_credentials_required_sections[## Operator runbook]", () => {
    const text = readText("patterns/executor-layer-credentials.md");
    expect(text).toContain("## Operator runbook");
  });
  it("test_patterns_executor_layer_credentials_required_sections[## Anti-patterns]", () => {
    const text = readText("patterns/executor-layer-credentials.md");
    expect(text).toContain("## Anti-patterns");
  });
  it("test_patterns_executor_layer_credentials_required_sections[## Cross-references]", () => {
    const text = readText("patterns/executor-layer-credentials.md");
    expect(text).toContain("## Cross-references");
  });
  it("test_principle_enumerates_three_wrong_placements", () => {
    const text = readText("patterns/executor-layer-credentials.md").toLowerCase();
    expect(text).toContain("prompt");
    expect(text).toContain("file");
    expect(text).toContain("environment variable");
  });
  it("test_invocation_layer_phrase_is_load_bearing", () => {
    const text = readText("patterns/executor-layer-credentials.md").toLowerCase();
    expect(text).toContain("invocation layer");
  });
  it("test_capability_vs_credential_distinction_is_present", () => {
    const text = readText("patterns/executor-layer-credentials.md").toLowerCase();
    expect(text.includes("capability") && text.includes("credential")).toBe(true);
  });
  it("test_examples_cover_four_canonical_surfaces", () => {
    const text = readText("patterns/executor-layer-credentials.md");
    // for surface in ...
    expect(text).toContain("### CLI tools");
    // for surface in ...
    expect(text).toContain("### HTTP APIs");
    // for surface in ...
    expect(text).toContain("### SDKs");
    // for surface in ...
    expect(text).toContain("### MCP servers");
  });
  it("test_flue_sdk_canonical_example_is_cited", () => {
    const text = readText("patterns/executor-layer-credentials.md");
    expect(text).toContain("defineCommand");
  });
  it("test_patterns_executor_uses_must_and_must_not_tokens", () => {
    const text = readText("patterns/executor-layer-credentials.md");
    const must_count = text.split("! MUST").length - 1;
    const must_not_count = text.split("- ⊗ ").length - 1;
    expect(must_count >= 5).toBe(true);
    expect(must_not_count >= 5).toBe(true);
  });
  it("test_cross_references_to_security_md", () => {
    const text = readText("patterns/executor-layer-credentials.md");
    expect(text).toContain("coding/security.md");
  });
  it("test_cross_references_to_sibling_patterns", () => {
    const text = readText("patterns/executor-layer-credentials.md");
    // for sibling in ...
    expect(text).toContain("patterns/llm-app.md");
    // for sibling in ...
    expect(text).toContain("patterns/multi-agent.md");
  });
});
