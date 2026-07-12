import { describe, expect, it } from "vitest";
import { readRepoFile, repoFileExists } from "./helpers.js";

/** Port of tests/content/test_main_md_preamble.py (#1838 #1530) */

const PREAMBLE_MARKER = "<!-- DEFT-PREAMBLE-V1 -->";
// #2022 / #1933 (Option 1, deprecate-by-disuse): canonical carriers (main.md,
// SKILL.md) no longer mandate the frozen `deft-install gate` health probe. The
// DEFT-PREAMBLE carries a cold-start fallback. #2273: the recovery pointer is
// now payload-INDEPENDENT -- it points at the Cold-start bootstrap block at the
// top of the committed `README.md`, NOT at `.deft/core/UPGRADING.md` (the exact
// vendored payload that is absent when recovery is needed).
const GATE_INSTRUCTION_CANONICAL = "Cold-start check";
const COLD_START_REFERENCE_CANONICAL = "README.md";

const CANONICAL_PATHS = ["main.md", "SKILL.md"] as const;

describe("test_main_md_preamble", () => {
  it.each(CANONICAL_PATHS)("file_exists %s", (relPath) => {
    expect(repoFileExists(relPath)).toBe(true);
  });

  it.each(CANONICAL_PATHS)("preamble_marker_at_line_one %s", (relPath) => {
    const firstLine = readRepoFile(relPath).split("\n")[0] ?? "";
    expect(firstLine.trim()).toBe(PREAMBLE_MARKER);
  });

  it.each(CANONICAL_PATHS)("preamble_includes_gate_instruction %s", (relPath) => {
    const text = readRepoFile(relPath);
    const head = text.split("\n").slice(0, 12).join("\n");
    expect(head).toContain(GATE_INSTRUCTION_CANONICAL);
  });

  it.each(CANONICAL_PATHS)("preamble_references_cold_start_recovery %s", (relPath) => {
    const text = readRepoFile(relPath);
    const head = text.split("\n").slice(0, 12).join("\n");
    expect(head).toContain(COLD_START_REFERENCE_CANONICAL);
  });

  // #2273: the canonical carriers' cold-start recovery pointer must NOT depend
  // on the vendored `.deft/core/` payload (absent exactly when recovery runs).
  it.each(CANONICAL_PATHS)("preamble_cold_start_pointer_is_payload_independent %s", (relPath) => {
    const head = readRepoFile(relPath).split("\n").slice(0, 12).join("\n");
    expect(head).not.toContain(".deft/core/UPGRADING.md");
  });
});
