import { describe, expect, it } from "vitest";
import { readText } from "./_helpers.js";

describe("test_branch_gate.py", () => {
  it("test_pre_commit_hook_exists_and_calls_script", () => {
    const text = readText(".githooks/pre-commit");
    expect(text).toContain("preflight_branch.py");
    expect(text).toContain("git rev-parse --show-toplevel");
    expect(text).toContain("SCRIPTS_DIR");
    expect(text).toContain(".deft/core/scripts");
  });
  it("test_pre_push_hook_exists_and_calls_script", () => {
    const text = readText(".githooks/pre-push");
    expect(text).toContain("preflight_branch.py");
    expect(text).toContain("SCRIPTS_DIR");
    expect(text).toContain(".deft/core/scripts");
  });
  it("test_taskfile_check_includes_verify_branch", () => {
    const text = readText("Taskfile.yml");
    expect(text).toContain("verify:branch");
  });
  it("test_taskfile_has_setup_task_for_hooks_path", () => {
    const text = readText("Taskfile.yml");
    expect(text).toContain("core.hooksPath");
    expect(text).toContain(".githooks");
  });
  it("test_taskfile_includes_policy_yml", () => {
    const text = readText("Taskfile.yml");
    expect(text).toContain("./tasks/policy.yml");
  });
  it("test_verify_yml_declares_branch_and_hooks_installed", () => {
    const text = readText("tasks/verify.yml");
    expect(text).toContain("branch:");
    expect(text).toContain("hooks-installed:");
    expect(text).toContain("preflight_branch.py");
    expect(text).toContain("core.hooksPath");
  });
  it("test_policy_yml_declares_show_enforce_allow", () => {
    const text = readText("tasks/policy.yml");
    expect(text).toContain("show:");
    expect(text).toContain("enforce-branches:");
    expect(text).toContain("allow-direct-commits:");
    expect(text).toContain("packages/cli/dist/bin.js");
    expect(text).toContain("policy show");
    expect(text).toContain("policy-set");
  });
  it("test_branch_gate_workflow_rejects_head_eq_base", () => {
    const text = readText(".github/workflows/branch-gate.yml");
    expect(text).toContain("branch-gate");
    expect(text).toContain("head_ref");
    expect(text).toContain("base_ref");
    expect(text).toContain("exit 1");
    expect(text).toContain("pull_request:");
  });
  it("test_agents_md_disclosure_block_present", () => {
    const text = readText("AGENTS.md");
    expect(text).toContain("Branch Policy Disclosure");
    expect(text).toContain("allowDirectCommitsToMaster");
    expect(text).toContain("DEFT_ALLOW_DEFAULT_BRANCH_COMMIT");
  });
  it("test_agents_md_branching_cross_references_enforcement_surfaces", () => {
    const text = readText("AGENTS.md");
    expect(text).toContain("verify:branch");
    expect(text).toContain("branch-gate");
    expect(text).toContain(".githooks/pre-commit");
  });
  it("test_main_md_branching_rule_cites_policy_and_typed_flag", () => {
    const text = readText("main.md");
    expect(text).toContain("allowDirectCommitsToMaster");
    expect(text).toContain("#746");
    expect(text).toContain("#747");
    expect(text).toContain("deterministic-questions.md");
  });
  it("test_readme_has_branch_policy_section", () => {
    const text = readText("README.md");
    expect(text).toContain("Branch policy");
    expect(text).toContain("allowDirectCommitsToMaster");
    expect(text).toContain("task policy:show");
    expect(text).toContain("task policy:enforce-branches");
    expect(text).toContain("task policy:allow-direct-commits");
  });
  it("test_schema_declares_policy_definition", () => {
    const text = readText("vbrief/schemas/vbrief-core.schema.json");
    expect(text).toContain('"Policy":');
    expect(text).toContain('"allowDirectCommitsToMaster":');
    expect(text).toContain('"$ref": "#/$defs/Policy"');
  });
});
