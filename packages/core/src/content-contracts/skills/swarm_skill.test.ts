import { describe, expect, it } from "vitest";
import { readRepoFile } from "./helpers.js";

/** Port of tests/content/test_swarm_skill.py (#1838 #1530) */

const _SWARM_PATH = "skills/deft-directive-swarm/SKILL.md";
const _STEP3_NO_CHECKOUT_TOKENS = [
  "⊗",
  "git checkout",
  "worktree the merging agent does not own",
  "git fetch origin",
  "NEVER touch HEAD",
];
const _STEP3_COMPANION_MAY_TOKENS = [
  "merger MAY remove",
  "git worktree remove",
  "git branch -D",
  "MUST NOT alter any other worktree",
];
const _ANTI_PATTERN_TOKENS = [
  "cd <other-worktree>; git checkout master --quiet",
  "PR #797",
  "#727",
  "#800",
];
const _PHASE0_STEP0_HEADER = "### Step 0: Queue-driven cohort selection (#1142 / N2)";
const _PHASE0_STEP0_5_HEADER = "### Step 0.5: Lifecycle Bridge";
const _PHASE0_SUBPHASE_HEADERS = [
  "#### Phase 0a -- State overview via `task triage:summary` (D2 / #1122)",
  "#### Phase 0b -- Ranked candidates via `task triage:queue` (D11 / #1128)",
  "#### Phase 0c -- Promote-fill-cap loop",
  "#### Phase 0d -- Cohort dispatch",
];
const _PHASE0_VERB_TOKENS = [
  "task triage:summary",
  "task triage:queue --state=accept --limit=20",
  "task scope:promote",
  "wipCap",
  "Cache-as-authoritative work selection (#1149)",
];
const _PHASE0_WIP_CAP_EXIT_TOKENS = [
  "WIP-cap exit-clean",
  "stops adding to the cohort and exits cleanly",
  "count of what was filled",
  "demote",
  "--force",
];
const _PHASE0_COHORT_RECOVERY_TOKENS = [
  "Cohort recovery",
  "unpicked",
  "stay queued for the next session",
  "queue is the canonical record",
];
const _PHASE0_D18_FALLBACK_TOKENS = [
  "D18 #1136 fallback",
  "TODO(#1136)",
  "--from-issue=<N>",
  "OPEN but not",
];
const _SWEEP_STEP_HEADER = "### Step 1.5: Cohort Completion Sweep (#1487)";
const _SWEEP_STEP_END = "### Step 2: Close Issues and Update Origins";
const _SWEEP_STEP_TOKENS = [
  "task swarm:complete-cohort",
  "scripts/swarm_complete_cohort.py",
  "REQUIRED",
  "Stage 1",
  "Stage 2",
  "Interactive path",
  "Headless / multi-worker path",
  "task vbrief:validate",
  "#1485",
  "#1487",
];
const _PREAMBLE_PATH = "templates/agent-prompt-preamble.md";
const _STEP1B_HEADER = "### Step 1b: Provider-neutral sub-agent routing (#1531)";
const _STEP1B_END = "### Step 2a: Orchestrated Launch (start_agent available)";
const _PREAMBLE_SECTION_HEADER = "## 2.6 Provider-neutral worker metadata (#1531)";
const _PREAMBLE_SECTION_END = "## 3. PowerShell 5.1 non-ASCII rule (#798)";
const _PROVIDER_NEUTRAL_SWARM_TOKENS = [
  "provider-neutral",
  "Heterogeneous dispatch is provider-neutral",
  "Dispatch provider",
  "Worker role",
  "Model or agent selection",
  "Composer-class",
  "Grok Build",
  "Cursor/cloud",
  "future adapter",
  "not a Grok Build-only path",
];
const _PROVIDER_NEUTRAL_SWARM_ANTI_PATTERN_TOKENS = [
  "Grok Build-only",
  "#1531",
  "Composer-class",
  "Cursor/cloud",
  "future adapter",
];
const _PROVIDER_NEUTRAL_PREAMBLE_TOKENS = [
  "provider-neutral",
  "Composer-class coding agents",
  "Grok Build (`spawn_subagent`)",
  "Cursor/cloud agents",
  "future adapters",
  "## Worker metadata",
  "dispatch_provider",
  "worker_role",
  "selected_backend",
  "routing_policy",
  "Role-boundary expectations (all providers)",
  "dispatch envelope",
];
const _STEP1A_HEADER = "### Step 1a: Worker Runtime and GitHub Auth Preflight (#1557)";
const _STEP1A_END = "### Step 1b: Provider-neutral sub-agent routing (#1531)";
const _SANDBOX_AUTH_TOKENS = [
  "scripts/platform_capabilities.py",
  "scripts/github_auth_modes.py",
  "local-unsandboxed",
  "cursor-native-sandbox",
  "cloud-headless",
  "sandbox_uid_remap",
  "sandbox-remapped-local-user",
  "sandbox view",
  "host-gh",
  "injected-token",
  "missing_injected_token",
  "gh auth status",
  "Full-access execution",
  "Trusted `gh` command allowlisting",
  "Injected-token handoff",
  "docs/subagent-heartbeat.md",
  "#1557",
];
const _SANDBOX_AUTH_ANTI_PATTERN_TOKENS = [
  "parent-shell `gh auth status`",
  "sandbox UID 0",
  "#1557",
];
const _PHASE0_BACKEND_HEADER =
  "#### Phase 0e -- Interactive sub-agent backend selection (DEPRECATED -- #1568 / superseded by #1739)";
