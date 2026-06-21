import { describe, expect, it } from "vitest";
import { isFile, readText } from "./_helpers.js";

const REQUIRED_FIELDS = [
  "Applies when",
  "Safe to auto-run",
  "Restart required",
  "Commands",
] as const;
const SECTION_HEADING_RE = /^## From .+? (?:->|→) .+?$/gm;

function splitSections(text: string): Array<[string, string]> {
  const matches = [...text.matchAll(SECTION_HEADING_RE)];
  const sections: Array<[string, string]> = [];
  for (let idx = 0; idx < matches.length; idx += 1) {
    const m = matches[idx];
    if (!m?.index && m?.index !== 0) continue;
    const heading = m[0];
    const start = m.index + heading.length;
    const nextIndex = matches[idx + 1]?.index;
    const end = nextIndex !== undefined ? nextIndex : text.length;
    sections.push([heading, text.slice(start, end)]);
  }
  return sections;
}

describe("test_upgrading_sections.py", () => {
  it("test_upgrading_file_exists", () => {
    expect(isFile("UPGRADING.md")).toBe(true);
  });
  it("test_at_least_one_upgrade_section_present", () => {
    expect(splitSections(readText("UPGRADING.md")).length).toBeGreaterThan(0);
  });
  it("test_every_section_has_four_field_header", () => {
    const failures: string[] = [];
    for (const [heading, body] of splitSections(readText("UPGRADING.md"))) {
      const missing = REQUIRED_FIELDS.filter(
        (f) => !body.includes(`**${f}:**`) && !body.includes(`${f}:`),
      );
      if (missing.length) failures.push(`${heading.trim()} -> missing: ${missing.join(", ")}`);
    }
    expect(failures).toEqual([]);
  });
  it("test_managed_section_legacy_migration_section_present", () => {
    const sections = splitSections(readText("UPGRADING.md"));
    const matching = sections.filter(
      ([h, _b]) => h.includes("#768") || h.toLowerCase().includes("managed-section"),
    );
    expect(matching.length).toBeGreaterThan(0);
    const body = matching[0]?.[1] ?? "";
    for (const tok of [
      "<!-- deft:managed-section v1 -->",
      "agents-md=missing",
      ".deft/core/run agents:refresh",
      "one-time",
      "sentinel-only",
      "templates/agents-entry.md",
      "QUICK-START.md",
      "Case G",
    ]) {
      expect(body).toContain(tok);
    }
  });
});
