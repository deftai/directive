import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEPRECATED_SKILL_REDIRECT_STUBS,
  PLATFORM_DETECTION_HEADING,
  RFC2119_LEGEND,
  readAgentsMd,
  readRepoFile,
  readSkill,
  repoFileExists,
  resolveRepoPath,
  USER_MD_GATE_HEADING,
} from "./helpers.js";

/** Port of tests/content/test_skills.py (#1838 #1530) */

const _SKILL_PATHS = [
  "skills/deft-directive-build/SKILL.md",
  "skills/deft-directive-setup/SKILL.md",
];
const _SWARM_PATH = "skills/deft-directive-swarm/SKILL.md";
const _SYNC_PATH = "skills/deft-directive-sync/SKILL.md";
const _SYNC_POINTER_PATH = ".agents/skills/deft-directive-sync/SKILL.md";
const _REVIEW_CYCLE_PATH = "skills/deft-directive-review-cycle/SKILL.md";
const _REFINEMENT_PATH = "skills/deft-directive-refinement/SKILL.md";
const _REFINEMENT_POINTER_PATH = ".agents/skills/deft-directive-refinement/SKILL.md";
const _PRE_PR_PATH = "skills/deft-directive-pre-pr/SKILL.md";
const _SETUP_PATH = "skills/deft-directive-setup/SKILL.md";
const _INTERVIEW_PATH = "skills/deft-directive-interview/SKILL.md";
const _INTERVIEW_POINTER_PATH = ".agents/skills/deft-directive-interview/SKILL.md";
const _POLLER_TEMPLATE_PATH = "templates/swarm-greptile-poller-prompt.md";
const _POLLER_TEMPLATE_PLACEHOLDERS = [
  "{pr_number}",
  "{repo}",
  "{poll_interval_seconds}",
  "{poll_cap_minutes}",
  "{parent_agent_id}",
];
const _SWARM_727_MUST_RULES = [
  "Post-PR sub-agents are review-cycle agents",
  "Post-PR monitoring runs in a fresh sub-agent",
  "Canonical poller template",
  "Destructive commands run alone",
  "Commit-message temp file is leave-alone",
];
const _SWARM_727_ANTIPATTERNS = [
  "Run a poll loop in the parent's own turn",
  'Bundle "watch for Greptile" / "monitor CI" instructions',
  'Spawn a "pure poller" sub-agent for a PR that has likely findings',
  "Chain `rm` (or any destructive command) with `git commit`",
];

function formatPollerTemplate(text: string): string {
  const vals: Record<string, string | number> = {
    pr_number: 727,
    repo: "deftai/directive",
    poll_interval_seconds: 90,
    poll_cap_minutes: 30,
    parent_agent_id: "parent-id-xyz",
  };
  let rendered = text.replace(/\{\{/g, "\0OPEN\0").replace(/\}\}/g, "\0CLOSE\0");
  for (const [k, v] of Object.entries(vals)) {
    rendered = rendered.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
  }
  return rendered.replace(/\0OPEN\0/g, "{").replace(/\0CLOSE\0/g, "}");
}

function _read_skill(rel_path: string) {
  return readRepoFile(rel_path);
}