const _PHASE0_BACKEND_END = "#### Phase 0f -- Greenfield swarm-ready bootstrap (#1053)";
// Tokens that MUST still be present in the deprecated Phase 0e block (#1891):
// it becomes a supersession pointer, not an interactive menu.
const _INTERACTIVE_BACKEND_TOKENS = [
  "This phase is superseded.",
  "Per-role operator model routing",
  ".deft/routing.local.json",
  "task verify:routing -- --advise",
  "task swarm:routing-set",
  "plan.policy.swarmSubagentBackend",
  "#1891",
  "do not consult them for new work",
];
const _GREENFIELD_BOOTSTRAP_HEADER = "#### Phase 0f -- Greenfield swarm-ready bootstrap (#1053)";
const _GREENFIELD_BOOTSTRAP_END = "#### Manual / GitHub-issue escape hatch";
const _GREENFIELD_BOOTSTRAP_TOKENS = [
  "greenfield swarm-ready bootstrap",
  "project infrastructure is separate from machine-tool availability",
  "git repository",
  "GitHub remote visibility",
  "Taskfile wiring",
  "install layout consistency",
  "scratch/worktree readiness",
  "task`, `uv`, `python`, `gh`, and `git`",
  "#1187",
  "exact remediation path",
  "explicit approval before creating or changing",
  "repo, remote, Taskfile, install layout, or gitignore state",
  "freshly setup-created candidates",
  "one explicit batch confirmation",
];
const _INTERACTIVE_WORKTREE_TOKENS = [
  ".deft-scratch/worktrees/<story-id>",
  "launch manifest's resolved `worktree_path`",
  "deterministic ignored scratch paths",
  "sibling checkout directories",
  "%TEMP%",
  "OS temp",
  "explicit override",
  "throwaway CI or rehearsal runs",
];
const _GENERIC_TERMINAL_TOKENS = [
  "generic-terminal",
  "Serial self-execution downgrade",
  "explicit operator consent",
  "one story at a time",
  "not true concurrent swarm execution",
  "manual terminal prompt-paste fallback remains available",
  "Do not describe this downgrade as a swarm",
];
const _PHASE6_HEADER = "## Phase 6 — Close";
const _PHASE6_END = "## Crash Recovery";
const _PHASE6_LIFECYCLE_COMMIT_TOKENS = [
  "task scope:complete",
  "chore(vbrief): complete <slugs> post-merge",
  "git push origin <configured-base-branch>",
  "git add -A vbrief/",
  "git merge --ff-only origin/<configured-base-branch>",
  "non-fast-forward",
  "check_vbrief_lifecycle_sync",
  "task reconcile:issues -- --apply-lifecycle-fixes",
  "scripts/reconcile_issues.py",
  "skills/deft-directive-release/SKILL.md",
  "authoritative post-swarm lifecycle record",
  "#1358",
];

function _read_swarm() {
  return readRepoFile(_SWARM_PATH);
}

