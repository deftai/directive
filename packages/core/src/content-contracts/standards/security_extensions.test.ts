import { describe, expect, it } from "vitest";
import { isFile, readText } from "./_helpers.js";

const NEW_SECTION_HEADINGS = [
  "## No-Read-Secret Rule for Agent Systems (#587)",
  "## Tool-Call Safety Is Independent of Text-Level Safety (#686)",
  "## Destructive-Op Guardrails -- Environment Isolation + Irreversibility (#708)",
  "### Environment Isolation Gate",
  "### Irreversibility Gate",
] as const;

function locateSection(text: string, heading: string): number {
  const idx = text.indexOf(`\n${heading}`);
  expect(idx).toBeGreaterThanOrEqual(0);
  return idx;
}

describe("test_security_extensions.py", () => {
  for (const heading of NEW_SECTION_HEADINGS) {
    it(`test_security_md_new_section_heading_present ${heading}`, () => {
      expect(readText("coding/security.md")).toContain(heading);
    });
  }

  it("test_no_read_secret_rule_section_present", () => {
    const text = readText("coding/security.md");
    const start = locateSection(text, "## No-Read-Secret Rule for Agent Systems (#587)");
    const section = text.slice(start, start + 2500);
    for (const token of [
      "secret manager",
      "credential proxy",
      "Scope each credential",
      "per-identity",
    ]) {
      expect(section).toContain(token);
    }
    expect(section).toContain("- ! ");
    expect(section).toContain("- ⊗ ");
    expect(section).toContain("coding.md");
  });

  it("test_tool_call_safety_rule_section_present", () => {
    const text = readText("coding/security.md");
    const start = locateSection(
      text,
      "## Tool-Call Safety Is Independent of Text-Level Safety (#686)",
    );
    const section = text.slice(start, start + 2500);
    for (const token of [
      "constraint tier",
      "read-only",
      "reversible",
      "irreversible",
      "destructive",
      "Audit-log",
      "preflight",
    ]) {
      expect(section).toContain(token);
    }
    expect(section).toContain("- ! ");
    expect(section).toContain("- ⊗ ");
    expect(section.includes("Cartagena") || /https:\/\/arxiv\.org\/abs\//.test(section)).toBe(true);
  });

  it("test_destructive_op_guardrails_section_present", () => {
    const text = readText("coding/security.md");
    const start = locateSection(
      text,
      "## Destructive-Op Guardrails -- Environment Isolation + Irreversibility (#708)",
    );
    const section = text.slice(start, start + 4000);
    const sectionLower = section.toLowerCase();
    for (const token of [
      "### Environment Isolation Gate",
      "connection-string",
      "refuse the operation",
      "### Irreversibility Gate",
      "DROP",
      "TRUNCATE",
      "rollback path",
      "ack token",
      "Backups are first-class state",
      "PocketOS",
      "incidents/2026-04-pocketos-railway-prod-db-wipe.md",
    ]) {
      expect(section).toContain(token);
    }
    expect(sectionLower).toContain("trusted, non-prompt signal");
    expect(section).toContain("- ! ");
    expect(section).toContain("- ⊗ ");
  });

  it("test_incidents_library_files_exist", () => {
    expect(isFile("incidents/README.md")).toBe(true);
    expect(isFile("incidents/_template.md")).toBe(true);
    expect(isFile("incidents/2026-04-pocketos-railway-prod-db-wipe.md")).toBe(true);
  });

  it("test_incidents_readme_documents_entry_format", () => {
    const text = readText("incidents/README.md");
    for (const token of [
      "Entry format",
      "Root cause",
      "Which Deft rule(s) would have intervened",
      "Eval / regression coverage",
    ]) {
      expect(text).toContain(token);
    }
  });

  it("test_incidents_library_seed_entry_present", () => {
    const text = readText("incidents/2026-04-pocketos-railway-prod-db-wipe.md");
    for (const token of [
      "PocketOS",
      "Railway",
      "Environment Isolation Gate",
      "Irreversibility Gate",
      "#708",
      "#686",
      "#587",
      "coding/security.md",
    ]) {
      expect(text).toContain(token);
    }
  });
});
