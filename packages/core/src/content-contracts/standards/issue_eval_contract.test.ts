/** Content contract for issue-eval SoT + thin skill (#3648). */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isFile, readText, repoRoot, resolveContentPath } from "./_helpers.js";

const CONTRACT = "contracts/issue-eval.md";
const SKILL_REL = "skills/deft-directive-issue-eval/SKILL.md";
const MAX_SKILL_LINES = 80;

const REQUIRED_CONTRACT_POINTERS = [
  "origin/master",
  "WIP census",
  "xbrief/active/",
  "xbrief/pending/",
  "plan-sequence",
  ".deft-scratch/issue-eval/",
  "sha12",
  "invocation-id",
  "No assist posture",
  "issue-eval-<issue>-<invocation-id>",
  "session:start --read-only",
  "swarm:launch",
  "#3649",
  "critique-recommend:",
  "design-critique: warranted",
  "VALID_DECISIONS",
  "xbrief/.eval/",
  "candidates.jsonl",
  "triage:*",
  "--concurrency",
  "REST",
];

const REQUIRED_SKILL_POINTERS = [
  "contracts/issue-eval.md",
  "Split read sources",
  "Verdict sink",
  "Evaluator worktrees",
  "Value advice grammar",
  "No GitHub writes",
  "Fan-out",
  "triage:evaluate",
];

function markdownHrefs(text: string): string[] {
  const hrefs: string[] = [];
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const href = (match[1] ?? "").trim();
    if (href.length > 0 && !href.startsWith("http")) {
      hrefs.push(href.split("#")[0] ?? href);
    }
  }
  return hrefs;
}

describe("issue-eval contract (#3648)", () => {
  it("exists with required pointers", () => {
    const text = readText(CONTRACT);
    for (const token of REQUIRED_CONTRACT_POINTERS) {
      expect(text, `contract missing ${token}`).toContain(token);
    }
    expect(text).toContain("⊗ Reuse `swarm:launch` until #3649");
    expect(text).toContain("⊗ Emit `design-critique: warranted | not warranted, because");
    expect(text).toContain("⊗ Widen `VALID_DECISIONS`");
  });

  it("publishes the thin router skill under the line cap", () => {
    expect(isFile(SKILL_REL)).toBe(true);
    expect(existsSync(resolveContentPath("skills/deft-directive-issue-eval"))).toBe(true);
    expect(existsSync(join(repoRoot(), "content/skills/deft-directive-issue-eval"))).toBe(true);
    const text = readText(SKILL_REL);
    const lineCount = text.split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(MAX_SKILL_LINES);
    for (const token of REQUIRED_SKILL_POINTERS) {
      expect(text, `skill missing ${token}`).toContain(token);
    }
  });

  it("resolves every path the skill names", () => {
    const skillPath = resolveContentPath(SKILL_REL);
    const skillDir = dirname(skillPath);
    const text = readText(SKILL_REL);
    const hrefs = markdownHrefs(text);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      const resolved = resolve(skillDir, href);
      expect(existsSync(resolved), `unresolved skill path ${href} -> ${resolved}`).toBe(true);
    }
  });

  it("keeps skill bodies free of contract-normative detail", () => {
    const text = readText(SKILL_REL);
    expect(text).not.toContain("VALID_DECISIONS");
    expect(text).not.toContain("defaultWorktree");
    expect(text).not.toContain("sha12");
  });

  it("indexes the skill on-demand and does not always-pin it", () => {
    const references = readText("REFERENCES.md");
    expect(references).toContain("deft-directive-issue-eval/SKILL.md");
    const agents = readText("AGENTS.md");
    const agentsEntry = readText("templates/agents-entry.md");
    expect(agents).not.toContain("deft-directive-issue-eval");
    expect(agentsEntry).not.toContain("deft-directive-issue-eval");
  });
});
