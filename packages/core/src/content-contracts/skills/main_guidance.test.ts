import { describe, expect, it } from "vitest";
import { readRepoFile } from "./helpers.js";

/** Port of tests/content/test_main_guidance.py (#1838 #1300) */

const BANNED_PHRASES = ["you cancelled", "you stopped", "you declined"] as const;

const SECTION_PATTERN = /^##\s+(?:\d+\.\s+)?Cancellation Attribution[\s\S]*?(?=^##\s|Z)/m;

function extractSection(text: string): string {
  const match = SECTION_PATTERN.exec(text);
  if (!match) {
    throw new Error(
      "Cancellation Attribution section heading not found -- expected a `## Cancellation Attribution` heading",
    );
  }
  return match[0];
}

const mainText = readRepoFile("main.md");
const mainSection = extractSection(mainText);
const preambleText = readRepoFile("templates/agent-prompt-preamble.md");
const preambleSection = extractSection(preambleText);

describe("test_main_guidance", () => {
  it("main_md_has_cancellation_attribution_section", () => {
    expect(/^##\s+Cancellation Attribution\b/m.test(mainText)).toBe(true);
  });

  it("main_md_section_references_issue_1300", () => {
    expect(mainSection).toContain("#1300");
  });

  it.each(["cancelled", "aborted", "killed"])("main_md_names_tool_runtime_signals %s", (signal) => {
    expect(mainSection).toContain(signal);
  });

  it("main_md_names_runtime_failure_classes", () => {
    const candidates = [
      "parallel-batch",
      "parallel batch",
      "network glitch",
      "timeout",
      "5xx",
      "server",
    ];
    const found = candidates.filter((c) => mainSection.toLowerCase().includes(c.toLowerCase()));
    expect(found.length).toBeGreaterThan(0);
  });

  it("main_md_requires_sequential_retry", () => {
    expect(/retry.*sequential/is.test(mainSection) || /sequential.*retry/is.test(mainSection)).toBe(
      true,
    );
  });

  it.each(BANNED_PHRASES)("main_md_bans_you_cancelled_phrasing %s", (phrase) => {
    expect(mainSection).toContain(phrase);
    const mustNotLines = mainSection.split("\n").filter((line) => /^\s*(?:-\s+)?⊗\s/.test(line));
    expect(mustNotLines.join("\n")).toContain(phrase);
  });

  it("main_md_section_contains_must_layer", () => {
    expect(/^-\s+!\s/m.test(mainSection)).toBe(true);
    expect(/^-\s+⊗\s/m.test(mainSection)).toBe(true);
  });

  it("main_md_section_references_preamble_propagation", () => {
    expect(mainSection).toContain("templates/agent-prompt-preamble.md");
  });

  it("preamble_has_cancellation_attribution_section", () => {
    expect(preambleText).toContain("Cancellation Attribution");
  });

  it("preamble_section_references_issue_1300", () => {
    expect(preambleSection).toContain("#1300");
  });

  it.each([
    "cancelled",
    "aborted",
    "killed",
  ])("preamble_names_tool_runtime_signals %s", (signal) => {
    expect(preambleSection).toContain(signal);
  });

  it("preamble_requires_sequential_retry", () => {
    expect(
      /retry.*sequential/is.test(preambleSection) || /sequential.*retry/is.test(preambleSection),
    ).toBe(true);
  });

  it.each(BANNED_PHRASES)("preamble_bans_you_cancelled_phrasing %s", (phrase) => {
    expect(preambleSection).toContain(phrase);
    const prohibitionSignal = /(?:⊗|MUST NOT|must not|[Ff]orbidden)/;
    const phraseLines = preambleSection.split("\n").filter((line) => line.includes(phrase));
    expect(phraseLines.length).toBeGreaterThan(0);
    expect(phraseLines.some((line) => prohibitionSignal.test(line))).toBe(true);
  });

  it("preamble_cross_references_main_md", () => {
    expect(preambleSection).toContain("main.md");
  });
});