describe("test_skills", () => {
  it.each([
    "skills/deft-directive-build/SKILL.md",
    "skills/deft-directive-setup/SKILL.md",
  ])("skill_file_exists %s", (rel_path) => {
    expect(repoFileExists(rel_path)).toBeTruthy();
  });
  it.each([
    "skills/deft-directive-build/SKILL.md",
    "skills/deft-directive-setup/SKILL.md",
  ])("skill_rfc2119_legend_present %s", (rel_path) => {
    const text = readSkill(rel_path);
    expect(text).toContain(RFC2119_LEGEND);
  });
  it.each([
    "skills/deft-directive-build/SKILL.md",
    "skills/deft-directive-setup/SKILL.md",
  ])("skill_platform_detection_section %s", (rel_path) => {
    const text = readSkill(rel_path);
    expect(text).toContain(PLATFORM_DETECTION_HEADING);
  });
  it.each([
    "skills/deft-directive-build/SKILL.md",
    "skills/deft-directive-setup/SKILL.md",
  ])("skill_platform_detection_covers_windows %s", (rel_path) => {
    const text = readSkill(rel_path);
    expect(text).toContain("%APPDATA%");
  });
  it.each([
    "skills/deft-directive-build/SKILL.md",
    "skills/deft-directive-setup/SKILL.md",
  ])("skill_platform_detection_covers_unix %s", (rel_path) => {
    const text = readSkill(rel_path);
    expect(text).toContain("~/.config/deft/USER.md");
  });
  it.each([
    "skills/deft-directive-build/SKILL.md",
    "skills/deft-directive-setup/SKILL.md",
  ])("skill_platform_detection_env_override %s", (rel_path) => {
    const text = readSkill(rel_path);
    expect(text).toContain("$DEFT_USER_PATH");
  });
  it("deft_directive_build_user_md_gate", () => {
    const rel_path = "skills/deft-directive-build/SKILL.md";
    const text = readSkill(rel_path);
    expect(text).toContain(USER_MD_GATE_HEADING);
  });
  it("deft_directive_build_user_md_gate_redirects_to_deft_setup", () => {
    const rel_path = "skills/deft-directive-build/SKILL.md";
    const text = readSkill(rel_path);
    expect(text).toContain("deft-directive-setup");
  });
  it("deft_setup_has_no_user_md_gate", () => {
    const rel_path = "skills/deft-directive-setup/SKILL.md";
    const text = readSkill(rel_path);
    expect(text).not.toContain(USER_MD_GATE_HEADING);
  });
  it("phase2_inference_no_deft_build_files", () => {
    const text = readSkill("skills/deft-directive-setup/SKILL.md");
    expect(text).toContain("⊗");
    expect(text).toContain("./deft/");
    expect(text.toLowerCase()).toContain("build files");
  });
  it("phase2_inference_no_deft_git", () => {
    const text = readSkill("skills/deft-directive-setup/SKILL.md");
    expect(text.toLowerCase()).toContain("git");
    expect(text).toContain("./deft/");
    expect(text.toLowerCase()).toContain("framework repo");
  });
  it("phase2_inference_directory_name_fallback", () => {
    const text = readSkill("skills/deft-directive-setup/SKILL.md");
    expect(text.toLowerCase()).toContain("directory name");
    expect(text.toLowerCase()).toContain("no build files");
  });
  it("user_md_template_no_primary_languages", () => {
    const text = readSkill("skills/deft-directive-setup/SKILL.md");
    expect(text).not.toContain("**Primary Languages**");
  });
  it("phase1_track1_no_language_step", () => {
    const text = readSkill("skills/deft-directive-setup/SKILL.md");
    expect(text).not.toContain("Ask preferred languages");
  });
  it("phase2_track1_has_deployment_platform", () => {
    const text = readSkill("skills/deft-directive-setup/SKILL.md");
    expect(text.toLowerCase()).toContain("deployment platform");
  });
  it("phase2_track1_platform_before_language", () => {
    const text = readSkill("skills/deft-directive-setup/SKILL.md");
    const platform_pos = text.toLowerCase().indexOf("deployment platform");
    const language_pos = text.toLowerCase().indexOf("ask languages", platform_pos);
    expect(platform_pos).not.toBe(-1);
    expect(language_pos).not.toBe(-1);
    expect(platform_pos).toBeLessThan(language_pos);
  });
  it("phase2_track1_progressive_other_disclosure", () => {
    const text = readSkill("skills/deft-directive-setup/SKILL.md");
    expect(text).toContain("Tier 2");
    expect(text).toContain("Tier 3");
  });
  it("phase2_track1_missing_standards_warning", () => {
    const text = readSkill("skills/deft-directive-setup/SKILL.md");
    expect(text.toLowerCase()).toContain("standards file");
    expect(text.toLowerCase()).toContain("general defaults");
  });
  it("deft_directive_build_references_task_check", () => {
    const rel_path = "skills/deft-directive-build/SKILL.md";
    const text = readSkill(rel_path);
    expect(text).toContain("task check");
  });
  it("deft_directive_build_references_task_test_coverage", () => {
    const rel_path = "skills/deft-directive-build/SKILL.md";
    const text = readSkill(rel_path);
    expect(text).toContain("task test:coverage");
  });
  it("deft_directive_swarm_exists", () => {
    expect(repoFileExists(_SWARM_PATH)).toBeTruthy();
  });
  it("deft_directive_swarm_rfc2119_legend", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text).toContain(RFC2119_LEGEND);
  });
  it("deft_directive_swarm_phase0_allocate_heading", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text).toContain("## Phase 0");
    expect(text).toContain("Allocate");
  });
  it("deft_directive_swarm_phase0_scans_vbrief_active", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text).toContain("vbrief/active/");
    expect(text).toContain("vbrief.json");
  });
  it("deft_directive_swarm_phase0_surfaces_blockers", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text.toLowerCase()).toContain("blocked");
    expect(text.toLowerCase()).toContain("incomplete");
  });
  it("deft_directive_swarm_phase0_approval_gate", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text).toContain("yes");
    expect(text).toContain("confirmed");
    expect(text).toContain("approve");
  });
  it("deft_directive_swarm_phase0_antipattern", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text).toContain("Phase 1 (Select) without completing Phase 0");
  });
  it("deft_directive_swarm_flexible_allocation", () => {
    const text = readSkill(_SWARM_PATH);
    expect(
      text.toLowerCase().includes("no fixed per-agent limit") ||
        text.toLowerCase().includes("no hardcoded 1:1 rule"),
    ).toBe(true);
    expect(text.toLowerCase()).toContain("small/independent stories");
    expect(text.toLowerCase()).toContain("batched");
    expect(text.toLowerCase()).toContain("large/complex stories");
    expect(text.toLowerCase()).toContain("dedicated");
  });
  it("deft_directive_swarm_runtime_start_agent_detection", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text).toContain("start_agent");
  });
  it("deft_directive_swarm_warp_env_detection", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text.includes("WARP_*") || text.includes("WARP_TERMINAL_SESSION")).toBe(true);
  });
  it("deft_directive_swarm_spawn_subagent_grok_build_detection", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text).toContain("spawn_subagent");
    expect(text.includes("grok-build") || text.includes("spawn_subagent")).toBe(true);
    expect(text.toLowerCase().includes("absence") || text.toLowerCase().includes("absences")).toBe(
      true,
    );
  });
  it("deft_directive_swarm_platform_descriptor_matrix", () => {
    const text = readSkill(_SWARM_PATH);
    expect(
      text.toLowerCase().includes("stable platform descriptor") ||
        text.toLowerCase().includes("platform descriptor") ||
        text.toLowerCase().includes("platform adapter"),
    ).toBe(true);
    expect(text.includes("grok-build") || text.includes("spawn_subagent")).toBe(true);
  });
  it("deft_directive_swarm_no_static_abc_antipattern", () => {
    const text = readSkill(_SWARM_PATH);
    expect(
      text.toLowerCase().includes("static launch options") ||
        text.includes("static launch options (A/B/C)"),
    ).toBe(true);
  });
  it("deft_directive_swarm_cloud_escape_hatch_only", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text.toLowerCase()).toContain("explicit");
    expect(text.toLowerCase()).toContain("user");
    expect(text).toContain("run-cloud");
  });
  it("deft_directive_swarm_phase6_merge_authority", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text).toContain("Merge authority");
    expect(text).toContain("user approves");
  });
  it("deft_directive_swarm_phase6_rebase_ownership", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text).toContain("Rebase cascade ownership");
    expect(text).toContain("Monitor owns");
  });
  it("deft_directive_swarm_phase6_git_editor", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text).toContain("GIT_EDITOR");
  });
  it("deft_directive_swarm_phase6_post_merge_verification", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text).toContain("verify issues actually closed");
  });
  it("deft_directive_swarm_push_autonomy", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text).toContain("Push Autonomy");
    expect(text.toLowerCase()).toContain("task check");
  });
  it("deft_directive_swarm_phase5_6_gate_heading", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text).toContain("Phase 5→6 Gate");
  });
  it("deft_directive_swarm_phase5_6_version_bump_approval", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text.toLowerCase()).toContain("version bump");
    expect(text).toContain("confirmed");
  });
  it("deft_directive_swarm_greptile_rebase_latency", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text).toContain("Greptile re-review");
    expect(text).toContain("2-5");
  });
  it("deft_directive_sync_exists", () => {
    expect(repoFileExists(_SYNC_PATH)).toBeTruthy();
  });
  it("deft_directive_sync_rfc2119_legend", () => {
    const text = readSkill(_SYNC_PATH);
    expect(text).toContain(RFC2119_LEGEND);
  });
  it("deft_directive_sync_has_frontmatter", () => {
    const text = readSkill(_SYNC_PATH);
    expect(text.startsWith("---")).toBeTruthy();
    expect(text).toContain("name: deft-directive-sync");
  });
  it("deft_directive_sync_anti_patterns_section", () => {
    const text = readSkill(_SYNC_PATH);
    expect(text).toContain("## Anti-Patterns");
    expect(text).toContain("⊗");
    expect(text.toLowerCase()).toContain("auto-commit");
  });
  it("deft_directive_sync_preflight_dirty_check", () => {
    const text = readSkill(_SYNC_PATH);
    expect(text).toContain("git -C deft status --porcelain");
  });
  it("deft_directive_sync_no_upstream_vbrief_fetch", () => {
    const text = readSkill(_SYNC_PATH);
    expect(text).toContain("⊗");
    expect(text).toContain("#128");
  });
  it("deft_directive_sync_pointer_exists", () => {
    expect(repoFileExists(_SYNC_POINTER_PATH)).toBeTruthy();
  });
  it("deft_directive_sync_lifecycle_folder_validation", () => {
    const text = readSkill(_SYNC_PATH);
    expect(text).toContain("proposed/");
    expect(text).toContain("pending/");
    expect(text).toContain("active/");
    expect(text).toContain("completed/");
    expect(text).toContain("cancelled/");
  });
  it("deft_directive_sync_project_definition_validation", () => {
    const text = readSkill(_SYNC_PATH);
    expect(text).toContain("PROJECT-DEFINITION.vbrief.json");
    expect(text).toContain("vBRIEFInfo");
    expect(text).toContain('"0.6"');
  });
  it("deft_directive_sync_project_definition_freshness", () => {
    const text = readSkill(_SYNC_PATH);
    expect(text.toLowerCase()).toContain("freshness check");
    expect(text.toLowerCase()).toContain("stale");
  });
  it("deft_directive_sync_lifecycle_consistency", () => {
    const text = readSkill(_SYNC_PATH);
    expect(text).toContain("Lifecycle Consistency");
    expect(text).toContain("MISMATCH");
    expect(text).toContain("plan.status");
  });
  it("deft_directive_sync_origin_freshness", () => {
    const text = readSkill(_SYNC_PATH);
    expect(text).toContain("Origin Freshness");
    expect(text).toContain("D12");
    expect(text).toContain("updatedAt");
    expect(text).toContain("github-issue");
  });
  it("deft_directive_sync_origin_freshness_report_only", () => {
    const text = readSkill(_SYNC_PATH);
    expect(text.toLowerCase()).toContain("report only");
    expect(text.toLowerCase()).toContain("never auto-update");
  });
  it("deft_directive_sync_externally_closed_origins", () => {
    const text = readSkill(_SYNC_PATH);
    expect(text.toLowerCase()).toContain("externally closed");
    expect(text).toContain("CLOSED");
  });
  it("deft_directive_sync_no_old_name_references", () => {
    const text = readSkill(_SYNC_PATH);
    expect(text).not.toContain("skills/deft-sync/");
  });
  it("deft_review_cycle_mcp_fallback", () => {
    const text = readSkill(_REVIEW_CYCLE_PATH);
    expect(text).toContain("MCP is unavailable");
    expect(text).toContain("gh");
  });
  it("deft_directive_refinement_exists", () => {
    expect(repoFileExists(_REFINEMENT_PATH)).toBeTruthy();
  });
  it("deft_directive_refinement_rfc2119_legend", () => {
    const text = readSkill(_REFINEMENT_PATH);
    expect(text).toContain(RFC2119_LEGEND);
  });
  it("deft_directive_refinement_has_frontmatter", () => {
    const text = readSkill(_REFINEMENT_PATH);
    expect(text.startsWith("---")).toBeTruthy();
    expect(text).toContain("name: deft-directive-refinement");
  });
  it("deft_directive_refinement_legacy_trigger_aliases", () => {
    const text = readSkill(_REFINEMENT_PATH);
    for (const alias of ["roadmap refresh", "refresh roadmap", "triage"]) {
      expect(text).toContain(alias);
    }
    for (const trigger of ["refinement", "reprioritize", "refine"]) {
      expect(text).toContain(trigger);
    }
  });
  it("deft_directive_refinement_session_model", () => {
    const text = readSkill(_REFINEMENT_PATH);
    expect(text.toLowerCase()).toContain("conversational loop");
    expect(text.toLowerCase()).toContain("batch job");
  });
  it("deft_directive_refinement_ingest_phase", () => {
    const text = readSkill(_REFINEMENT_PATH);
    expect(text).toContain("## Phase 1 -- Ingest");
    expect(text).toContain("Deduplicate");
    expect(text).toContain("references");
  });
  it("deft_directive_refinement_ingest_origin_provenance", () => {
    const text = readSkill(_REFINEMENT_PATH);
    expect(text).toContain("github-issue");
    expect(text).toContain("YYYY-MM-DD");
  });
  it("deft_directive_refinement_evaluate_phase", () => {
    const text = readSkill(_REFINEMENT_PATH);
    expect(text).toContain("## Phase 2 -- Evaluate");
    expect(text).toContain("Interactive Review");
  });
  it("deft_directive_refinement_reconcile_phase", () => {
    const text = readSkill(_REFINEMENT_PATH);
    expect(text).toContain("## Phase 3 -- Reconcile");
    expect(text).toContain("D12");
    expect(text.toLowerCase()).toContain("never auto-update");
  });
  it("deft_directive_refinement_promote_demote_phase", () => {
    const text = readSkill(_REFINEMENT_PATH);
    expect(text).toContain("## Phase 4 -- Promote/Demote");
    expect(text).toContain("task scope:promote");
    expect(text).toContain("task scope:activate");
  });
  it("deft_directive_refinement_prioritize_phase", () => {
    const text = readSkill(_REFINEMENT_PATH);
    expect(text).toContain("## Phase 5 -- Prioritize");
    expect(text).toContain("task roadmap:render");
  });
  it("deft_directive_refinement_completion_lifecycle", () => {
    const text = readSkill(_REFINEMENT_PATH);
    expect(text).toContain("Completion Lifecycle");
    expect(text).toContain("gh issue close");
  });
  it("deft_directive_refinement_pr_review_cycle", () => {
    const text = readSkill(_REFINEMENT_PATH);
    expect(text).toContain("## PR & Review Cycle");
    expect(text).toContain("Ready to commit and create a PR?");
    expect(text).toContain("task check");
  });
  it("deft_directive_refinement_review_cycle_handoff", () => {
    const text = readSkill(_REFINEMENT_PATH);
    expect(text).toContain("skills/deft-directive-review-cycle/SKILL.md");
  });
  it("deft_directive_refinement_exit_block", () => {
    const text = readSkill(_REFINEMENT_PATH);
    expect(text).toContain("### EXIT");
    expect(text.toLowerCase()).toContain("exiting skill");
    expect(text.toLowerCase()).toContain("chaining instructions");
  });
  it("deft_directive_refinement_batch_changelog_rule", () => {
    const text = readSkill(_REFINEMENT_PATH);
    expect(text.toLowerCase()).toContain("batch");
    expect(text.toLowerCase()).toContain("end of the full refinement session");
  });
  it("deft_directive_refinement_precommit_file_review", () => {
    const text = readSkill(_REFINEMENT_PATH);
    expect(text.toLowerCase()).toContain("encoding errors");
    expect(text.toLowerCase()).toContain("unintended duplication");
  });
  it("deft_directive_refinement_anti_patterns", () => {
    const text = readSkill(_REFINEMENT_PATH);
    expect(text).toContain("## Anti-Patterns");
    expect(text.toLowerCase()).toContain("auto-push");
    expect(text.toLowerCase()).toContain("deduplicat");
  });
  it("deft_directive_refinement_pointer_exists", () => {
    expect(repoFileExists(_REFINEMENT_POINTER_PATH)).toBeTruthy();
  });
  it("deft_directive_refinement_no_old_name_references", () => {
    const text = readSkill(_REFINEMENT_PATH);
    expect(text).not.toContain("deft-roadmap-refresh");
  });
  it("deft_review_cycle_tiered_monitoring_heading", () => {
    const text = readSkill(_REVIEW_CYCLE_PATH);
    expect(text).toContain("### Review Monitoring");
  });
  it("deft_review_cycle_start_agent_approach", () => {
    const text = readSkill(_REVIEW_CYCLE_PATH);
    expect(text).toContain("start_agent");
    expect(text.toLowerCase()).toContain("sub-agent");
  });
  it("deft_review_cycle_fallback_approach", () => {
    const text = readSkill(_REVIEW_CYCLE_PATH);
    expect(text.toLowerCase()).toContain("yield");
    expect(text.includes("run_terminal_command") || text.includes("Approach 2")).toBe(true);
  });
  it("deft_review_cycle_no_blocking_sleep", () => {
    const text = readSkill(_REVIEW_CYCLE_PATH);
    const lines = text.split("\n");
    for (const line of lines) {
      if (line.includes("Start-Sleep") || line.includes("time.sleep")) {
        expect(line).toContain("⊗");
      }
    }
  });
  it("deft_review_cycle_capability_detection", () => {
    const text = readSkill(_REVIEW_CYCLE_PATH);
    expect(text.toLowerCase()).toContain("capability detection");
    expect(text).toContain("start_agent");
  });
  it("deft_review_cycle_send_message", () => {
    const text = readSkill(_REVIEW_CYCLE_PATH);
    expect(text).toContain("send_message_to_agent");
  });
  it("deft_directive_build_precommit_file_review", () => {
    const text = readSkill("skills/deft-directive-build/SKILL.md");
    expect(text.toLowerCase()).toContain("encoding errors");
    expect(text.toLowerCase()).toContain("unintended duplication");
  });
  it("deft_review_cycle_precommit_gate", () => {
    const text = readSkill(_REVIEW_CYCLE_PATH);
    expect(text.toLowerCase()).toContain("re-read the full current greptile review");
  });
  it("deft_review_cycle_partial_fix_antipattern", () => {
    const text = readSkill(_REVIEW_CYCLE_PATH);
    expect(text.toLowerCase()).toContain(
      "fewer findings than the current greptile review surfaces",
    );
  });
  it("deft_review_cycle_unchecked_p1_antipattern", () => {
    const text = readSkill(_REVIEW_CYCLE_PATH);
    expect(text.toLowerCase()).toContain("push after fixing a p1 without first checking");
  });
  it("deft_directive_build_semantic_contradiction_rule", () => {
    const text = readSkill("skills/deft-directive-build/SKILL.md");
    expect(text.toLowerCase()).toContain("semantic contradictions");
  });
  it("deft_directive_build_strength_duplicate_rule", () => {
    const text = readSkill("skills/deft-directive-build/SKILL.md");
    expect(text.toLowerCase()).toContain("strength duplicates");
    expect(text.toLowerCase()).toContain("weaker-strength duplicate");
  });
  it("deft_directive_build_contradiction_antipattern", () => {
    const text = readSkill("skills/deft-directive-build/SKILL.md");
    expect(text.toLowerCase()).toContain("prohibition");
    expect(text.toLowerCase()).toContain("softer-strength");
  });
  it("deft_pre_pr_semantic_contradiction_rule", () => {
    const text = readSkill(_PRE_PR_PATH);
    const lower = text.toLowerCase();
    expect(lower).toContain("prohibits a specific command");
    expect(lower).toContain("resolve all contradictions");
  });
  it("deft_pre_pr_strength_duplicate_rule", () => {
    const text = readSkill(_PRE_PR_PATH);
    expect(text.toLowerCase()).toContain("strengthening a rule");
    expect(text.toLowerCase()).toContain("weaker-strength duplicate");
  });
  it("deft_pre_pr_contradiction_antipattern", () => {
    const text = readSkill(_PRE_PR_PATH);
    expect(text.toLowerCase()).toContain("prohibition");
    expect(text.toLowerCase()).toContain("softer-strength");
  });
  it("deft_directive_swarm_phase5_6_context_pressure_callout", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text.toLowerCase()).toContain("context-pressure bypass prohibition");
  });
  it("deft_directive_swarm_takeover_prespawn_verification", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text.toLowerCase()).toContain("pre-spawn verification");
    expect(text.toLowerCase()).toContain("lifecycle event");
  });
  it("deft_directive_swarm_duplicate_tab_failure_mode", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text).toContain("Duplicate-Tab Failure Mode");
    expect(text).toContain("tool_use");
    expect(text).toContain("tool_result");
    expect(text.toLowerCase()).toContain("worktree");
    expect(text.includes("spawn_subagent") || text.includes("Grok Build")).toBe(true);
  });
  it("deft_directive_swarm_context_length_warning", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text).toContain("Context-Length Warning");
    expect(text.toLowerCase()).toContain("conversation corruption");
  });
  it("deft_directive_swarm_crash_recovery_section", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text).toContain("## Crash Recovery");
    expect(text).toContain("gh pr list");
    expect(text).toContain("gh pr view");
  });
  it("deft_directive_swarm_antipattern_no_spawn_without_lifecycle", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text.toLowerCase()).toContain("spawn a replacement sub-agent without confirming");
  });
  it("deft_directive_swarm_antipattern_no_skip_phase5_gate", () => {
    const text = readSkill(_SWARM_PATH);
    const lower = text.toLowerCase();
    expect(lower).toContain("skip phase 5");
    expect(lower).toContain("time pressure");
    expect(lower).toContain("long context");
  });
  it("deft_setup_user_md_template_has_deft_version", () => {
    const text = readSkill(_SETUP_PATH);
    expect(text).toContain("**deft_version**:");
  });
  it("deft_setup_project_definition_template_has_deft_version", () => {
    const text = readSkill(_SETUP_PATH);
    expect(text).toContain("**deft_version**:");
    expect(text).toContain('"DeftVersion"');
  });
  it("deft_setup_stale_user_md_detection", () => {
    const text = readSkill(_SETUP_PATH);
    const lower = text.toLowerCase();
    expect(lower).toContain("freshness detection");
    expect(lower).toContain("predates versioning");
    expect(lower).toContain("treat as stale");
    expect(lower).toContain("query missing fields individually");
  });
  it("deft_setup_deft_version_must_rule", () => {
    const text = readSkill(_SETUP_PATH);
    expect(text).toContain("deft_version` field MUST be set");
    expect(text).toContain("⊗");
    expect(text).toContain("without including the `deft_version` field");
  });
  it("deft_interview_exists", () => {
    expect(repoFileExists(_INTERVIEW_PATH)).toBeTruthy();
  });
  it("deft_interview_rfc2119_legend", () => {
    const text = readSkill(_INTERVIEW_PATH);
    expect(text).toContain(RFC2119_LEGEND);
  });
  it("deft_interview_has_frontmatter", () => {
    const text = readSkill(_INTERVIEW_PATH);
    expect(text.startsWith("---")).toBeTruthy();
    expect(text).toContain("name: deft-directive-interview");
  });
  it("deft_interview_one_question_per_turn", () => {
    const text = readSkill(_INTERVIEW_PATH);
    expect(text).toContain("ONE focused question per step");
  });
  it("deft_interview_numbered_options_with_default", () => {
    const text = readSkill(_INTERVIEW_PATH);
    expect(text).toContain("[default:");
    expect(text.toLowerCase()).toContain("numbered answer options");
  });
  it("deft_interview_other_escape", () => {
    const text = readSkill(_INTERVIEW_PATH);
    expect(text).toContain("Other / I don't know");
  });
  it("deft_interview_depth_gate", () => {
    const text = readSkill(_INTERVIEW_PATH);
    expect(text.toLowerCase()).toContain("no material ambiguity remains");
  });
  it("deft_interview_default_acceptance", () => {
    const text = readSkill(_INTERVIEW_PATH);
    expect(text.toLowerCase()).toContain("bare enter");
    expect(text.toLowerCase()).toContain("default");
  });
  it("deft_interview_confirmation_gate", () => {
    const text = readSkill(_INTERVIEW_PATH);
    expect(text.toLowerCase()).toContain("confirmation gate");
    expect(text.toLowerCase()).toContain("yes / no");
  });
  it("deft_interview_structured_handoff", () => {
    const text = readSkill(_INTERVIEW_PATH);
    expect(text.toLowerCase()).toContain("answers map");
    expect(text.toLowerCase()).toContain("calling skill");
  });
  it("deft_interview_anti_patterns", () => {
    const text = readSkill(_INTERVIEW_PATH);
    expect(text).toContain("## Anti-Patterns");
    expect(text.toLowerCase()).toContain("multiple questions");
    expect(text.toLowerCase()).toContain("confirmation gate");
  });
  it("deft_interview_pointer_exists", () => {
    expect(repoFileExists(_INTERVIEW_POINTER_PATH)).toBeTruthy();
  });
  it("deft_setup_phase1_references_deft_directive_interview", () => {
    const text = readSkill(_SETUP_PATH);
    const phase1_start = text.indexOf("## Phase 1");
    const phase2_start = text.indexOf("## Phase 2");
    expect(phase1_start).not.toBe(-1);
    expect(phase2_start).not.toBe(-1);
    const phase1_text = text.slice(phase1_start, phase2_start);
    expect(phase1_text).toContain("deft-directive-interview");
  });
  it("deft_setup_phase2_references_deft_directive_interview", () => {
    const text = readSkill(_SETUP_PATH);
    const phase2_start = text.indexOf("## Phase 2");
    const phase3_start = text.indexOf("## Phase 3");
    expect(phase2_start).not.toBe(-1);
    expect(phase3_start).not.toBe(-1);
    const phase2_text = text.slice(phase2_start, phase3_start);
    expect(phase2_text).toContain("deft-directive-interview");
  });
  it("deft_directive_swarm_phase6_readback_verification", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text).toContain("Read-back verification");
    expect(text.toLowerCase()).toContain("conflict markers");
  });
  it("deft_directive_swarm_phase6_prefer_edit_files_for_conflicts", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text).toContain("edit_files");
    expect(text).toContain("CHANGELOG.md");
  });
  it("deft_directive_swarm_phase6_slack_announcement_step", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text).toContain("Slack");
    expect(text.toLowerCase()).toContain("announcement");
  });
  it("deft_directive_swarm_phase6_slack_required_fields", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text).toContain("Key Changes");
    expect(text).toContain("PRs*:");
    expect(text).toContain("Release*:");
  });
  it("deft_directive_swarm_phase5_vbrief_completion", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text).toContain("scope:complete");
    expect(text).toContain("vbrief/completed/");
  });
  it("deft_directive_swarm_phase6_origin_update", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text.toLowerCase()).toContain("references");
    expect(text.toLowerCase()).toContain("update each origin");
  });
  it("deft_directive_swarm_no_old_name_references", () => {
    const text = readSkill(_SWARM_PATH);
    const oldRefs = [...text.matchAll(/(?<!directive-)deft-swarm/g)];
    expect(oldRefs.length).toBe(0);
  });
  it("deft_directive_swarm_frontmatter_name", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text).toContain("name: deft-directive-swarm");
  });
  it("deft_directive_swarm_no_hardcoded_allocation_antipattern", () => {
    const text = readSkill(_SWARM_PATH);
    expect(
      text.toLowerCase().includes("hardcode a 1:1") || text.toLowerCase().includes("hardcoded 1:1"),
    ).toBe(true);
  });
  it("deft_directive_setup_phase2_outputs_project_definition_vbrief", () => {
    const text = readSkill(_SETUP_PATH);
    expect(text).toContain("PROJECT-DEFINITION.vbrief.json");
  });
  it("deft_directive_setup_phase3_onboarding_question", () => {
    const text = readSkill(_SETUP_PATH);
    expect(text.toLowerCase()).toContain("adding a scope");
    expect(text.toLowerCase()).toContain("starting a new");
  });
  it("deft_directive_setup_full_path_rich_narratives", () => {
    const text = readSkill(_SETUP_PATH);
    expect(text).toContain("ProblemStatement");
    expect(text).toContain("Goals");
    expect(text).toContain("UserStories");
    expect(text).toContain("SuccessMetrics");
    expect(text).toContain("Requirements");
  });
  it("deft_directive_setup_light_path_scope_vbriefs", () => {
    const text = readSkill(_SETUP_PATH);
    expect(text).toContain("vbrief/proposed/");
  });
  it("deft_directive_setup_no_authoritative_prd", () => {
    const text = readSkill(_SETUP_PATH);
    expect(text).toContain("authoritative PRD.md");
  });
  it("deft_directive_setup_handoff_to_directive_build", () => {
    const text = readSkill(_SETUP_PATH);
    expect(text).toContain("deft-directive-build");
  });
  it("deft_directive_interview_full_path_narrative_keys", () => {
    const text = readSkill(_INTERVIEW_PATH);
    for (const key of [
      "ProblemStatement",
      "Goals",
      "UserStories",
      "Requirements",
      "SuccessMetrics",
      "Architecture",
      "Overview",
    ]) {
      expect(text).toContain(key);
    }
  });
  it("deft_directive_interview_light_path_slim_narratives", () => {
    const text = readSkill(_INTERVIEW_PATH);
    const light_section = text.slice(text.indexOf("### Light Path"), undefined);
    expect(light_section).toContain("Overview");
    expect(light_section).toContain("Architecture");
  });
  it("deft_directive_interview_prd_render_reference", () => {
    const text = readSkill(_INTERVIEW_PATH);
    expect(text).toContain("task prd:render");
  });
  it("deft_directive_interview_no_authoritative_prd", () => {
    const text = readSkill(_INTERVIEW_PATH);
    expect(text).toContain("authoritative PRD.md");
    expect(text.toLowerCase()).toContain("never authoritative");
  });
  it("deft_directive_interview_output_targets_section", () => {
    const text = readSkill(_INTERVIEW_PATH);
    expect(text).toContain("## Output Targets");
  });
  it("no_bare_deft_skill_directories", () => {
    const bareDeft = readdirSync(resolveRepoPath("skills"), { withFileTypes: true })
      .filter(
        (d) =>
          d.isDirectory() &&
          d.name.startsWith("deft-") &&
          !d.name.startsWith("deft-directive-") &&
          !DEPRECATED_SKILL_REDIRECT_STUBS.has(d.name),
      )
      .map((d) => d.name);
    expect(bareDeft).toEqual([]);
  });
  it("agents_md_routing_all_deft_directive_paths", () => {
    const text = readAgentsMd();
    const paths = [...text.matchAll(/\u2192\s+`(content\/skills\/[^`]+)`/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThan(0);
    const nonDirective = paths.filter((p) => !p.includes("deft-directive-"));
    expect(nonDirective).toEqual([]);
  });
  it("deft_directive_swarm_see_also_link_correct", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text).toContain("../deft-directive-review-cycle/SKILL.md");
    expect(text).not.toContain("../deft-review-cycle/SKILL.md");
    const oldRefs = [...text.matchAll(/(?<!directive-)deft-review-cycle\/SKILL\.md/g)];
    expect(oldRefs.length).toBe(0);
  });
  it("deft_directive_swarm_configurable_base_branch_phase0", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text.toLowerCase()).toContain("base branch");
    expect(text.toLowerCase()).toContain("configured base branch");
  });
  it("deft_directive_swarm_worktree_no_hardcoded_master", () => {
    const text = readSkill(_SWARM_PATH);
    for (const line of text.split("\n")) {
      if (line.includes("git worktree add") && line.includes("-b")) {
        expect(line).not.toContain("master");
      }
    }
  });
  it("deft_directive_swarm_auto_generate_vbriefs_from_issues", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text).toContain("gh issue view");
    expect(text.toLowerCase()).toContain("issue numbers");
  });
  it("deft_directive_swarm_antipattern_no_hardcoded_master", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text.toLowerCase()).toContain("hardcode `master` as the base branch");
  });
  it("deft_directive_swarm_phase6_greptile_errored_detection", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text).toContain("Greptile encountered an error while reviewing this PR");
    expect(text).toContain("COMPLETED/NEUTRAL");
    expect(text).toContain("do NOT interpret that as passing");
  });
  it("deft_directive_swarm_phase6_greptile_errored_retry_once", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text).toContain("Retry ONCE");
    expect(text).toContain("@greptileai review");
    expect(text).toContain("10-minute cap");
  });
  it("deft_directive_swarm_phase6_greptile_errored_three_way_escalation", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text.toLowerCase()).toContain("wait longer");
    expect(
      text.includes("empty `chore: retrigger greptile` commit") ||
        text.includes("chore: retrigger greptile"),
    ).toBe(true);
    expect(text.toLowerCase()).toContain("merge with documented override");
    expect(text).toContain("merge commit body");
    expect(text).toContain("not just the PR body");
  });
  it("deft_directive_swarm_phase6_gate_errored_extension", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text).toContain("an errored review is also not sufficient");
  });
  it("deft_directive_swarm_phase6_monitor_exit_errored", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text).toContain("⊗ Loop the monitor indefinitely on the errored state");
    expect(text).toContain("explicit `errored` report");
  });
  it("deft_directive_swarm_phase6_no_merge_on_neutral_alone", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text).toContain("⊗ Merge on the basis of the NEUTRAL CheckRun alone");
  });
  it("deft_directive_swarm_phase6_polling_subagent_contract", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text).toContain("PR #<N> Greptile errored");
    const lower = text.toLowerCase();
    expect(lower).toContain("last-reviewed sha");
    expect(lower).toContain("errored on current head");
  });
  it("deft_directive_swarm_antipattern_neutral_checkrun", () => {
    const text = readSkill(_SWARM_PATH);
    const needle =
      "⊗ Treat a Greptile GitHub CheckRun of COMPLETED/NEUTRAL as equivalent to a passing review";
    expect(text).toContain(needle);
    expect(text).toContain("errored out mid-review");
    expect(text).toContain("opposite responses");
  });
  it("deft_directive_swarm_antipattern_errored_loop_and_override_logging", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text).toContain("Loop the monitor indefinitely on the Greptile-service-errored state");
    expect(text).toContain(
      "Omit override-merged PRs from the Phase 6 Step 5 Slack release announcement",
    );
  });
  it("deft_directive_swarm_phase6_slack_override_merge_callout", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text).toContain("*Override merges*");
    expect(text).toContain("Greptile-service-errored override path");
  });
  it("swarm_greptile_poller_prompt_template_exists", () => {
    expect(repoFileExists(_POLLER_TEMPLATE_PATH)).toBeTruthy();
  });
  it.each([
    "{pr_number}",
    "{repo}",
    "{poll_interval_seconds}",
    "{poll_cap_minutes}",
    "{parent_agent_id}",
  ])("swarm_greptile_poller_prompt_placeholders %s", (placeholder) => {
    const text = readRepoFile(_POLLER_TEMPLATE_PATH);
    expect(text).toContain(placeholder);
  });
  it("swarm_greptile_poller_prompt_format_renders", () => {
    const text = readRepoFile(_POLLER_TEMPLATE_PATH);
    const rendered = formatPollerTemplate(text);
    expect(rendered).toContain("PR #727");
    expect(rendered).toContain("deftai/directive");
    expect(rendered).toContain("parent-id-xyz");
    expect(rendered).toContain("90");
    expect(rendered).toContain("30");
  });
  it("swarm_greptile_poller_prompt_parsing_fix_last_reviewed_commit", () => {
    const text = readRepoFile(_POLLER_TEMPLATE_PATH);
    expect(text).toContain("Last reviewed commit:");
    expect(text).toContain("commit/(?P<sha>");
  });
  it("swarm_greptile_poller_prompt_parsing_fix_findings_detection", () => {
    const text = readRepoFile(_POLLER_TEMPLATE_PATH);
    expect(text).toContain('<img alt="P1"');
    expect(text).toContain('<img alt="P0"');
    expect(text).toContain("No P0 or P1");
  });
  it("swarm_skill_references_poller_template", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text).toContain("templates/swarm-greptile-poller-prompt.md");
  });
  it.each([
    "Post-PR sub-agents are review-cycle agents",
    "Post-PR monitoring runs in a fresh sub-agent",
    "Canonical poller template",
    "Destructive commands run alone",
    "Commit-message temp file is leave-alone",
  ])("swarm_skill_role_separation_must_rules_present %s", (token) => {
    const text = readSkill(_SWARM_PATH);
    expect(text).toContain(token);
  });
  it.each([
    "Run a poll loop in the parent's own turn",
    'Bundle "watch for Greptile" / "monitor CI" instructions',
    'Spawn a "pure poller" sub-agent for a PR that has likely findings',
    "Chain `rm` (or any destructive command) with `git commit`",
  ])("swarm_skill_role_separation_antipatterns_present %s", (token) => {
    const text = readSkill(_SWARM_PATH);
    expect(text).toContain(token);
  });
  it("swarm_skill_role_separation_subsection_heading", () => {
    const text = readSkill(_SWARM_PATH);
    expect(text).toContain("### Sub-Agent Role Separation");
  });
});
