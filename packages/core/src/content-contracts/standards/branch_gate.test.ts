import { describe, expect, it } from "vitest";
import { readText } from "./_helpers.js";

describe("test_branch_gate.py", () => {
  it("test_pre_commit_hook_exists_and_calls_script", () => {
    const text = readText(".githooks/pre-commit");
    expect(text).toContain("run_deft verify:branch");
    expect(text).toContain("run_deft verify:encoding");
    expect(text).toContain("git rev-parse --show-toplevel");
    expect(text).toContain("_deft-run.sh");
    expect(text).not.toContain("preflight_branch.py");
  });
  it("test_pre_push_hook_exists_and_calls_script", () => {
    const text = readText(".githooks/pre-push");
    expect(text).toContain("run_deft preflight-gh --pre-push-stdin --project-root");
    expect(text).toContain("_deft-run.sh");
    expect(text).not.toContain("preflight_branch.py");
    expect(text).not.toContain("deft verify:branch");
  });
  it("test_pre_commit_xbrief_drift_guarded_like_conformance (#2406)", () => {
    const text = readText(".githooks/pre-commit");
    const guardStart = text.indexOf('[ -d "$REPO_ROOT/xbrief" ]');
    expect(guardStart).toBeGreaterThanOrEqual(0);
    const guardEnd = text.indexOf("fi", guardStart);
    expect(guardEnd).toBeGreaterThan(guardStart);
    const guardBlock = text.slice(guardStart, guardEnd);
    expect(guardBlock).toContain("verify:vbrief-conformance");
    expect(guardBlock).toContain("verify:xbrief-drift");
    expect(text.slice(guardEnd)).not.toContain("verify:xbrief-drift");
  });
  it("test_deft_run_sh_falls_back_to_local_cli", () => {
    const text = readText(".githooks/_deft-run.sh");
    expect(text).toContain("command -v deft");
    expect(text).toContain("packages/cli/dist/bin.js");
    expect(text).toContain("run_deft()");
  });
  it("test_deft_run_sh_prefers_local_in_framework_source (#2248)", () => {
    const text = readText(".githooks/_deft-run.sh");
    // Framework-source detection via the monorepo sentinel, plus the escape
    // hatch that forces the global for the rare inverse case.
    expect(text).toContain("pnpm-workspace.yaml");
    expect(text).toContain("DEFT_HOOKS_PREFER_GLOBAL");
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
    expect(text).toContain("verify:branch");
    expect(text).toContain("engine:invoke");
    expect(text).toContain("core.hooksPath");
  });
  it("test_policy_yml_declares_show_enforce_allow", () => {
    const text = readText("tasks/policy.yml");
    expect(text).toContain("show:");
    expect(text).toContain("enforce-branches:");
    expect(text).toContain("allow-direct-commits:");
    // #2126: policy.yml dispatches through the guarded :engine:invoke pattern
    // (global-deft fallback on consumer deposits), not a direct dist/bin.js call.
    expect(text).toContain(":engine:invoke");
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
  it("wires pr:check-closing-keywords in FP mode (#3969)", () => {
    const text = readText(".github/workflows/branch-gate.yml");
    expect(text).toContain("pr:check-closing-keywords");
    expect(text).toContain("--mode fp");
    expect(text).toContain("PR_NUMBER");
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
  it("ci merge-gate check:merge steps set the documented default-branch exemption (#3499)", () => {
    const ci = readText(".github/workflows/ci.yml");
    const envBlocks = checkMergeStepEnvBlocks(ci);
    expect(envBlocks, "expected two task check:merge steps (primary + failover)").toHaveLength(2);
    for (const [i, block] of envBlocks.entries()) {
      expect(block, `check:merge step ${i} missing documented exemption`).toMatch(
        /DEFT_ALLOW_DEFAULT_BRANCH_COMMIT:\s*"1"/,
      );
    }
  });
  it("workflow-level env does not set DEFT_ALLOW_DEFAULT_BRANCH_COMMIT (#3499)", () => {
    const ci = readText(".github/workflows/ci.yml");
    const workflowEnv = workflowLevelEnvBlock(ci);
    expect(workflowEnv).not.toContain("DEFT_ALLOW_DEFAULT_BRANCH_COMMIT");
  });
  it("local authoring path stays fail-closed without the env (#3499 / #747)", () => {
    const agents = readText("AGENTS.md");
    const hook = readText(".githooks/pre-commit");
    const taskfile = readText("Taskfile.yml");
    const readme = readText("README.md");
    expect(hook).toContain("run_deft verify:branch");
    expect(taskfile).toContain("verify:branch");
    expect(agents).toContain("verify:branch");
    expect(agents).toContain("DEFT_ALLOW_DEFAULT_BRANCH_COMMIT=1");
    expect(readme).toMatch(/Emergency bypass/i);
    expect(readme).toContain("DEFT_ALLOW_DEFAULT_BRANCH_COMMIT=1");
  });
});

/** Top-level `env:` block that precedes `jobs:` in ci.yml. */
function workflowLevelEnvBlock(ci: string): string {
  const lines = ci.split("\n");
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (start < 0 && lines[i] === "env:") {
      start = i + 1;
    }
    if (start >= 0 && lines[i] === "jobs:") {
      end = i;
      break;
    }
  }
  if (start < 0 || end < 0) {
    throw new Error("workflow-level env: block not found before jobs:");
  }
  return lines.slice(start, end).join("\n");
}

/**
 * Env blocks immediately under each `run: task check:merge` step.
 * Indentation-scoped so a later job-level `env:` is not collected.
 */
function checkMergeStepEnvBlocks(ci: string): string[] {
  const lines = ci.split("\n");
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s+run:\s+task check:merge\s*$/.test(lines[i] ?? "")) {
      continue;
    }
    const envLine = lines[i + 1] ?? "";
    const envMatch = envLine.match(/^(\s+)env:\s*$/);
    if (!envMatch) {
      throw new Error(`task check:merge at line ${i + 1} has no following env:`);
    }
    const indent = envMatch[1] ?? "";
    const childIndent = `${indent}  `;
    const collected: string[] = [];
    for (let j = i + 2; j < lines.length; j++) {
      const line = lines[j] ?? "";
      if (line.trim() === "" || line.startsWith(`${indent}#`) || line.startsWith(childIndent)) {
        collected.push(line);
        continue;
      }
      break;
    }
    blocks.push(collected.join("\n"));
  }
  return blocks;
}
