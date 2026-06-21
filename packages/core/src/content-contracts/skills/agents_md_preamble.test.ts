import { describe, expect, it } from "vitest";
import { readRepoFile, repoFileExists } from "./helpers.js";

/** Port of tests/content/test_agents_md_preamble.py (#1838 #1530) */

const _AGENTS_MD = "AGENTS.md";

const agents_md_text = readRepoFile("AGENTS.md");

describe("test_agents_md_preamble", () => {
  it("agents_md_exists", () => {
    expect(repoFileExists("AGENTS.md")).toBeTruthy();
  });
  it("954_section_heading_present", () => {
    expect(/^##\s+Multi-agent orchestration discipline\s+\(#954\)\s*$/m.test(agents_md_text)).toBe(
      true,
    );
  });
  it("rest_by_default_rule_present", () => {
    expect(agents_md_text).toContain("prefer REST surfaces over GraphQL");
    for (const forbidden of [
      "gh issue view --json",
      "gh pr view --json",
      "gh pr ready",
      "gh pr update-branch",
    ]) {
      expect(agents_md_text).toContain(forbidden);
    }
  });
  it("no_draft_retoggle_rule_present", () => {
    expect(/toggle PR Draft.*Ready state at most once/.test(agents_md_text)).toBeTruthy();
  });
  it("rate_limit_throttle_rule_present", () => {
    expect(agents_md_text).toContain("gh api rate_limit");
    expect(
      agents_md_text.includes("graphql.remaining") || agents_md_text.includes("graphql_remaining"),
    ).toBe(true);
    const permit_patterns = [
      "probe\\s+`ghx api rate_limit`",
      "`ghx api rate_limit`\\s*\\(or\\s*`gh api rate_limit`\\)",
    ];
    for (const pattern of permit_patterns) {
      expect(!new RegExp(pattern).test(agents_md_text)).toBe(true);
    }
  });
  it("dispatcher_lifecycle_hygiene_rule_present", () => {
    expect(agents_md_text).toContain("Dispatcher-level lifecycle hygiene");
    expect(agents_md_text).toContain("all-or-nothing");
    expect(
      agents_md_text.includes("two separate dispatches") || agents_md_text.includes("two-dispatch"),
    ).toBe(true);
  });
  it("meta_rule_points_at_template", () => {
    expect(agents_md_text).toContain("templates/agent-prompt-preamble.md");
    expect(
      /Orchestrators dispatching implementation sub-agents MUST include the canonical preamble/.test(
        agents_md_text,
      ),
    ).toBeTruthy();
  });
  it("ghx_writes_correction_present", () => {
    expect(agents_md_text).toContain("cached read-only GET proxy");
    expect(
      agents_md_text.includes("single positional") ||
        agents_md_text.includes("single arg") ||
        agents_md_text.includes("accepts 1 arg"),
    ).toBe(true);
    expect(
      /[Ww]rites?\s+\(POST\/PATCH\/PUT\/DELETE.*\)?\s+(MUST|must)\s+fall through to\s+`?gh`?/.test(
        agents_md_text,
      ),
    ).toBeTruthy();
  });
  it("rules_use_required_must_marker", () => {
    const sectionMatch = agents_md_text.match(
      /^##\s+Multi-agent orchestration discipline\s+\(#954\)[\s\S]*?(?=^##\s|Z)/m,
    );
    expect(sectionMatch).not.toBeNull();
    const sectionText = sectionMatch?.[0] ?? "";
    const mustLines = sectionText.match(/^- !\s+/gm) ?? [];
    expect(mustLines.length).toBeGreaterThanOrEqual(5);
  });
});