function _phase6_step3_block(text: string) {
  const start = text.indexOf("### Step 3: Update Master");
  expect(start).not.toBe(-1);
  const end = text.indexOf("### Step 4", start);
  expect(end).not.toBe(-1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

function _phase0_step0_block(text: string) {
  const start = text.indexOf(_PHASE0_STEP0_HEADER);
  expect(start).not.toBe(-1);
  const end = text.indexOf(_PHASE0_STEP0_5_HEADER, start);
  expect(end).not.toBe(-1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

function _sweep_step_block(text: string) {
  const start = text.indexOf(_SWEEP_STEP_HEADER);
  expect(start).not.toBe(-1);
  const end = text.indexOf(_SWEEP_STEP_END, start);
  expect(end).not.toBe(-1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

function _read_preamble() {
  return readRepoFile(_PREAMBLE_PATH);
}

function _step1b_block(text: string) {
  const start = text.indexOf(_STEP1B_HEADER);
  expect(start).not.toBe(-1);
  const end = text.indexOf(_STEP1B_END, start);
  expect(end).not.toBe(-1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

function _preamble_section_26_block(text: string) {
  const start = text.indexOf(_PREAMBLE_SECTION_HEADER);
  expect(start).not.toBe(-1);
  const end = text.indexOf(_PREAMBLE_SECTION_END, start);
  expect(end).not.toBe(-1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

function _step1a_block(text: string) {
  const start = text.indexOf(_STEP1A_HEADER);
  expect(start).not.toBe(-1);
  const end = text.indexOf(_STEP1A_END, start);
  expect(end).not.toBe(-1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

function _phase0_backend_block(text: string) {
  const start = text.indexOf(_PHASE0_BACKEND_HEADER);
  expect(start).not.toBe(-1);
  const end = text.indexOf(_PHASE0_BACKEND_END, start);
  expect(end).not.toBe(-1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

function _greenfield_bootstrap_block(text: string) {
  const start = text.indexOf(_GREENFIELD_BOOTSTRAP_HEADER);
  expect(start).not.toBe(-1);
  const end = text.indexOf(_GREENFIELD_BOOTSTRAP_END, start);
  expect(end).not.toBe(-1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

function _phase2_mode_b_block(text: string) {
  const start = text.indexOf("#### Mode B -- Monitor-created worktrees (interactive path)");
  expect(start).not.toBe(-1);
  const end = text.indexOf("### Step 2: Generate Prompt Files", start);
  expect(end).not.toBe(-1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

function _runtime_detection_block(text: string) {
  const start = text.indexOf("### Step 1: Runtime Capability Detection");
  expect(start).not.toBe(-1);
  const end = text.indexOf("### Step 1a: Worker Runtime and GitHub Auth Preflight", start);
  expect(end).not.toBe(-1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

function _phase6_block(text: string) {
  const start = text.indexOf(_PHASE6_HEADER);
  expect(start).not.toBe(-1);
  const end = text.indexOf(_PHASE6_END, start);
  expect(end).not.toBe(-1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe("test_swarm_skill", () => {
  it("swarm_deterministic_questions_are_host_portable", () => {
    const text = _read_swarm();
    expect(text).toContain("render the canonical numbered menu in chat");
    expect(text).toContain("numeric option labels");
    expect(text).toContain("exact displayed option text");
    expect(text).toContain("fallback chat replies MUST map only to the displayed number");
  });
  it.each([
    "⊗",
    "git checkout",
    "worktree the merging agent does not own",
    "git fetch origin",
    "NEVER touch HEAD",
  ])("swarm_phase6_step3_no_checkout_rule_present %s", (token) => {
    const block = _phase6_step3_block(_read_swarm());
    expect(block).toContain(token);
  });
  it("swarm_phase6_step3_no_checkout_rule_uses_canonical_glyph", () => {
    const block = _phase6_step3_block(_read_swarm());
    expect(block).not.toContain("Γèù");
  });
  it.each([
    "merger MAY remove",
    "git worktree remove",
    "git branch -D",
    "MUST NOT alter any other worktree",
  ])("swarm_phase6_step3_companion_may_rule_present %s", (token) => {
    const block = _phase6_step3_block(_read_swarm());
    expect(block).toContain(token);
  });
  it("swarm_phase6_step3_companion_uses_must_marker", () => {
    const block = _phase6_step3_block(_read_swarm());
    expect(/^[\s-]*!\s.*merger MAY remove/m.test(block)).toBe(true);
  });
  it.each([
    "cd <other-worktree>; git checkout master --quiet",
    "PR #797",
    "#727",
    "#800",
  ])("swarm_anti_patterns_800_bullet_present %s", (token) => {
    const text = _read_swarm();
    const anti_start = text.indexOf("## Anti-Patterns");
    expect(anti_start).not.toBe(-1);
    const anti_block = text.slice(anti_start, undefined);
    expect(anti_block).toContain(token);
  });
  it("swarm_anti_patterns_800_bullet_is_prohibition", () => {
    const text = _read_swarm();
    const anti_start = text.indexOf("## Anti-Patterns");
    expect(anti_start).not.toBe(-1);
    const anti_block = text.slice(anti_start, undefined);
    let found = false;
    for (const line of anti_block.split("\n")) {
      if (line.includes("PR #797") && line.includes("git checkout")) {
        expect(line).toContain("⊗");
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });
  it.each([
    "#### Phase 0a -- State overview via `task triage:summary` (D2 / #1122)",
    "#### Phase 0b -- Ranked candidates via `task triage:queue` (D11 / #1128)",
    "#### Phase 0c -- Promote-fill-cap loop",
    "#### Phase 0d -- Cohort dispatch",
  ])("swarm_phase0_subphase_header_present %s", (header) => {
    const block = _phase0_step0_block(_read_swarm());
    expect(block).toContain(header);
  });
  it("swarm_phase0_subphase_headers_in_canonical_order", () => {
    const block = _phase0_step0_block(_read_swarm());
    let searchFrom = 0;
    const positions = _PHASE0_SUBPHASE_HEADERS.map((h) => {
      const idx = block.indexOf(h, searchFrom);
      expect(idx).not.toBe(-1);
      searchFrom = idx + h.length;
      return idx;
    });
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
  });
  it.each([
    "task triage:summary",
    "task triage:queue --state=accept --limit=20",
    "task scope:promote",
    "wipCap",
    "Cache-as-authoritative work selection (#1149)",
  ])("swarm_phase0_verb_tokens_present %s", (token) => {
    const block = _phase0_step0_block(_read_swarm());
    expect(block).toContain(token);
  });
  it.each([
    "WIP-cap exit-clean",
    "stops adding to the cohort and exits cleanly",
    "count of what was filled",
    "demote",
    "--force",
  ])("swarm_phase0_wip_cap_exit_prose_present %s", (token) => {
    const block = _phase0_step0_block(_read_swarm());
    expect(block).toContain(token);
  });
  it.each([
    "Cohort recovery",
    "unpicked",
    "stay queued for the next session",
    "queue is the canonical record",
  ])("swarm_phase0_cohort_recovery_prose_present %s", (token) => {
    const block = _phase0_step0_block(_read_swarm());
    expect(block).toContain(token);
  });
  it.each([
    "D18 #1136 fallback",
    "TODO(#1136)",
    "--from-issue=<N>",
    "OPEN but not",
  ])("swarm_phase0_d18_1136_fallback_token_present %s", (token) => {
    const block = _phase0_step0_block(_read_swarm());
    expect(block).toContain(token);
  });
  it.each([
    "task swarm:complete-cohort",
    "scripts/swarm_complete_cohort.py",
    "REQUIRED",
    "Stage 1",
    "Stage 2",
    "Interactive path",
    "Headless / multi-worker path",
    "task vbrief:validate",
    "#1485",
    "#1487",
  ])("swarm_phase6_cohort_sweep_token_present %s", (token) => {
    const block = _sweep_step_block(_read_swarm());
    expect(block).toContain(token);
  });
  it("swarm_phase6_cohort_sweep_is_required_rule", () => {
    const block = _sweep_step_block(_read_swarm());
    expect(/!\s+\*\*REQUIRED\.\*\*/m.test(block)).toBe(true);
  });
  it("swarm_anti_patterns_1487_bullet_present", () => {
    const text = _read_swarm();
    const anti_start = text.indexOf("## Anti-Patterns");
    expect(anti_start).not.toBe(-1);
    const anti_block = text.slice(anti_start, undefined);
    let found = false;
    for (const line of anti_block.split("\n")) {
      if (line.includes("#1487") && line.includes("swarm:complete-cohort")) {
        expect(line).toContain("⊗");
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });
  it.each([
    "provider-neutral",
    "Heterogeneous dispatch is provider-neutral",
    "Dispatch provider",
    "Worker role",
    "Model or agent selection",
    "Composer-class",
    "Grok Build",
    "Cursor/cloud",
    "future adapter",
    "not a Grok Build-only path",
  ])("provider_neutral_swarm_step1b_token_present %s", (token) => {
    const block = _step1b_block(_read_swarm());
    expect(block).toContain(token);
  });
  it("provider_neutral_swarm_step1b_separates_three_concerns", () => {
    const block = _step1b_block(_read_swarm());
    const positions = ["Dispatch provider", "Worker role", "Model or agent selection"].map(
      (label) => block.indexOf(label),
    );
    expect(positions.every((p) => p !== -1)).toBeTruthy();
    expect(positions).toEqual([...positions].sort());
  });
  it.each([
    "Grok Build-only",
    "#1531",
    "Composer-class",
    "Cursor/cloud",
    "future adapter",
  ])("provider_neutral_swarm_anti_pattern_token_present %s", (token) => {
    const text = _read_swarm();
    const anti_start = text.indexOf("## Anti-Patterns");
    expect(anti_start).not.toBe(-1);
    const anti_block = text.slice(anti_start, undefined);
    expect(anti_block).toContain(token);
  });
  it.each([
    "provider-neutral",
    "Composer-class coding agents",
    "Grok Build (`spawn_subagent`)",
    "Cursor/cloud agents",
    "future adapters",
    "## Worker metadata",
    "dispatch_provider",
    "worker_role",
    "selected_backend",
    "routing_policy",
    "Role-boundary expectations (all providers)",
    "dispatch envelope",
  ])("provider_neutral_preamble_section_26_token_present %s", (token) => {
    const block = _preamble_section_26_block(_read_preamble());
    expect(block).toContain(token);
  });
  it("provider_neutral_preamble_worker_metadata_is_required_rule", () => {
    const block = _preamble_section_26_block(_read_preamble());
    expect(/!\s+Every intentional backend-routed dispatch MUST carry/m.test(block)).toBe(true);
  });
  it.each([
    "scripts/platform_capabilities.py",
    "scripts/github_auth_modes.py",
    "local-unsandboxed",
    "cursor-native-sandbox",
    "cloud-headless",
    "sandbox_uid_remap",
    "sandbox-remapped-local-user",
    "sandbox view",
    "host-gh",
    "injected-token",
    "missing_injected_token",
    "gh auth status",
    "Full-access execution",
    "Trusted `gh` command allowlisting",
    "Injected-token handoff",
    "docs/subagent-heartbeat.md",
    "#1557",
  ])("swarm_phase3_step1a_sandbox_auth_token_present %s", (token) => {
    const block = _step1a_block(_read_swarm());
    expect(block).toContain(token);
  });
  it("swarm_phase3_step1a_uid_remap_not_host_root", () => {
    const block = _step1a_block(_read_swarm());
    expect(block).toContain("not real root");
    expect(block).toContain("host-root access");
  });
  it.each([
    "parent-shell `gh auth status`",
    "sandbox UID 0",
    "#1557",
  ])("swarm_anti_patterns_1557_token_present %s", (token) => {
    const text = _read_swarm();
    const anti_start = text.indexOf("## Anti-Patterns");
    expect(anti_start).not.toBe(-1);
    const anti_block = text.slice(anti_start, undefined);
    expect(anti_block).toContain(token);
  });
  it.each(
    _INTERACTIVE_BACKEND_TOKENS,
  )("swarm_phase0_backend_selection_token_present %s", (token) => {
    const block = _phase0_backend_block(_read_swarm());
    expect(block).toContain(token);
  });
  it("swarm_phase0d_routes_through_backend_selection_before_bridge", () => {
    const text = _read_swarm();
    const phase0d = text.indexOf("#### Phase 0d -- Cohort dispatch");
    const phase0e = text.indexOf(_PHASE0_BACKEND_HEADER);
    expect(phase0d).not.toBe(-1);
    expect(phase0e).not.toBe(-1);
    expect(phase0d).toBeLessThan(phase0e);
    const block = text.slice(phase0d, phase0e);
    // Phase 0d references Phase 0e as deprecated (#1891)
    expect(block).toContain("Phase 0e below");
  });
  it("swarm_phase0_backend_menu_uses_visible_numbered_options", () => {
    // Phase 0e is deprecated (#1891): no menu; verify the routing pointer is present
    const block = _phase0_backend_block(_read_swarm());
    expect(block).toContain("task swarm:routing-set");
    expect(block).toContain("task verify:routing");
  });
  it("swarm_phase0_backend_followup_menu_uses_visible_numbered_options", () => {
    // Phase 0e is deprecated (#1891): no follow-up menu; verify routing pointer
    const block = _phase0_backend_block(_read_swarm());
    expect(block).toContain("task swarm:routing-set");
  });
  it("swarm_phase0_backend_menu_keeps_discuss_back_final", () => {
    // Phase 0e is deprecated (#1891): MUST NOT directive replaces the menu
    const block = _phase0_backend_block(_read_swarm());
    expect(block).toContain("⊗");
    expect(block).toContain("swarmSubagentBackend");
  });
  it.each([
    "greenfield swarm-ready bootstrap",
    "project infrastructure is separate from machine-tool availability",
    "git repository",
    "GitHub remote visibility",
    "Taskfile wiring",
    "install layout consistency",
    "scratch/worktree readiness",
    "task`, `uv`, `python`, `gh`, and `git`",
    "#1187",
    "exact remediation path",
    "explicit approval before creating or changing",
    "repo, remote, Taskfile, install layout, or gitignore state",
    "freshly setup-created candidates",
    "one explicit batch confirmation",
  ])("swarm_phase0_greenfield_bootstrap_token_present %s", (token) => {
    const block = _greenfield_bootstrap_block(_read_swarm());
    expect(block).toContain(token);
  });
  it.each([
    ".deft-scratch/worktrees/<story-id>",
    "launch manifest's resolved `worktree_path`",
    "deterministic ignored scratch paths",
    "sibling checkout directories",
    "%TEMP%",
    "OS temp",
    "explicit override",
    "throwaway CI or rehearsal runs",
  ])("swarm_phase2_interactive_worktree_default_token_present %s", (token) => {
    const block = _phase2_mode_b_block(_read_swarm());
    expect(block).toContain(token);
  });
  it("swarm_phase2_no_longer_defaults_to_sibling_example_paths", () => {
    const block = _phase2_mode_b_block(_read_swarm());
    expect(block).not.toContain("E:\\Repos\\deft-agent1");
    expect(block).not.toContain("E:\\Repos\\deft-agent2");
  });
  it.each([
    "generic-terminal",
    "Serial self-execution downgrade",
    "explicit operator consent",
    "one story at a time",
    "not true concurrent swarm execution",
    "manual terminal prompt-paste fallback remains available",
    "Do not describe this downgrade as a swarm",
  ])("swarm_runtime_generic_terminal_serial_downgrade_token_present %s", (token) => {
    const block = _runtime_detection_block(_read_swarm());
    expect(block).toContain(token);
  });
  it.each([
    "task scope:complete",
    "chore(vbrief): complete <slugs> post-merge",
    "git push origin <configured-base-branch>",
    "git add -A vbrief/",
    "git merge --ff-only origin/<configured-base-branch>",
    "non-fast-forward",
    "check_vbrief_lifecycle_sync",
    "task reconcile:issues -- --apply-lifecycle-fixes",
    "scripts/reconcile_issues.py",
    "skills/deft-directive-release/SKILL.md",
    "authoritative post-swarm lifecycle record",
    "#1358",
  ])("swarm_phase6_lifecycle_commit_push_token_present %s", (token) => {
    const block = _phase6_block(_read_swarm());
    expect(block).toContain(token);
  });
  it("swarm_phase6_lifecycle_commit_step_is_required_rule", () => {
    const block = _phase6_block(_read_swarm());
    const start = block.indexOf(
      "### Step 2b: Commit and Push the Post-Merge Lifecycle Record (#1358)",
    );
    expect(start).not.toBe(-1);
    expect(/!\s+\*\*REQUIRED\.\*\*/m.test(block.slice(start))).toBe(true);
  });
  it("swarm_anti_patterns_1358_bullet_present", () => {
    const text = _read_swarm();
    const anti_start = text.indexOf("## Anti-Patterns");
    expect(anti_start).not.toBe(-1);
    const anti_block = text.slice(anti_start, undefined);
    let found = false;
    for (const line of anti_block.split("\n")) {
      if (line.includes("#1358") && line.includes("chore(vbrief)")) {
        expect(line).toContain("⊗");
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });
});
