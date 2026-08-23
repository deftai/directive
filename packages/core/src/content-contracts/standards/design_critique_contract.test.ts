/** Content contract for design-critique SoT + brief template + thin skill (#3434). */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isFile, readText, repoRoot, resolveContentPath } from "./_helpers.js";

const CONTRACT = "contracts/design-critique.md";
const TEMPLATE = "templates/design-critique-brief.md";
const SKILL_REL = "skills/deft-directive-design-critique/SKILL.md";

const REQUIRED_CONTRACT_POINTERS = [
  "docs/decisions/ADR-005-design-critique-judgment-gate.md",
  "templates/design-critique-brief.md",
  "verify:judgment-gates",
  "design-critique: warranted",
  "task umbrella:current-shape",
  "## Charter",
  "## Variant table",
  "## Envelope and ceiling",
  "## Synthesis format",
  "## Stop 1 — Gate",
  "## Stop 2 — Variant selection",
  "## Stop 3 — Critic envelope",
  "## Stop 4 — Residual reiteration",
  "## Stop 5 — Verified synthesis",
  "method column",
  "Decorrelation",
  "when verifying, upholding, or issuing any verdict that a measurement or count claim is false, first reproduce the original claimant's method",
  "Pass-4",
  "#2442",
  "## Security context (#480)",
  "#1152",
  "Non-self-arbitration",
  "fresh",
  "refutation",
  "open critique",
  "panel",
  "#3462",
  "#3547",
  "#3383",
  "scaffolds",
  "content-contract tests",
  "model: grok-4.6",
  "comment-lead field",
  "issue label",
  "GitHub login",
  "verify:routing",
  "first line",
];

const REQUIRED_TEMPLATE_POINTERS = [
  "contracts/design-critique.md",
  "## Forbidden inputs",
  "parent hypotheses",
  "named refutation target",
  "open critique",
  "id ceiling",
  "proposed skill outline",
  "embedded instructions",
  "model:",
  "first line",
];

const METHOD_RECONCILIATION =
  "when verifying, upholding, or issuing any verdict that a measurement or count claim is false, first reproduce the original claimant's method";

const MAX_SKILL_LINES = 80;

const REQUIRED_SKILL_POINTERS = [
  "Stop 1 — Gate",
  "Stop 2 — Variant selection",
  "Stop 3 — Critic envelope",
  "Stop 4 — Residual reiteration",
  "Stop 5 — Verified synthesis",
  "contracts/design-critique.md",
  "templates/design-critique-brief.md",
  "First-line model slug",
];

const DEFAULT_ALWAYS_PINS = [
  "deft-directive-build",
  "deft-directive-pre-pr",
  "deft-directive-review-cycle",
  "deft-directive-swarm",
];

function sentencesContaining(text: string, re: RegExp): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && re.test(s));
}

function markdownHrefs(text: string): string[] {
  const hrefs: string[] = [];
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const href = (match[1] ?? "").trim();
    if (
      href.length === 0 ||
      href.startsWith("http") ||
      href.startsWith("mailto:") ||
      href.startsWith("#")
    ) {
      continue;
    }
    hrefs.push((href.split("#")[0] ?? href).trim());
  }
  return hrefs;
}

describe("design-critique contract + brief template + thin skill (#3434)", () => {
  it("publishes the contract with required pointer strings", () => {
    expect(isFile(CONTRACT)).toBe(true);
    const text = readText(CONTRACT);
    for (const token of REQUIRED_CONTRACT_POINTERS) {
      expect(text, `contract missing ${token}`).toContain(token);
    }
  });

  it("frames the motion as scaffolds, not enforces, except gate and content-contract tests", () => {
    const text = readText(CONTRACT);
    expect(text.toLowerCase()).toContain("scaffolds the motion");
    const enforceVerb = /\benforces?\b/i;
    const hits = sentencesContaining(text.replace(/--enforce/gi, "--opt-in-flag"), enforceVerb);
    expect(hits.length).toBeGreaterThan(0);
    for (const sentence of hits) {
      const lower = sentence.toLowerCase();
      expect(
        lower.includes("gate") && lower.includes("content-contract"),
        `enforce verb outside gate/tests exception: ${sentence}`,
      ).toBe(true);
    }
  });

  it("publishes the brief template as an envelope skeleton with forbidden-inputs list", () => {
    expect(isFile(TEMPLATE)).toBe(true);
    const text = readText(TEMPLATE);
    for (const token of REQUIRED_TEMPLATE_POINTERS) {
      expect(text, `template missing ${token}`).toContain(token);
    }
  });

  it("points the template into the contract instead of restating normative rules", () => {
    const text = readText(TEMPLATE);
    expect(text).toContain("contracts/design-critique.md");
    expect(text.toLowerCase()).not.toContain(METHOD_RECONCILIATION);
    expect(text).not.toContain("!=MUST");
  });

  it("publishes the thin router skill under the line cap with required pointers", () => {
    expect(isFile(SKILL_REL)).toBe(true);
    expect(existsSync(resolveContentPath("skills/deft-directive-design-critique"))).toBe(true);
    expect(existsSync(join(repoRoot(), "content/skills/deft-directive-design-critique"))).toBe(
      true,
    );
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

  it("keeps skill bodies free of contract-normative content", () => {
    const text = readText(SKILL_REL);
    expect(text.toLowerCase()).not.toContain(METHOD_RECONCILIATION);
    expect(text).not.toContain("| Condition | Variant | N |");
    expect(text).not.toContain("Issue body names a defensible presumption");
    expect(text).not.toContain("⊗ Put the model in an issue label");
  });

  it("locks the first-line model slug as a comment field, not an issue label", () => {
    const contract = readText(CONTRACT);
    expect(contract).toContain("```text\nmodel: grok-4.6\n```");
    expect(contract).toContain("! First line of the triage write-back comment is `model: <slug>`.");
    expect(contract).toContain(
      "! First line of every critic comment is `model: <slug>` for the model that produced that comment.",
    );
    expect(contract).toContain(
      "! Same first-line rule for a Stop 4 retry critic (fresh comment, new first line).",
    );
    expect(contract).toContain("comment-lead field");
    expect(contract).toContain("⊗ Put the model in an issue label");
    expect(contract).toContain("GitHub login");
    expect(contract).toContain("verify:routing");
    const template = readText(TEMPLATE);
    expect(template).toContain(
      "- Model (copy onto the first line of the posted comment as `model: <slug>`):",
    );
    const skill = readText(SKILL_REL);
    expect(skill).toContain("First-line model slug");
    expect(skill).not.toContain("⊗ Put the model in an issue label");
  });

  it("indexes the skill on-demand and does not always-pin it", () => {
    const references = readText("REFERENCES.md");
    expect(references).toContain("deft-directive-design-critique/SKILL.md");
    expect(references).toContain("`design critique`");
    const agents = readText("AGENTS.md");
    const agentsEntry = readText("templates/agents-entry.md");
    expect(agents).not.toContain("deft-directive-design-critique");
    expect(agentsEntry).not.toContain("deft-directive-design-critique");
    for (const pin of DEFAULT_ALWAYS_PINS) {
      expect(agents).toContain(pin);
      expect(agentsEntry).toContain(pin);
    }
  });
});
