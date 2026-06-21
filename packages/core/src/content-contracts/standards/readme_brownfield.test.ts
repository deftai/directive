import { describe, expect, it } from "vitest";
import { isFile, readText } from "./_helpers.js";

function readme(): string {
  return readText("README.md");
}

describe("test_readme_brownfield.py", () => {
  describe("TestReadmeVbriefCentric", () => {
    it("test_setup_step_references_vbrief_project_definition", () => {
      expect(readme()).toContain("vbrief/PROJECT-DEFINITION.vbrief.json");
    });
    it("test_scope_vbrief_section_replaces_specification_md_language", () => {
      const content = readme();
      expect(content).toContain("Generate a Scope vBRIEF");
      expect(content).not.toContain("creating a `SPECIFICATION.md`");
    });
    it("test_build_example_reads_project_definition_not_specification", () => {
      const content = readme();
      expect(content).toContain("Read vbrief/PROJECT-DEFINITION.vbrief.json");
      expect(content).not.toContain("Read SPECIFICATION.md and implement");
    });
    it("test_source_of_truth_note_exists", () => {
      const content = readme().toLowerCase();
      expect(content).toContain("source of truth");
      expect(content).toContain("rendered view");
    });
    it("test_rule_precedence_lists_vbrief_files", () => {
      const m = readme().match(/### Rule Hierarchy\s*\n(.+?)(?=\n### |\n## )/s);
      expect(m).not.toBeNull();
      const section = m?.[1] ?? "";
      expect(section).toContain("vbrief/PROJECT-DEFINITION.vbrief.json");
      expect(section).toContain("vbrief/specification.vbrief.json");
    });
    it("test_brownfield_link_from_readme", () => {
      expect(readme()).toContain("docs/BROWNFIELD.md");
    });
  });

  describe("TestBrownfieldGuide", () => {
    it("test_file_exists", () => {
      expect(isFile("docs/BROWNFIELD.md")).toBe(true);
    });
    it("test_covers_install_options", () => {
      const content = readText("docs/BROWNFIELD.md").toLowerCase();
      expect(content).toContain("submodule");
      expect(content.includes("installer") || content.includes("install-")).toBe(true);
    });
    it("test_covers_migrate_vbrief", () => {
      const content = readText("docs/BROWNFIELD.md");
      expect(content).toContain("task migrate:vbrief");
      expect(content.toLowerCase()).toContain("idempotent");
    });
    it("test_covers_rendered_views_semantics", () => {
      const content = readText("docs/BROWNFIELD.md").toLowerCase();
      expect(content).toContain("source of truth");
      expect(content.includes("rendered view") || content.includes("rendered views")).toBe(true);
    });
    it("test_covers_pre_cutover_detection_guard", () => {
      const content = readText("docs/BROWNFIELD.md");
      expect(
        content.includes("Pre-Cutover Detection Guard") ||
          content.toLowerCase().includes("pre-cutover"),
      ).toBe(true);
      expect(content).toContain("<!-- deft:deprecated-redirect -->");
    });
    it("test_covers_post_migration_task_check", () => {
      expect(readText("docs/BROWNFIELD.md")).toContain("task check");
    });
    it("test_covers_prd_spec_ingestion", () => {
      const content = readText("docs/BROWNFIELD.md");
      expect(content.includes("#397") || content.toLowerCase().includes("preserv")).toBe(true);
    });
    it("test_referenced_by_quickstart", () => {
      expect(readText("QUICK-START.md")).toContain("docs/BROWNFIELD.md");
    });
    it("test_rfc2119_legend_present", () => {
      const content = readText("docs/BROWNFIELD.md");
      expect(content.includes("RFC2119") || content.includes("RFC 2119")).toBe(true);
    });
  });
});
