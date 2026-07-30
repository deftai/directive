import { describe, expect, it } from "vitest";
import { isFile, readText } from "./_helpers.js";

function readme(): string {
  return readText("README.md");
}

/**
 * The README "What gets tracked vs ignored" gitignore claim paragraph (#2274).
 * Extracted so its contents can be asserted against the real init/update
 * gitignore behavior (packages/core/src/init-deposit/gitignore.ts).
 */
function gitignoreClaim(): string {
  const content = readme();
  const m = content.match(/\*\*What gets tracked vs ignored:\*\*[\s\S]*?(?=\n\n)/);
  expect(m, "README must carry a 'What gets tracked vs ignored' claim").not.toBeNull();
  return m?.[0] ?? "";
}

describe("test_readme_brownfield.py", () => {
  describe("TestReadmeVbriefCentric", () => {
    // #2907: public README teaches xbrief sole canon (vBRIEF is legacy elsewhere).
    it("test_setup_step_references_vbrief_project_definition", () => {
      expect(readme()).toContain("xbrief/PROJECT-DEFINITION.xbrief.json");
    });
    it("test_scope_vbrief_section_replaces_specification_md_language", () => {
      const content = readme();
      expect(content).toContain("Generate a Scope xBRIEF");
      expect(content).not.toContain("creating a `SPECIFICATION.md`");
    });
    it("test_build_example_reads_project_definition_not_specification", () => {
      const content = readme();
      expect(content).toContain("Read xbrief/PROJECT-DEFINITION.xbrief.json");
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
      expect(section).toContain("xbrief/PROJECT-DEFINITION.xbrief.json");
      expect(section).toContain("xbrief/specification.xbrief.json");
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
      expect(content).toContain("v0.59.0");
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

  // #2274: README/BROWNFIELD/UPGRADING + top-level help all agree on the
  // three-command init/update/doctor model, route users by situation, and the
  // README gitignore claim matches the real init/update behavior.
  describe("TestThreeCommandModel", () => {
    it("test_readme_getting_started_leads_with_npm_then_init", () => {
      const content = readme();
      // The install step leads with the global npm install, then `directive init`.
      const step = content.slice(content.indexOf("### 1. Install and initialize"));
      const npmIdx = step.indexOf("npm i -g @deftai/directive");
      const initIdx = step.indexOf("directive init");
      expect(npmIdx).toBeGreaterThanOrEqual(0);
      expect(initIdx).toBeGreaterThan(npmIdx);
    });

    it("test_readme_routes_by_situation_across_three_commands", () => {
      const content = readme();
      for (const cmd of ["directive init", "directive update", "directive doctor"]) {
        expect(content, `README missing ${cmd}`).toContain(cmd);
      }
    });

    it("test_readme_brownfield_upgrading_agree_on_three_command_model", () => {
      for (const rel of ["README.md", "docs/BROWNFIELD.md", "UPGRADING.md"]) {
        const content = readText(rel);
        for (const cmd of ["directive init", "directive update", "directive doctor"]) {
          expect(content, `${rel} missing ${cmd}`).toContain(cmd);
        }
      }
    });

    it("test_readme_gitignore_claim_matches_reality", () => {
      const claim = gitignoreClaim();
      for (const tok of [
        ".deft/core/",
        ".deft/.cli/",
        "ritual-state.json",
        ".deft-cache/",
        "package.json",
      ]) {
        expect(claim, `gitignore claim missing ${tok}`).toContain(tok);
      }
      // The committed package.json pin is the reconstitution anchor -> tracked,
      // never ignored (packages/core/src/init-deposit/gitignore.ts NEVER_IGNORE_LINES).
      expect(/package\.json[\s\S]*never[\s\S]*ignored/i.test(claim)).toBe(true);
      // The claim no longer says init scaffolds vbrief/.
      expect(claim.toLowerCase()).not.toContain("vbrief/");
    });

    it("test_brownfield_starts_with_directive_init_before_legacy_submodule", () => {
      const content = readText("docs/BROWNFIELD.md");
      const initIdx = content.indexOf("directive init");
      const submoduleIdx = content.toLowerCase().indexOf("submodule");
      expect(initIdx).toBeGreaterThanOrEqual(0);
      expect(submoduleIdx).toBeGreaterThan(initIdx);
    });

    it("test_upgrading_points_ordinary_users_at_directive_update", () => {
      const content = readText("UPGRADING.md");
      expect(content).toContain("directive update");
      expect(content.toLowerCase()).toContain("ordinary");
    });
  });

  // #2197: README / UPGRADING / BROWNFIELD document a first-class pnpm
  // install/upgrade path (same npm registry) plus the PNPM_HOME PATH caveat.
  describe("TestPnpmSupport", () => {
    it("test_readme_documents_pnpm_install_and_path_caveat", () => {
      const content = readme();
      expect(content).toContain("pnpm add -g @deftai/directive");
      expect(content).toContain("PNPM_HOME");
      // Ephemeral pnpm dlx form documented alongside npx.
      expect(content).toContain("pnpm dlx @deftai/directive");
    });

    it("test_upgrading_documents_pnpm_upgrade_one_liner", () => {
      const content = readText("UPGRADING.md");
      expect(content).toContain("pnpm add -g @deftai/directive@latest");
    });

    it("test_brownfield_documents_pnpm_install", () => {
      const content = readText("docs/BROWNFIELD.md");
      expect(content).toContain("pnpm add -g @deftai/directive");
    });
  });
});
