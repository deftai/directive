import { describe, expect, it } from "vitest";
import { readRepoFile, readSwarmSkillSurface, repoFileExists } from "./helpers.js";

/** Port of tests/content/test_agent_prompt_preamble_template.py (#1838 #1530) */

const _TEMPLATE = "templates/agent-prompt-preamble.md";
const _REQUIRED_SECTION_HEADINGS = [
  "Read AGENTS.md before any other tool call",
  "#810 xBRIEF Implementation Intent Gate",
  "PowerShell 5.1 non-ASCII rule",
  "pre-pr and review-cycle skills",
  "REST-by-default for read-only gh calls",
  "No Draft re-toggling within a single review cycle",
  "Rate-limit-aware throttle",
  "Sub-agent spawn rules",
  "Dispatcher lifecycle hygiene",
  "Mandatory DONE message even on early exit",
];

const templateText = readRepoFile("templates/agent-prompt-preamble.md");

describe("test_agent_prompt_preamble_template", () => {
  it("template_exists", () => {
    expect(repoFileExists("templates/agent-prompt-preamble.md")).toBeTruthy();
  });
  it("template_non_empty", () => {
    expect(templateText.length).toBeGreaterThan(0);
    expect(templateText.split("\n").length).toBeGreaterThanOrEqual(100);
  });
  it.each([
    "Read AGENTS.md before any other tool call",
    "#810 xBRIEF Implementation Intent Gate",
    "PowerShell 5.1 non-ASCII rule",
    "pre-pr and review-cycle skills",
    "REST-by-default for read-only gh calls",
    "No Draft re-toggling within a single review cycle",
    "Rate-limit-aware throttle",
    "Sub-agent spawn rules",
    "Dispatcher lifecycle hygiene",
    "Mandatory DONE message even on early exit",
  ])("template_contains_section %s", (heading_fragment) => {
    expect(templateText).toContain(heading_fragment);
  });
  it("template_references_954", () => {
    expect(templateText).toContain("#954");
  });
  it("template_cross_references_810_gate", () => {
    expect(templateText).toContain("task xbrief:preflight");
    expect(templateText).toContain("task xbrief:activate");
    expect(templateText).toContain("task scope:promote");
  });
  it("template_documents_session_ritual_headless_bypass", () => {
    expect(templateText).toContain("DEFT_SESSION_RITUAL_SKIP=1");
    expect(templateText).toContain("task verify:session-ritual");
    expect(templateText).toContain("verify:session-ritual");
    expect(templateText).toContain("verify:cache-fresh");
  });
  it("template_cross_references_798_encoding_rule", () => {
    expect(templateText.includes("#798") || templateText.includes("#236")).toBe(true);
    expect(/pathlib/.test(templateText)).toBeTruthy();
  });
  it("template_cross_references_727_subagent_rule", () => {
    expect(templateText).toContain("#727");
  });
  it("template_lists_forbidden_graphql_surfaces", () => {
    const forbidden_patterns = [
      ["gh\\s+issue\\s+view\\b.*--json", "gh issue view ... --json"],
      ["gh\\s+pr\\s+view\\b.*--json", "gh pr view ... --json"],
      ["gh\\s+pr\\s+ready\\b", "gh pr ready"],
      ["gh\\s+pr\\s+update-branch\\b", "gh pr update-branch"],
    ];
    for (const [pattern, _label] of forbidden_patterns) {
      expect(new RegExp(pattern).test(templateText)).toBeTruthy();
    }
  });
  it("template_dispatcher_hygiene_includes_anti_pattern_and_correct", () => {
    expect(templateText).toContain("WRONG");
    expect(templateText).toContain("CORRECT");
    expect(templateText).toContain("succeeded");
    expect(templateText).toContain("agent_id");
  });
  it("template_done_message_protocol_present", () => {
    for (const exit_marker of ["DONE:", "BLOCKED:", "FAILED:", "STOOD-DOWN:"]) {
      expect(templateText).toContain(exit_marker);
    }
  });
  it("template_drive_to_merge_ready_done_reservation_2843", () => {
    expect(templateText).toContain("drive-to: merge-ready` DONE reservation (#2843)");
    expect(templateText).toContain("Mid-cycle BLOCKED contract (#2843)");
    expect(templateText).toContain("REDISPATCH_OK");
    expect(templateText).toContain(
      "Emit `DONE` from a `drive-to: merge-ready` worker while merge-ready is false",
    );
  });
  it("template_thin_done_and_parent_tool_first_2943", () => {
    expect(templateText).toContain("Thin DONE is not success (#2943)");
    expect(templateText).toContain("Parent tool-first after leaf completion (#2943)");
    expect(templateText).toContain("subagent_announce");
    expect(templateText).toContain("tool-first");
    expect(templateText).toContain("sessions_yield");
    expect(templateText).toContain("prUrl");
    expect(templateText).toContain("mergeStatus");
    expect(templateText).toContain("emptyDiff");
    expect(templateText).toContain(
      "Treat thin DONE (no PR URL / merge evidence) as success (#2943)",
    );
    expect(templateText).toMatch(/⊗[^\n]*progress-only[^\n]*#2943|⊗[^\n]*Thin DONE[^\n]*#2943/);
  });
  it("template_completion_latch_one_consolidate_per_runid_3092", () => {
    // Portable orchestrator latch: second settle for same runId ⇒ silent (#3092).
    expect(templateText).toContain("Completion latch — one consolidate per runId (#3092)");
    expect(templateText).toContain("Completion latch (MUST)");
    expect(templateText).toContain("One user- or caller-visible consolidate per child `runId`");
    expect(templateText).toContain("identical or equivalent completion replay");
    expect(templateText).toMatch(/silent/);
    expect(templateText).toContain("NO_REPLY");
    expect(templateText).toContain("materially new");
    expect(templateText).toContain("completion replay storm");
    expect(templateText).toContain("Eval checklist (second settle same runId)");
    expect(templateText).toContain(
      "Second+ user-visible \"final\" for the same settled `runId`",
    );
    expect(templateText).toContain("Full dual-source / full test re-run solely because the settle");
    const swarmSkill = readSwarmSkillSurface();
    expect(swarmSkill).toContain("Completion latch after first consolidate (#3092)");
    expect(swarmSkill).toContain("templates/agent-prompt-preamble.md");
  });
  it("template_rate_limit_probe_uses_gh_not_ghx_with_q_flag", () => {
    expect(/gh\s+api\s+rate_limit\s+-q\s+'/.test(templateText)).toBeTruthy();
    expect(!/ghx\s+api\s+rate_limit\s+-q\b/.test(templateText)).toBe(true);
  });
  it("template_section_5_qualifies_mutation_graphql_freedom", () => {
    expect(templateText).toContain("Mutations to REST endpoints");
    expect(templateText).toContain("do not consume GraphQL budget");
    expect(templateText.includes("`/graphql` endpoint") || templateText.includes("/graphql")).toBe(
      true,
    );
    expect(templateText).not.toContain("are inherently GraphQL-free");
  });
  it("template_footer_concrete_vbrief_path", () => {
    expect(templateText).toContain(
      "xbrief/active/2026-05-07-954-orchestrator-agents-md-preamble-template.xbrief.json",
    );
    expect(templateText).toContain("xbrief/completed/");
    expect(templateText).not.toContain("xbrief/.../954-orchestrator-agents-md-preamble-template");
  });
  it("template_documents_runtime_and_github_auth_mode_fields", () => {
    expect(templateText).toContain("Runtime and GitHub auth mode");
    expect(templateText).toContain("runtime_mode");
    expect(templateText).toContain("github_auth_mode");
    expect(templateText).toContain("local-unsandboxed");
    expect(templateText).toContain("cursor-native-sandbox");
    expect(templateText).toContain("cloud-headless");
    expect(templateText).toContain("host-gh");
    expect(templateText).toContain("injected-token");
  });
  it("template_windows_2563_does_not_prefer_cloud_or_concurrency_one", () => {
    // Follow-up to #2563: mitigations stay; prefer-cloud / concurrency=1 prose must not return.
    expect(templateText).toContain("Windows Cursor Task-tool console windows (#2563)");
    expect(templateText).toContain("windowsHide");
    expect(templateText).toContain("ts-build-fresh");
    expect(templateText).not.toMatch(/Prefer in-parent implementation or cloud workers/i);
    expect(templateText).not.toMatch(/keep concurrency at \*\*1\*\*/i);
    expect(templateText).toContain("Do not route to cloud solely because the host is Windows");
    expect(templateText).toContain("do not force concurrency=1 because of #2563");
  });
  it("swarm_skill_windows_2563_does_not_prefer_cloud_or_concurrency_one", () => {
    const swarmSkill = readSwarmSkillSurface();
    const bulletMatch = swarmSkill.match(
      /! \*\*Windows \+ Cursor Task-tool console windows \(#2563\):\*\*[^\n]+/,
    );
    expect(bulletMatch).not.toBeNull();
    const bullet = bulletMatch?.[0] ?? "";
    expect(bullet).toContain("windowsHide");
    expect(bullet).toContain("ts-build-fresh");
    expect(bullet).toContain("first-class");
    expect(bullet).not.toMatch(/Prefer one of: \(1\) in-parent/i);
    expect(bullet).not.toMatch(/keep local Task concurrency at \*\*1\*\*/i);
    expect(bullet).toContain("not cloud-for-Windows");
    expect(bullet).toContain("do not force concurrency=1 for #2563");
  });
  it("template_cloud_pr_shepherd_review_monitor_worked_example_present", () => {
    expect(templateText).toContain("Cloud PR-shepherd dispatch");
    expect(templateText).toContain("review-monitor");
    expect(templateText).toContain("babysit-pull-request-in-cloud");
    expect(templateText).toContain("deft-directive-review-cycle/SKILL.md");
    expect(templateText).toContain("skills-cursor/babysit");
  });
  it("template_babysit_intent_routes_to_review_cycle", () => {
    expect(templateText).toContain("babysit-pull-request-in-cloud");
    expect(templateText).toContain("#2261");
    expect(templateText).toContain("PR shepherding intent");
  });
  it("template_review_cycle_evidence_enum_3090", () => {
    expect(templateText).toContain("review_cycle");
    expect(templateText).toContain("#3090");
    expect(templateText).toContain("in_progress:<pr>#<monitor_or_lease_ref>");
    expect(templateText).toContain("verify:l4-owner");
    expect(templateText).toContain("silent hold");
    expect(templateText).toMatch(/started.*pending.*initiated|freeform `review_cycle: started`/s);
  });
  it("template_identity_section_forbids_host_gh_only_for_wrong_mode", () => {
    expect(templateText).toContain("mode-aware GitHub credential rules");
    expect(templateText).toContain("github_auth_mode: injected-token");
    expect(templateText).toContain("runtime_mode: cloud-headless");
    expect(templateText).toContain(
      "Host `gh` fallback is forbidden in injected-token and cloud-headless modes",
    );
    expect(templateText).toContain("github_auth_mode: host-gh");
    expect(templateText).toContain("explicitly authorises host `gh`");
  });
  it("template_contract_carries_mode_labels_not_token_values", () => {
    expect(templateText).toContain("GH_TOKEN");
    expect(templateText).toContain("GITHUB_TOKEN");
    expect(templateText).not.toContain("ghp_");
    expect(templateText).not.toContain("github_pat_");
  });
  it("template_lists_openclaw_as_first_class_backend_2879", () => {
    expect(templateText).toContain("OpenClaw");
    expect(templateText).toContain("sessions_spawn");
    expect(templateText).toContain("openclaw"); // platform descriptor, not selected_backend enum
    expect(templateText).toContain("#2879");
    expect(templateText).toContain("OpenClaw `sessions_spawn` / heartbeat mapping (#2879)");
    expect(templateText).toContain("parent push / announce");
    // Must NOT invent a swarmSubagentBackend enum value rejected by policy
    expect(templateText).toContain("do not write `selected_backend: openclaw`");
    expect(templateText).toContain("startup grace");
    expect(templateText).toContain("Parent ensures scratch dir");
  });
});
