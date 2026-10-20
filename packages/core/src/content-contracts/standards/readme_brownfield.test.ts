import { describe, expect, it } from "vitest";
import { isFile, readText } from "./_helpers.js";

function readme(): string {
  return readText("README.md");
}

/**
 * The README tracked-vs-ignored claim (#2274 / OVPR #5490).
 * Tip teaches the runtime pin + owned wiring as committed, and
 * node_modules / per-checkout wiring-ready as ignored — no copied .deft/core.
 */
function gitignoreClaim(): string {
  const content = readme();
  const m = content.match(/\*\*Tracked vs ignored:\*\*[\s\S]*?(?=\n\n|\n>)/);
  expect(m, "README must carry a 'Tracked vs ignored' claim").not.toBeNull();
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
    it("test_names_process_only_keep_phase_2_identity", () => {
      const content = readText("docs/BROWNFIELD.md");
      expect(content).toContain("Process-only (keep Phase 2 identity)");
      expect(content.toLowerCase()).toContain("cache/queue");
      expect(content.toLowerCase()).toContain("docs stay described content");
      expect(content.toLowerCase()).not.toContain("docs/issues as the plan");
    });
  });

  // #2274 / #5490: README/BROWNFIELD/UPGRADING agree on OVPR install/upgrade/doctor
  // (aliases init/update). README tracked-vs-ignored claim matches tip OVPR.
  describe("TestThreeCommandModel", () => {
    it("test_readme_getting_started_leads_with_npm_then_init", () => {
      const content = readme();
      // The install step leads with the global npm install, then `directive install`.
      const step = content.slice(content.indexOf("### 1. Install and initialize"));
      const npmIdx = step.indexOf("npm i -g @deftai/directive");
      const installIdx = step.indexOf("directive install");
      expect(npmIdx).toBeGreaterThanOrEqual(0);
      expect(installIdx).toBeGreaterThan(npmIdx);
      expect(step).toMatch(/alias:\s*directive init|alias:\s*`?init`?/i);
    });

    it("test_readme_routes_by_situation_across_three_commands", () => {
      const content = readme();
      for (const cmd of ["directive install", "directive upgrade", "directive doctor"]) {
        expect(content, `README missing ${cmd}`).toContain(cmd);
      }
      // Aliases remain documented.
      expect(content).toMatch(/alias(?:es)?[`'":\s/]*init/i);
      expect(content).toMatch(/alias(?:es)?[`'":\s/]*update/i);
    });

    it("test_readme_brownfield_upgrading_agree_on_three_command_model", () => {
      for (const rel of ["README.md", "docs/BROWNFIELD.md", "UPGRADING.md"]) {
        const content = readText(rel);
        expect(content, `${rel} missing directive doctor`).toContain("directive doctor");
        // Primary verbs or documented aliases (init ↔ install, update ↔ upgrade).
        const hasInstall = /directive (install|init)\b/.test(content);
        const hasUpgrade = /directive (upgrade|update)\b/.test(content);
        expect(hasInstall, `${rel} missing install/init`).toBe(true);
        expect(hasUpgrade, `${rel} missing upgrade/update`).toBe(true);
      }
    });

    it("test_readme_gitignore_claim_matches_reality", () => {
      const claim = gitignoreClaim();
      for (const tok of [
        "@deftai/directive-runtime",
        "node_modules",
        "wiring-ready",
        "no copied `.deft/core/`",
      ]) {
        expect(claim, `tracked/ignored claim missing ${tok}`).toContain(tok);
      }
      // Pin + owned wiring are committed; there is no copied .deft/core deposit.
      expect(claim.toLowerCase()).toMatch(/committed/);
      expect(claim.toLowerCase()).toMatch(/ignored/);
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
      expect(content).toMatch(/directive (upgrade|update)\b/);
      expect(content.toLowerCase()).toContain("ordinary");
    });
  });

  // #2197 / #5490: README / UPGRADING / BROWNFIELD document pnpm global install
  // plus PNPM_HOME. Ephemeral pnpm dlx / npx are forbidden day-to-day identity.
  describe("TestPnpmSupport", () => {
    it("test_readme_documents_pnpm_install_and_path_caveat", () => {
      const content = readme();
      expect(content).toContain("pnpm add -g @deftai/directive");
      expect(content).toContain("PNPM_HOME");
      expect(content).not.toContain("pnpm dlx @deftai/directive");
      expect(content).toMatch(/Never use `npx` \/ `pnpm exec`/i);
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
