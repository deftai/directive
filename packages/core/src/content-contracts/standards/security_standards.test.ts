import { describe, expect, it } from "vitest";
import { contentAfterBanner, isFile, readText } from "./_helpers.js";

const MAX_LINES = 250;
const _REQUIRED_SECTIONS = [
  "## Universal Requirements",
  "## Input Validation & Injection Prevention",
  "## Authentication & Authorization",
  "## Secrets Management",
  "## Dependency Security",
  "## Agent-Specific Threats",
  "## Anti-Patterns",
] as const;
const _RFC2119_LEGEND_TOKENS = ["!=MUST", "~=SHOULD"] as const;

describe("test_security_standards.py", () => {
  it("test_security_md_exists", () => {
    expect(isFile("coding/security.md")).toBe(true);
  });
  it("test_security_md_line_ceiling", () => {
    expect(readText("coding/security.md").split("\n").length).toBeLessThanOrEqual(MAX_LINES);
  });
  it("test_security_md_rfc2119_legend[!=MUST]", () => {
    const head = contentAfterBanner(readText("coding/security.md"))
      .split("\n")
      .slice(0, 10)
      .join("\n");
    expect(head).toContain("!=MUST");
  });
  it("test_security_md_rfc2119_legend[~=SHOULD]", () => {
    const head = contentAfterBanner(readText("coding/security.md"))
      .split("\n")
      .slice(0, 10)
      .join("\n");
    expect(head).toContain("~=SHOULD");
  });
  it("test_security_md_required_sections_present[## Universal Requirements]", () => {
    expect(readText("coding/security.md")).toContain("## Universal Requirements");
  });
  it("test_security_md_required_sections_present[## Input Validation & Injection Prevention]", () => {
    expect(readText("coding/security.md")).toContain("## Input Validation & Injection Prevention");
  });
  it("test_security_md_required_sections_present[## Authentication & Authorization]", () => {
    expect(readText("coding/security.md")).toContain("## Authentication & Authorization");
  });
  it("test_security_md_required_sections_present[## Secrets Management]", () => {
    expect(readText("coding/security.md")).toContain("## Secrets Management");
  });
  it("test_security_md_required_sections_present[## Dependency Security]", () => {
    expect(readText("coding/security.md")).toContain("## Dependency Security");
  });
  it("test_security_md_required_sections_present[## Agent-Specific Threats]", () => {
    expect(readText("coding/security.md")).toContain("## Agent-Specific Threats");
  });
  it("test_security_md_required_sections_present[## Anti-Patterns]", () => {
    expect(readText("coding/security.md")).toContain("## Anti-Patterns");
  });
  it("test_security_md_carries_must_and_must_not_tokens", () => {
    const text = readText("coding/security.md");
    expect(text).toContain("- ! ");
    expect(text).toContain("- ⊗ ");
  });
  it("test_security_md_secrets_section_crossrefs_codingmd", () => {
    expect(readText("coding/security.md")).toContain("coding.md");
  });
  it("test_coding_md_links_to_security_md", () => {
    const text = readText("coding/coding.md");
    expect(text.includes("coding/security.md") || text.includes("security.md")).toBe(true);
    expect(text).toContain("#661");
  });
  it("test_references_md_registers_security_md", () => {
    expect(readText("REFERENCES.md")).toContain("coding/security.md");
  });
});
