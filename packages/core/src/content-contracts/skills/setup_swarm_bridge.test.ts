import { describe, expect, it } from "vitest";
import { readRepoFile, readSkill } from "./helpers.js";

/** Port of tests/content/test_setup_swarm_bridge.py (#1838 #1530) */

const _SWARM_PATH = "skills/deft-directive-swarm/SKILL.md";
const _SETUP_PATH = "skills/deft-directive-setup/SKILL.md";
const _SWARM_STEP0_5_MUST_TOKENS = [
  "### Step 0.5: Lifecycle Bridge",
  "#1025",
  "vbrief/proposed/",
  "vbrief/pending/",
  "vbrief/active/",
  "task scope:promote",
  "task scope:activate",
  "skills/deft-directive-setup/SKILL.md",
  "skills/deft-directive-refinement/SKILL.md",
  "scripts/scope_lifecycle.py",
  "Invalid transition",
];
const _SWARM_STEP0_5_MUST_NOT_TOKENS = [
  "⊗",
  "Auto-promote",
  "without explicit user approval",
  "Skip the lifecycle bridge",
  "outside the user's stated swarm scope",
];
const _SWARM_ANTI_PATTERN_TOKENS = ["#1025", "Phase 0 Step 0.5", "lifecycle bridge", "⊗"];
const _SETUP_BRIDGE_TOKENS = [
  "### Lifecycle Bridge to Downstream Skills",
  "#1025",
  "vbrief/proposed/",
  "vbrief/active/",
  "task scope:promote",
  "task scope:activate",
  "skills/deft-directive-swarm/SKILL.md",
  "Phase 0 Step 0.5",
  "skills/deft-directive-refinement/SKILL.md",
  "scripts/scope_lifecycle.py",
  "⊗",
  "Auto-run",
];

function _read_skill(rel_path: string) {
  return readRepoFile(rel_path);
}

function _swarm_step0_5_block(text: string) {
  const start = text.indexOf("### Step 0.5: Lifecycle Bridge");
  expect(start).not.toBe(-1);
  const end = text.indexOf("### Step 1: Read Project State", start);
  expect(end).not.toBe(-1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

function _setup_phase3_bridge_block(text: string) {
  const start = text.indexOf("### Lifecycle Bridge to Downstream Skills");
  expect(start).not.toBe(-1);
  const end = text.indexOf("### End-of-Phase-3 Export Prompt", start);
  expect(end).not.toBe(-1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe("test_setup_swarm_bridge", () => {
  it.each([
    "### Step 0.5: Lifecycle Bridge",
    "#1025",
    "vbrief/proposed/",
    "vbrief/pending/",
    "vbrief/active/",
    "task scope:promote",
    "task scope:activate",
    "skills/deft-directive-setup/SKILL.md",
    "skills/deft-directive-refinement/SKILL.md",
    "scripts/scope_lifecycle.py",
    "Invalid transition",
  ])("swarm_step0_5_must_tokens_present %s", (token) => {
    const block = _swarm_step0_5_block(readSkill(_SWARM_PATH));
    expect(block).toContain(token);
  });
  it.each([
    "⊗",
    "Auto-promote",
    "without explicit user approval",
    "Skip the lifecycle bridge",
    "outside the user's stated swarm scope",
  ])("swarm_step0_5_must_not_tokens_present %s", (token) => {
    const block = _swarm_step0_5_block(readSkill(_SWARM_PATH));
    expect(block).toContain(token);
  });
  it("swarm_step0_5_bridge_uses_canonical_glyph", () => {
    const block = _swarm_step0_5_block(readSkill(_SWARM_PATH));
    expect(block).not.toContain("Γèù");
  });
  it.each([
    "#1025",
    "Phase 0 Step 0.5",
    "lifecycle bridge",
    "⊗",
  ])("swarm_anti_patterns_1025_bullet_tokens_present %s", (token) => {
    const text = readSkill(_SWARM_PATH);
    const anti_start = text.indexOf("## Anti-Patterns");
    expect(anti_start).not.toBe(-1);
    const anti_block = text.slice(anti_start, undefined);
    expect(anti_block).toContain(token);
  });
  it("swarm_anti_patterns_1025_bullet_is_prohibition", () => {
    const text = readSkill(_SWARM_PATH);
    const anti_start = text.indexOf("## Anti-Patterns");
    expect(anti_start).not.toBe(-1);
    const anti_block = text.slice(anti_start, undefined);
    let found = false;
    for (const line of anti_block.split("\n")) {
      if (line.includes("#1025") && line.includes("lifecycle bridge")) {
        expect(line).toContain("⊗");
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });
  it.each([
    "### Lifecycle Bridge to Downstream Skills",
    "#1025",
    "vbrief/proposed/",
    "vbrief/active/",
    "task scope:promote",
    "task scope:activate",
    "skills/deft-directive-swarm/SKILL.md",
    "Phase 0 Step 0.5",
    "skills/deft-directive-refinement/SKILL.md",
    "scripts/scope_lifecycle.py",
    "⊗",
    "Auto-run",
  ])("setup_phase3_bridge_tokens_present %s", (token) => {
    const block = _setup_phase3_bridge_block(readSkill(_SETUP_PATH));
    expect(block).toContain(token);
  });
  it("setup_phase3_bridge_uses_canonical_glyph", () => {
    const block = _setup_phase3_bridge_block(readSkill(_SETUP_PATH));
    expect(block).not.toContain("Γèù");
  });
  it("swarm_phase0_5_references_setup_skill", () => {
    const block = _swarm_step0_5_block(readSkill(_SWARM_PATH));
    expect(block).toContain("skills/deft-directive-setup/SKILL.md");
  });
  it("setup_phase3_bridge_references_swarm_skill", () => {
    const block = _setup_phase3_bridge_block(readSkill(_SETUP_PATH));
    expect(block).toContain("skills/deft-directive-swarm/SKILL.md");
  });
});
