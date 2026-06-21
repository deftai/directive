import { describe, expect, it } from "vitest";
import { readRepoFile, repoFileExists } from "./helpers.js";

/** Port of tests/content/test_agent_prompt_preamble_template.py (#1838 #1530) */

const _TEMPLATE = "templates/agent-prompt-preamble.md";
const _REQUIRED_SECTION_HEADINGS = [
  "Read AGENTS.md before any other tool call",
  "#810 vBRIEF Implementation Intent Gate",
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
    "#810 vBRIEF Implementation Intent Gate",
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
    expect(templateText).toContain("task vbrief:preflight");
    expect(templateText).toContain("task vbrief:activate");
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
      "vbrief/active/2026-05-07-954-orchestrator-agents-md-preamble-template.vbrief.json",
    );
    expect(templateText).toContain("vbrief/completed/");
    expect(templateText).not.toContain("vbrief/.../954-orchestrator-agents-md-preamble-template");
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
});
