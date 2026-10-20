import { describe, expect, it } from "vitest";
import { readAgentsPreamble, repoFileExists } from "./helpers.js";

/** Port of tests/content/test_agents_md_preamble.py (#1838 #1530).
 *  #954 orchestration discipline lives in templates/agent-prompt-preamble.md (not root AGENTS.md).
 */

const preambleText = readAgentsPreamble();

describe("test_agents_md_preamble", () => {
  it("agents_preamble_template_exists", () => {
    expect(repoFileExists("templates/agent-prompt-preamble.md")).toBeTruthy();
  });

  it("954_canonical_preamble_present", () => {
    // Former AGENTS.md "## Multi-agent orchestration discipline (#954)" → preamble title.
    expect(preambleText).toContain("# Canonical orchestrator preamble (#954)");
  });

  it("rest_by_default_rule_present", () => {
    expect(preambleText).toContain("MUST prefer REST");
    for (const forbidden of [
      "gh issue view <N> --json",
      "gh pr view <N> --json",
      "gh pr ready",
      "gh pr update-branch",
    ]) {
      expect(preambleText).toContain(forbidden);
    }
  });

  it("no_draft_retoggle_rule_present", () => {
    expect(/at most one toggle per cycle/i.test(preambleText)).toBeTruthy();
    expect(preambleText).toContain("Draft");
    expect(preambleText).toContain("Ready");
  });

  it("rate_limit_throttle_rule_present", () => {
    expect(preambleText).toContain("gh api rate_limit");
    expect(preambleText).toContain("graphql.remaining");
    // Probe must stay on live `gh`, not ghx (see agent_prompt_preamble_template.test.ts).
    expect(!/ghx\s+api\s+rate_limit/.test(preambleText)).toBe(true);
  });

  it("dispatcher_lifecycle_hygiene_rule_present", () => {
    expect(preambleText).toContain("Dispatcher lifecycle hygiene");
    expect(preambleText).toContain("all-or-nothing");
    expect(preambleText).toContain("two dispatches");
  });

  it("meta_rule_orchestrators_must_include_preamble", () => {
    expect(preambleText).toContain("templates/agent-prompt-preamble.md");
    expect(
      /orchestrators[\s\S]*MUST include/i.test(preambleText) ||
        /MUST include[\s\S]*canonical preamble/i.test(preambleText),
    ).toBeTruthy();
  });

  it("ghx_writes_correction_present", () => {
    // Detail moved partly to scm/github.md; preamble still teaches cached GET + live gh mutations.
    expect(preambleText).toContain("cached read-only GET");
    expect(preambleText).toContain("`ghx` is read-only");
    expect(preambleText).toContain("mutations stay on live `gh`");
  });

  it("rules_use_required_must_marker", () => {
    const mustLines = preambleText.match(/^!\s+/gm) ?? [];
    const mustBulletLines = preambleText.match(/^-\s+!\s+/gm) ?? [];
    expect(mustLines.length + mustBulletLines.length).toBeGreaterThanOrEqual(5);
  });
});
