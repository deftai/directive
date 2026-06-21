import { describe, expect, it } from "vitest";
import { isFile, readText } from "./_helpers.js";

const PATH = "patterns/prompt-assembly-layer-ordering.md";
const RFC2119_LEGEND = "!=MUST, ~=SHOULD";
const REQUIRED_SECTIONS = [
  "## The invariant",
  "## Cached prefix -- assembled once at session start",
  "## Ephemeral injection -- rebuilt on every API call",
  "## Why this matters for directive",
  "## Observability",
  "## Anti-patterns",
  "## Cross-references",
] as const;
const CACHED_PREFIX_FRAGMENTS = [
  "Agent identity",
  "Tool-aware behaviour guidance",
  "Frozen memory snapshot",
  "Skills index",
  "Context files",
  "Session timestamp",
] as const;

describe("test_patterns_prompt_assembly.py", () => {
  it("test_patterns_file_exists", () => {
    expect(isFile(PATH)).toBe(true);
    expect(readText(PATH).trim().length).toBeGreaterThan(0);
  });
  it("test_patterns_file_has_rfc2119_legend", () => {
    expect(readText(PATH)).toContain(RFC2119_LEGEND);
  });
  it("test_patterns_file_cites_issue_number", () => {
    expect(readText(PATH)).toContain("#836");
  });
  for (const heading of REQUIRED_SECTIONS) {
    it(`test_patterns_file_required_sections ${heading}`, () => {
      expect(readText(PATH)).toContain(heading);
    });
  }
  it("test_invariant_section_carries_the_per_turn_rule", () => {
    const text = readText(PATH).toLowerCase();
    expect(text).toContain("per-turn");
    expect(text).toContain("ephemeral");
    expect(text).toContain("cached");
  });
  for (const fragment of CACHED_PREFIX_FRAGMENTS) {
    it(`test_cached_prefix_fragments_enumerated ${fragment}`, () => {
      expect(readText(PATH)).toContain(fragment);
    });
  }
  it("test_ordering_rule_present", () => {
    const text = readText(PATH).toLowerCase();
    expect(text.includes("most-stable") || text.includes("most stable")).toBe(true);
  });
  it("test_cached_prefix_fragments_are_in_most_stable_first_order", () => {
    const text = readText(PATH);
    const indices = CACHED_PREFIX_FRAGMENTS.map((name) => text.indexOf(name));
    expect(indices.every((idx) => idx >= 0)).toBe(true);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });
  it("test_frozen_memory_snapshot_cross_reference", () => {
    expect(readText(PATH)).toContain("#832");
  });
  it("test_llm_app_cross_reference", () => {
    expect(readText(PATH)).toContain("patterns/llm-app.md");
  });
  it("test_role_as_overlay_cross_reference", () => {
    expect(readText(PATH)).toContain("#816");
  });
  it("test_patterns_file_uses_must_and_must_not_tokens", () => {
    const text = readText(PATH);
    expect((text.match(/- ! /g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect((text.match(/- ⊗ /g) ?? []).length).toBeGreaterThanOrEqual(5);
  });
  it("test_references_md_carries_lazy_load_trigger", () => {
    const text = readText("REFERENCES.md");
    expect(text).toContain(PATH);
    expect(text).toContain("#836");
  });
});
