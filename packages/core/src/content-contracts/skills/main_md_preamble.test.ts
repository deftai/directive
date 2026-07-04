import { describe, expect, it } from "vitest";
import { readRepoFile, repoFileExists } from "./helpers.js";

/** Port of tests/content/test_main_md_preamble.py (#1838 #1530) */

const PREAMBLE_MARKER = "<!-- DEFT-PREAMBLE-V1 -->";
// #2022 / #1933 (Option 1, deprecate-by-disuse): canonical carriers (main.md,
// SKILL.md) no longer mandate the frozen `deft-install gate` health probe. The
// DEFT-PREAMBLE carries a cold-start fallback. #2273: the recovery pointer is
// now payload-INDEPENDENT -- it points at the Cold-start bootstrap block at the
// top of the committed `README.md`, NOT at `.deft/core/UPGRADING.md` (the exact
// vendored payload that is absent when recovery is needed). Legacy redirect
// stubs keep the pre-flip `python3 deft/run gate` + `deft/UPGRADING.md` form (#411).
const GATE_INSTRUCTION_CANONICAL = "Cold-start check";
const GATE_INSTRUCTION_LEGACY = "python3 deft/run gate";
const COLD_START_REFERENCE_CANONICAL = "README.md";
const COLD_START_REFERENCE_LEGACY = "deft/UPGRADING.md";

const REDIRECT_STUB_PATHS = ["skills/deft-setup/SKILL.md", "skills/deft-build/SKILL.md"] as const;

const CANONICAL_PATHS = ["main.md", "SKILL.md"] as const;

const REQUIRED_FILES = [...CANONICAL_PATHS, ...REDIRECT_STUB_PATHS];

function expectedGateInstruction(relPath: string): string {
  return REDIRECT_STUB_PATHS.includes(relPath as (typeof REDIRECT_STUB_PATHS)[number])
    ? GATE_INSTRUCTION_LEGACY
    : GATE_INSTRUCTION_CANONICAL;
}

function expectedColdStartReference(relPath: string): string {
  return REDIRECT_STUB_PATHS.includes(relPath as (typeof REDIRECT_STUB_PATHS)[number])
    ? COLD_START_REFERENCE_LEGACY
    : COLD_START_REFERENCE_CANONICAL;
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

  it.each(REQUIRED_FILES)("preamble_references_cold_start_recovery %s", (relPath) => {
    const text = readRepoFile(relPath);
    const head = text.split("\n").slice(0, 12).join("\n");
    const expected = expectedColdStartReference(relPath);
    expect(head).toContain(expected);
  });

  // #2273: the canonical carriers' cold-start recovery pointer must NOT depend
  // on the vendored `.deft/core/` payload (absent exactly when recovery runs).
  it.each(CANONICAL_PATHS)("preamble_cold_start_pointer_is_payload_independent %s", (relPath) => {
    const head = readRepoFile(relPath).split("\n").slice(0, 12).join("\n");
    expect(head).not.toContain(".deft/core/UPGRADING.md");
  });
});
