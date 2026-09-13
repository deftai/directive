import { describe, expect, it } from "vitest";
import { readRepoFile } from "./helpers.js";

/** Port of tests/content/test_emit_hints.py (#1838 #1530) */

const _HELPER_REL = "strategies/emit-hints.md";
const _STRATEGY_FILES = [
  "strategies/bdd.md",
  "strategies/discuss.md",
  "strategies/research.md",
  "strategies/map.md",
  "strategies/probe.md",
  "strategies/interview.md",
  "strategies/yolo.md",
  "strategies/rapid.md",
  "strategies/enterprise.md",
  "strategies/speckit.md",
];
const _HELPER_LINK = "](./emit-hints.md";

function _read(relpath: string) {
  return readRepoFile(relpath);
}

describe("test_emit_hints", () => {
  it.each([
    "strategies/bdd.md",
    "strategies/discuss.md",
    "strategies/research.md",
    "strategies/map.md",
    "strategies/probe.md",
    "strategies/interview.md",
    "strategies/yolo.md",
    "strategies/rapid.md",
    "strategies/enterprise.md",
    "strategies/speckit.md",
  ])("strategy_references_emit_hints %s", (strategy_rel) => {
    const text = readRepoFile(strategy_rel);
    expect(text).toContain(_HELPER_LINK);
  });
  it.each([
    "strategies/bdd.md",
    "strategies/discuss.md",
    "strategies/research.md",
    "strategies/map.md",
    "strategies/probe.md",
    "strategies/interview.md",
    "strategies/yolo.md",
    "strategies/rapid.md",
    "strategies/enterprise.md",
    "strategies/speckit.md",
  ])("reference_is_near_emission_step %s", (strategy_rel) => {
    const text = readRepoFile(strategy_rel);
    const emission_markers = ["xbrief/proposed/", "xbrief/pending/", "proposed/", "pending/"];
    const first_emission = Math.min(emission_markers.every((m) => text.indexOf(m)));
    expect(first_emission).not.toBe(-1);
    const link_idx = text.indexOf(_HELPER_LINK);
    expect(link_idx).not.toBe(-1);
    expect(link_idx).toBeGreaterThan(first_emission);
  });

  it("setup Phase 3 offers emit-hints at the proposed/ emission step (#4426)", () => {
    const text = readRepoFile("skills/deft-directive-setup/SKILL.md");
    expect(text).toContain("](../../strategies/emit-hints.md");
    expect(text).toContain("none / `--umbrella` / `--per-vbrief`");
    expect(text).toContain("⊗ Agent-asserted `parent_issue`");
    const emission = text.indexOf("xbrief/proposed/");
    const link = text.indexOf("](../../strategies/emit-hints.md");
    expect(emission).not.toBe(-1);
    expect(link).toBeGreaterThan(emission);
  });

  it("setup Add-scope branch names emit-hints in the post-write sequence (#4426)", () => {
    const text = readRepoFile("skills/deft-directive-setup/SKILL.md");
    const addScope = text.indexOf("! If **Add scope**:");
    expect(addScope).not.toBe(-1);
    const addScopeLine = text.slice(addScope, text.indexOf("\n", addScope));
    expect(addScopeLine).toContain("Issue-emit hints");
    expect(addScopeLine).toContain("Lifecycle Bridge");
  });
});
