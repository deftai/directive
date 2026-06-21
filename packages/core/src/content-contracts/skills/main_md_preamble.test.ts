import { describe, expect, it } from "vitest";
import { readRepoFile, repoFileExists } from "./helpers.js";

/** Port of tests/content/test_main_md_preamble.py (#1838 #1530) */

const PREAMBLE_MARKER = "<!-- DEFT-PREAMBLE-V1 -->";
const GATE_INSTRUCTION_CANONICAL = "python3 .deft/core/run gate";
const GATE_INSTRUCTION_LEGACY = "python3 deft/run gate";
const UPGRADING_REFERENCE_CANONICAL = ".deft/core/UPGRADING.md";
const UPGRADING_REFERENCE_LEGACY = "deft/UPGRADING.md";

const REDIRECT_STUB_PATHS = ["skills/deft-setup/SKILL.md", "skills/deft-build/SKILL.md"] as const;

const CANONICAL_PATHS = ["main.md", "SKILL.md"] as const;

const REQUIRED_FILES = [...CANONICAL_PATHS, ...REDIRECT_STUB_PATHS];

function expectedGateInstruction(relPath: string): string {
  return REDIRECT_STUB_PATHS.includes(relPath as (typeof REDIRECT_STUB_PATHS)[number])
    ? GATE_INSTRUCTION_LEGACY
    : GATE_INSTRUCTION_CANONICAL;
}

function expectedUpgradingReference(relPath: string): string {
  return REDIRECT_STUB_PATHS.includes(relPath as (typeof REDIRECT_STUB_PATHS)[number])
    ? UPGRADING_REFERENCE_LEGACY
    : UPGRADING_REFERENCE_CANONICAL;
}

describe("test_main_md_preamble", () => {
  it.each(REQUIRED_FILES)("file_exists %s", (relPath) => {
    expect(repoFileExists(relPath)).toBe(true);
  });

  it.each(REQUIRED_FILES)("preamble_marker_at_line_one %s", (relPath) => {
    const firstLine = readRepoFile(relPath).split("\n")[0] ?? "";
    expect(firstLine.trim()).toBe(PREAMBLE_MARKER);
  });

  it.each(REQUIRED_FILES)("preamble_includes_gate_instruction %s", (relPath) => {
    const text = readRepoFile(relPath);
    const head = text.split("\n").slice(0, 12).join("\n");
    const expected = expectedGateInstruction(relPath);
    expect(head).toContain(expected);
  });

  it.each(REQUIRED_FILES)("preamble_references_upgrading_doc %s", (relPath) => {
    const text = readRepoFile(relPath);
    const head = text.split("\n").slice(0, 12).join("\n");
    const expected = expectedUpgradingReference(relPath);
    expect(head).toContain(expected);
  });
});
