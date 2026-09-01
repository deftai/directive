/** Content contract for design-critique SoT + brief template + thin skill (#3434). */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { COMPLETED_ARC_BLOCK_REASONS } from "../../design-critique/completed-arc-record.js";
import { remainingSetAfterDesignCritiqueChip } from "../../design-critique/exclusive-chip.js";
import { evaluatePanelSeatComposition } from "../../design-critique/panel-seat-families.js";
import { evaluateParentAudit } from "../../design-critique/parent-audit.js";
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
  "### Parent-facing dispatch rules",
  "### Critic method",
  "## Variant table",
  "### The arc",
  "### Target shape",
  "one recorded motion over one target revision",
  "set-level",
  "against-implementation",
  "### Evaluation rule",
  "evaluated independently",
  "5364365428",
  "## Envelope and ceiling",
  "## Synthesis format",
  "## Stop 1 — Gate",
  "## Stop 2 — Variant selection",
  "## Stop 3 — Critic envelope",
  "## Stop 4 — Residual reiteration",
  "## Stop 5 — Verified synthesis",
  "## Operator-gated loop",
  "## Successor lean",
  "## Operator verbs",
  "## Dual stop",
  "## Halt line",
  "## Bind after accepted synthesis",
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
  "model: <your-model-slug>",
  "role: critic",
  "role: parent",
  "role: triage",
  "role: triage|critic|parent",
  "#3640",
  "comment-lead field",
  "issue label",
  "GitHub login",
  "verify:routing",
  "first line",
  "second line",
  "design-critique:triage-ready",
  "design-critique: halted, because",
  "design-critique: synthesis accepted, because",
  "triage:accept",
  "scope:promote",
  "remaining-set",
  "DELETE-then-POST",
  "LabelClient.apply",
  "mergeIssueLabels",
  "scm:issue:design-critique-chip",
  "retry differences",
  "walk all",
  "walk findings one at a time",
  "accept-into-contract",
  "classified-finding set",
  "empty disagreement set",
  "zero classified headings",
  "post the verified-claims table",
  "accept synthesis",
  "accept synt",
  "synt accepted",
  "synt approved",
  "## Parent-side substantiation",
  "ADR-006-parent-side-substantiation.md",
  "evaluateParentAudit",
  "evaluatePanelSeatComposition",
  "AND zero unresolved audit markers",
  "independence, not provenance",
  "measured-versus-asserted",
  "before any critic exists",
  "`refutation-target:`",
  "highest-leverage asserted premise",
  "first operator surface",
  "empty-lean verb menu",
  "supersedes #3627",
  "does not fail-close live parent turns",
  "completed-arc record",
  "Chip apply miss",
  "Any identity may run those verbs",
  "evaluateCompletedArcRecord",
  "## Citation grammar",
  "### Position predicate",
  "### Which code-span convention governs",
  "scanCitations",
  "#issuecomment-12345678",
  "/issues/comments/12345678",
  "classifyHit",
  "set membership",
  "## Plain-language summary",
  "## In plain English",
];

const REQUIRED_TEMPLATE_POINTERS = [
  "contracts/design-critique.md",
  "## Forbidden inputs",
  "parent hypotheses",
  "named refutation target",
  "open critique",
  "Charter (refutation | open critique)",
  "Critic method",
  "Parent-facing dispatch rules",
  "id ceiling",
  "proposed skill outline",
  "embedded instructions",
  "model:",
  "first line",
  "role:",
  "second line",
  "Audit targets",
  "ids only",
  "`refutation-target:`",
  "Seat families (N≥3",
  "Launcher (spawn_subagent | grok | claude | codex | paste-ready)",
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
  "Comment lead (model then role)",
  "Successor lean",
  "Operator verbs",
  "Halt line",
  "Bind after accepted synthesis",
  "Parent-side substantiation",
  "EXITs after posting",
  "scm:issue:design-critique-chip",
  "After this round's siblings are posted: successor lean, then verbs",
  "Auto-stamp after operator confirm; not while same-round siblings outstanding",
  "completed-arc record",
  "Chip apply miss is non-blocking",
  "Seat families",
  "Grok Build launcher",
  "prevention issue",
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

function markdownSection(text: string, heading: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) {
    return "";
  }
  const startLevel = (heading.match(/^#+/) ?? [""])[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const match = lines[i]?.match(/^(#+)\s/);
    if (match && (match[1]?.length ?? 99) <= startLevel) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
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

  it("pins critic-method tokens a hollow section cannot satisfy (#3661)", () => {
    const text = readText(CONTRACT);
    expect(text).toContain("### Critic method");
    expect(text).toContain("### Parent-facing dispatch rules");
    expect(text).not.toContain("### Charter");
    expect(text).toContain("Treat a footnote-only post as a stub");

    const method = markdownSection(text, "### Critic method");
    expect(method, "critic-method heading missing").toContain("### Critic method");
    expect(method).toContain("`blocks-the-design`");
    expect(method).toContain("`sharpens-framing`");
    expect(method).toContain("`footnote`");
    expect(method).toContain("decision table");
    expect(method).toContain("cannot bind as written");
    expect(method).toContain("cannot carry disposition weight");
    expect(method).toContain("auto-stamp denominator");
    expect(method).toContain("footnote-only");
    expect(method).toContain("not a stub");
    expect(method).toContain("Line cites are claims");
    expect(method).toContain("existing mechanisms");
    expect(method).toContain("injection / swarm");
    expect(method).toContain("authority");
    expect(method).toContain("untrusted input");
    expect(method).toContain("prompts or envelopes");
    expect(method).toContain("identity");
    expect(method).toContain("concurrency");
    expect(method).toContain("worktrees");
    expect(method).toContain("shared state");
    expect(method).toContain("a reviewer would catch it");
    expect(method).toContain("evidence");
    expect(method).toContain("failure mode");
    expect(method).toContain("disposition consequence");
    expect(method).toContain("road-not-taken");
    expect(method).toContain("steelman");
    expect(method).toContain("Method-reconciliation");
    expect(method).toContain("Stop 5");
    expect(method).not.toContain(METHOD_RECONCILIATION);

    const mustLines = method.split("\n").filter((line) => /^- ! /.test(line));
    const shouldLines = method.split("\n").filter((line) => /^- ~ /.test(line));
    const mustNotLines = method.split("\n").filter((line) => /^- \u2297 /.test(line));
    expect(mustLines.length, "critic-facing MUST lines").toBeGreaterThanOrEqual(5);
    expect(shouldLines.length, "critic-facing SHOULD lines").toBeGreaterThanOrEqual(2);
    expect(mustNotLines.length, "critic-facing MUST NOT lines").toBeGreaterThanOrEqual(1);

    const parent = markdownSection(text, "### Parent-facing dispatch rules");
    expect(parent).toContain("Give the critic process-only dispatch rules");
    expect(parent).not.toContain("blocks-the-design");
    expect(parent).not.toContain("Line cites are claims");

    const stop5 = markdownSection(text, "## Stop 5 \u2014 Verified synthesis");
    expect(stop5).toContain("Method-reconciliation");
    expect(stop5).toContain(METHOD_RECONCILIATION);

    const template = readText(TEMPLATE);
    expect(template).toContain("Critic method");
    expect(template).toContain("| Critic method | Critic method |");
    expect(template).not.toContain(METHOD_RECONCILIATION);
    expect(template).not.toContain("blocks-the-design");
    expect(template).not.toContain("Line cites are claims");
  });

  it("locks the variant-table evaluation rule, not the row prose (#3657)", () => {
    const text = readText(CONTRACT);
    expect(text).toContain("### Evaluation rule");
    expect(text).toContain("Charter selection and spend permission are evaluated independently.");
    expect(text).toContain(
      "The panel row grants **permission** for N≥3 when the solution space is genuinely open or blast radius is high. It does not select the charter and does not override charter.",
    );
    expect(text).toContain(
      "Record the charter and the spend as two fields. The charter is what the critic is given. The spend is how many critics that charter may use.",
    );
    expect(text).toContain(
      "⊗ Record `panel` as the variant or charter. The panel row is spend permission, not a third charter.",
    );
    expect(text).toContain(
      "An issue that matches both a refutation charter and the panel condition is refutation with N≥3 permitted.",
    );
    expect(text).toContain(
      "A drafted-MUSTs issue with no refutation target and whole-motion blast radius is open critique with N≥3 permitted.",
    );
    expect(text).toContain("Supersedes #3434 disposition comment 5364365428 item 4");
    expect(text).toContain(
      '⊗ Add a Stop 2 variant-table trigger for "the author is the party the proposed rule would constrain."',
    );
    const panelRow = text
      .split("\n")
      .find((line) => line.includes("#3383") && line.includes("N≥3 permitted"));
    expect(panelRow, "panel spend row").toBeDefined();
    expect(panelRow).toContain("panel permission (not a charter)");
    expect(panelRow).not.toContain("| panel |");
    expect(panelRow).not.toContain("No defensible presumption");
    expect(text).not.toContain("panel → refutation → default");
    expect(text).not.toContain("first-match");
  });

  it("defines the arc unit with derived boundaries (#3797)", () => {
    const text = readText(CONTRACT);
    const framing = markdownSection(text, "## Framing");
    expect(framing, "arc definition missing from ## Framing").toContain("### The arc");
    expect(framing).toContain("**An arc is one recorded motion over one target revision**");
    expect(framing).toContain("through accepted synthesis or the halt line");
    expect(framing).toContain("one or more rounds, and therefore one or more ceilings");
    expect(framing).toContain("per-target, not per-issue");
    // Open critique has no refutation target, so the unit cannot be one.
    expect(framing).toContain("Open critique names no refutation target");
    // Derived, not asserted: the two proposed absolutes collide, so the implication
    // runs one way only and recut is qualified as post-bind.
    expect(framing).toContain("A round takes a new ceiling. The converse does not hold");
    expect(framing).toContain("Neither event opens an arc.");
    expect(framing).toContain("a retry continues the arc it retries");
    expect(framing).toContain("A panel is one round, not N arcs.");
    expect(framing).toContain("revising a lean before bind is not a boundary");
    expect(framing).toContain("A **recut** opens the next arc, and only after bind");
    expect(framing).toContain("post-bind target revision");
    expect(framing).toContain("! Read `arc` in this document as that unit.");
    expect(framing).toContain(
      "\u2297 Read a new ceiling, a new round, or a pre-bind lean revision as a new arc.",
    );
    // The refuted formulations must not return.
    expect(text).not.toContain("An arc is the complete motion over one refutation target");
    expect(text).not.toContain("A new ceiling starts a new round");
    expect(text).not.toContain("A recut ends an arc");
    const testSurface = markdownSection(text, "## Test surface");
    expect(testSurface).toContain("`### The arc`");
  });

  it("records target shapes on an axis orthogonal to charter (#3797)", () => {
    const text = readText(CONTRACT);
    const stop2 = markdownSection(text, "## Stop 2 \u2014 Variant selection");
    expect(stop2, "target-shape axis missing from Stop 2").toContain("### Target shape");
    expect(stop2).toContain("**Target shape is what is being critiqued.**");
    expect(stop2).toContain("not a row in either table above");
    expect(stop2).toContain("| set-level |");
    expect(stop2).toContain("| against-implementation |");
    // Each shape cites its exemplars, and the limited-exemplar caveat is contract text.
    expect(stop2).toContain("5433848104");
    expect(stop2).toContain("5434313019");
    expect(stop2).toContain("5434122672");
    expect(stop2).toContain("#3796 with PR #3793");
    expect(stop2).toContain("Each shape has been run twice, which is not a settled pattern");
    expect(stop2).toContain("neither row grants a charter or a spend");
    expect(stop2).toContain("disposition is per-issue");
    expect(stop2).toContain("check status is unsettled");
    expect(stop2).toContain(
      "\u2297 Add a target shape as a charter row or a spend row. It is a third axis",
    );
    // The two shapes stay off the charter and spend tables.
    const charterRow = text.split("\n").find((line) => line.includes("#3462"));
    expect(charterRow).toContain("| refutation | N=1 |");
    const defaultRow = text.split("\n").find((line) => line.includes("#3547"));
    expect(defaultRow).toContain("| open critique | N=1 |");
    const shapeRows = text
      .split("\n")
      .filter((line) => line.includes("set-level") || line.includes("against-implementation"));
    for (const row of shapeRows) {
      expect(row, `target shape leaked into a charter/spend row: ${row}`).not.toContain(
        "N\u22653 permitted",
      );
    }
    const skill = readText(SKILL_REL);
    expect(skill).not.toContain("### Target shape");
    expect(skill).not.toContain("against-implementation");
  });

  it("closes bind path 2 with the non-empty refusals (#3797)", () => {
    const text = readText(CONTRACT);
    const bind = markdownSection(text, "## Bind after accepted synthesis");
    expect(bind).toContain("subject to the two non-empty refusals below");
    expect(bind).toContain(
      "\u2297 Bind path 2 when the critic posts zero classified headings (stub / blank).",
    );
    expect(bind).toContain("\u2297 Bind path 2 on a footnote-only census.");
    expect(bind).toContain("denominator set (a) is empty, so it carries no bind at either path");
    // Path 1 keeps the refusals this mirrors.
    const verbs = markdownSection(text, "## Operator verbs");
    expect(verbs).toContain(
      "\u2297 Stamp when the critic posts zero classified headings (stub / blank).",
    );
    expect(verbs).toContain("\u2297 Treat a footnote-only post as a stub.");
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

  it("locks the comment lead as model then role, not an issue label", () => {
    const contract = readText(CONTRACT);
    expect(contract).toContain("```text\nmodel: <your-model-slug>\nrole: critic\n```");
    expect(contract).toContain("self-attestation");
    expect(contract).toContain(
      "Nothing in this repository verifies which model produced a comment",
    );
    expect(contract).toContain("! First line of the triage write-back comment is `model: <slug>`.");
    expect(contract).toContain("! Second line of the triage write-back comment is `role: triage`.");
    expect(contract).toContain(
      "! First line of every critic comment is `model: <slug>` naming the model slug the critic self-attests.",
    );
    expect(contract).toContain("! Second line of every critic comment is `role: critic`.");
    expect(contract).toContain("! Same first-two-lines on a Stop 4 retry critic (`role: critic`).");
    expect(contract).toContain(
      "! Same first-two-lines on #3640 auto-posted table / synthesis-accepted comments (`role: parent`).",
    );
    expect(contract).toContain("`role: triage|critic|parent`");
    expect(contract).toContain(
      "! Synthesis comments use the same first-two-lines (`model: <slug>` then `role: parent`).",
    );
    expect(contract).toContain(
      "! Synthesis comments start with the same first-two-lines (`model: <slug>` then `role: parent`).",
    );
    expect(contract).not.toContain("~ Synthesis comments SHOULD");
    expect(contract).toContain("comment-lead field");
    expect(contract).toContain("⊗ Put the model in an issue label");
    expect(contract).toContain("⊗ Put role in an issue label");
    expect(contract).toContain("⊗ Replace the model line with a role or GitHub login");
    expect(contract).toContain("GitHub login");
    expect(contract).toContain("verify:routing");
    expect(contract).toContain(
      "⊗ Omit the model line. Post `model: <slug>` on the comment; do not substitute a slug inferred from `verify:routing` or spawn metadata.",
    );
    expect(contract).toContain(
      "⊗ Omit the role line. Post `role: triage|critic|parent` on the comment; do not substitute a role inferred from `verify:routing` or spawn metadata.",
    );
    const template = readText(TEMPLATE);
    expect(template).toContain(
      "- Model (copy onto the first line of the posted comment as `model: <slug>`):",
    );
    expect(template).toContain(
      "- Role (copy onto the second line of the posted comment as `role: triage|critic|parent`):",
    );
    const skill = readText(SKILL_REL);
    expect(skill).toContain("Comment lead (model then role)");
    expect(skill).not.toContain("⊗ Put the model in an issue label");
    expect(skill).not.toContain("role: triage");
    expect(skill).not.toContain("role: critic");
    expect(skill).not.toContain("role: parent");
    expect(skill).not.toContain("triage|critic|parent");
    const labelsDoc = readText(".github/ISSUE_LABELS.md");
    expect(labelsDoc).toContain("Do not add a critic-posted or author/role chip");
  });

  it("locks the operator-gated loop, successor lean, verbs, dual stop, halt, and bind", () => {
    const text = readText(CONTRACT);
    expect(text).toContain("## Operator-gated loop");
    expect(text).toContain("## Successor lean");
    expect(text).toContain("## Operator verbs");
    expect(text).toContain("## Dual stop");
    expect(text).toContain("## Halt line");
    expect(text).toContain("## Bind after accepted synthesis");
    expect(text).toContain("```text\ndesign-critique: halted, because …\n```");
    expect(text).toContain("```text\ndesign-critique: synthesis accepted, because …\n```");
    expect(text).toContain("design-critique:triage-ready");
    expect(text).toContain("Default critic posts without extra record: 2");
    expect(text).toContain("An N=3 panel is permitted three round-1 posts and no default retry.");
    expect(text).toContain("still-open finding headings/ids");
    expect(text).toContain("Dispatch failure");
    expect(text).toContain("accept");
    expect(text).toContain("retry differences");
    expect(text).toContain("**walk**");
    expect(text).toContain("**walk all**");
    expect(text).toContain("walk findings one at a time");
    expect(text).toContain("post the verified-claims table");
    expect(text).toContain("accept synthesis");
    expect(text).toContain("accept synt");
    expect(text).toContain("Each critic dispatch EXITs after posting.");
    expect(text).toContain("triage:accept");
    expect(text).toContain("scope:promote");
    expect(text).toContain("judgmentGates");
    expect(text).toContain("design-critique:mechanism-shaped");
  });

  it("forbids critic-posted chips, triage:* chips, Phase 3 commands, #3607 interlock, and auto-dispatch", () => {
    const text = readText(CONTRACT);
    expect(text).toContain("⊗ Auto-dispatch critics (#3578 / #1702).");
    expect(text).toContain("⊗ Add a `design-critique:critic-posted` chip or any author/role chip.");
    expect(text).toContain("⊗ Use Phase 3 or Stop 5 as operator commands.");
    expect(text).toContain("⊗ Add a #3607 thread interlock in this contract.");
    expect(text).toContain("⊗ Stamp `design-critique:triage-ready` at critic-post.");
    expect(text).not.toContain("`triage:ready`");
    expect(text).not.toContain("`triage:triage-ready`");
    expect(text).not.toContain("review:pass-open");
    const skill = readText(SKILL_REL);
    expect(skill).toContain("⊗ Auto-dispatch critics from this skill.");
    expect(skill).not.toContain("design-critique:critic-posted");
    expect(skill).not.toContain("Phase 3");
    expect(skill).not.toContain("#3607");
    expect(skill).not.toContain("```text\ndesign-critique: halted, because");
    expect(skill).not.toContain("Default critic posts without extra record: 2");
    expect(skill).not.toContain("walk findings one at a time");
    expect(skill).not.toContain("accept-into-contract");
    expect(skill).not.toContain("empty disagreement set");
  });

  it("locks walk vs walk all, auto-stamp on non-empty all-accept, and no-stamp on stubs (#3640)", () => {
    const text = readText(CONTRACT);
    expect(text).toContain("**walk**");
    expect(text).toContain("**walk all**");
    expect(text).toContain("walk findings one at a time");
    expect(text).toContain("recorded parent-disagree");
    expect(text).toContain("accept-into-contract");
    expect(text).toContain("Defer is not accepted");
    expect(text).toContain(
      "design-critique: synthesis accepted, because agents agreed (empty disagreement set)",
    );
    expect(text).toContain("non-empty");
    expect(text).toContain("classified-finding set");
    expect(text).toContain("scm:issue:design-critique-chip");
    expect(text).toContain("--chip triage-ready");
    expect(text).toContain("zero classified headings");
    expect(text).toContain("Do not stamp");
    expect(text).toContain("Dispatch failure");
    expect(text).toContain("Looks-good");
    expect(text).toContain("bare **accept**");
    expect(text).toContain("Do not print **accept synthesis**");
    expect(text).toContain("Do not auto-start the walk");
    expect(text).toContain("retry differences");
    expect(text).toContain("does not exclude that critic's own post from the denominator");
    expect(text).toContain(
      "Comments after the id ceiling are out of envelope, except the critic's own Stop 4 retry post",
    );
    expect(text).toContain(
      "including after the disagreement-map input ceiling), which stays in the auto-stamp denominator",
    );
    expect(text).toContain("Still-open residual headings persist");
    expect(text).toContain("Uncited still-open headings remain `disagree`");
    expect(text).toContain("Do not auto-stamp on a partial map");
    const skill = readText(SKILL_REL);
    expect(skill).toContain("Operator verbs");
    expect(skill).toContain("Walk / walk all. Auto-stamp when agents agree");
    expect(skill).not.toContain("walk findings one at a time");
    expect(skill).not.toContain("accept-into-contract");
    expect(skill).not.toContain("empty disagreement set");
    expect(skill).not.toContain("classified-finding set");
    const labelsDoc = readText(".github/ISSUE_LABELS.md");
    expect(labelsDoc).toContain("#3640 auto-stamp");
  });

  it("pins exclusive remaining-set replace of the two catalog chips", () => {
    const remaining = remainingSetAfterDesignCritiqueChip(
      ["bug", "design-critique:mechanism-shaped", "area:cli"],
      "design-critique:triage-ready",
    );
    expect(remaining).toEqual(["bug", "area:cli", "design-critique:triage-ready"]);
    const recut = remainingSetAfterDesignCritiqueChip(
      remaining,
      "design-critique:mechanism-shaped",
    );
    expect(recut).toEqual(["bug", "area:cli", "design-critique:mechanism-shaped"]);
    const contract = readText(CONTRACT);
    expect(contract).toContain("remaining-set");
    expect(contract).toContain("GET current labels");
    expect(contract).toContain("DELETE-then-POST");
    expect(contract).toContain("LabelClient.apply");
    expect(contract).toContain("mergeIssueLabels");
    expect(contract).toContain("ScmLabelClient.apply");
    expect(contract).toContain("applyDesignCritiqueCatalogChip");
    expect(contract).toContain("designCritiqueChipApplyDelta");
    expect(contract).toContain("scm:issue:design-critique-chip");
    expect(contract).toContain("list-visible state, not consent");
    expect(contract).toContain("additive `scm:issue:edit --add-label`");
    expect(contract).toContain("⊗ PUT a naive full wipe of every label.");
    expect(contract).not.toContain(
      "Remove every other `design-critique:*` label on that issue first",
    );
    const labelsDoc = readText(".github/ISSUE_LABELS.md");
    expect(labelsDoc).toContain("remaining-set replace");
    expect(labelsDoc).toContain("Do not DELETE-then-POST");
    expect(labelsDoc).toContain("Remove-set is those two catalog names only");
    const skill = readText(SKILL_REL);
    expect(skill).not.toContain("DELETE-then-POST");
    expect(skill).not.toContain("remaining-set");
  });

  it("catalogs design-critique:triage-ready only, not critic-posted, and keeps judgmentGates on mechanism-shaped", () => {
    const labelsDoc = readText(".github/ISSUE_LABELS.md");
    expect(labelsDoc).toContain("design-critique:triage-ready");
    expect(labelsDoc).toContain("design-critique: synthesis accepted, because");
    expect(labelsDoc).toContain("design-critique:mechanism-shaped");
    expect(labelsDoc).toContain("Not a `triage:*` classify action");
    expect(labelsDoc).not.toMatch(/`design-critique:critic-posted`/);
    expect(labelsDoc).not.toMatch(/`triage:ready`/);
    expect(labelsDoc).not.toMatch(/`triage:triage-ready`/);
    const project = readText("xbrief/PROJECT-DEFINITION.xbrief.json");
    const gateMatch = project.match(/"id":\s*"design-critique"[\s\S]*?"any-of":\s*\[([\s\S]*?)\]/);
    expect(gateMatch).not.toBeNull();
    const anyOf = gateMatch?.[1] ?? "";
    expect(anyOf).toContain("design-critique:mechanism-shaped");
    expect(anyOf).not.toContain("design-critique:triage-ready");
    expect(anyOf).not.toContain("critic-posted");
  });

  it("locks first-lean recording obligation after this round's siblings are posted (#4027 / #3741)", () => {
    const text = readText(CONTRACT);
    const loop = markdownSection(text, "## Operator-gated loop");
    const lean = markdownSection(text, "## Successor lean");
    const verbs = markdownSection(text, "## Operator verbs");
    const testSurface = markdownSection(text, "## Test surface");
    expect(loop).toContain("After this round's same-round siblings are posted");
    expect(loop).not.toContain("After each critic EXIT");
    expect(loop).toContain("Spend is permission, not the wait rule");
    expect(loop).toContain("Parent dispatch bookkeeping is the trigger");
    expect(loop).toContain("thread posts corroborate");
    expect(loop).toContain(
      "The halt line remains postable while same-round siblings remain unposted",
    );
    expect(loop).toContain(
      "**before** printing `accept` / `retry differences` / `walk` / `walk all`",
    );
    expect(loop).toContain("first operator surface");
    expect(loop).toContain("Chat is not the record");
    expect(loop).toContain("supersedes #3627");
    expect(loop).toContain("empty-lean verb menu");
    expect(lean).toContain("Operator confirm or amend");
    expect(lean).toContain("all-accept draft still goes through this offer");
    expect(lean).toContain("Do not post a third map type");
    expect(lean).toContain("ADR-006 arbitration surface");
    expect(lean).toContain("same party authored the triage");
    expect(loop).toContain("Binding takes is not synthesis bind");
    expect(loop).toContain(
      "The first lean after this round's siblings are posted is the take-offer, not the bind",
    );
    expect(loop).toContain(
      "⊗ Bind synthesis or stamp `design-critique:triage-ready` while same-round siblings remain unposted.",
    );
    expect(verbs).toContain("when they apply");
    expect(verbs).toContain("empty-lean verb menu");
    expect(verbs).toContain("Do not skip the first-lean offer because the draft is all-accept");
    expect(verbs).toContain(
      "Auto-stamp a parent-drafted all-accept map that the operator has not confirmed",
    );
    expect(verbs).toContain("the operator has confirmed or amended that map");
    expect(verbs).toContain("no unposted same-round siblings remain");
    expect(verbs).toContain("Auto-stamp while same-round siblings remain unposted");
    expect(testSurface).toContain("does not fail-close live parent turns");
    expect(testSurface).toContain("evaluateParentAudit");
    const bind = markdownSection(text, "## Bind after accepted synthesis");
    expect(bind).toContain("the operator has confirmed or amended that map");
    expect(bind).toContain("no unposted same-round siblings remain");
    expect(bind).toContain("an unconfirmed parent draft");
    const ceiling = markdownSection(text, "### Envelope and ceiling");
    expect(ceiling).toContain("**Panel completeness is behavioural.**");
    expect(ceiling).toContain("No code observes them.");
    expect(ceiling).toContain("nothing machine-checks it");
    expect(testSurface).toContain("Panel completeness is locked as contract text only");
    expect(testSurface).toContain("evaluatePanelSeatComposition");
    // #3850: presence anywhere in a section is not enough — one bind guard can
    // regress to the deposit-qualified wording while a sibling occurrence keeps
    // the substring assertion green. Pin the superseded qualifiers out of the
    // document and anchor each of the seven guards to its own sentence.
    expect(text).not.toContain("named on the panel-deposit");
    expect(text).not.toContain("panel-deposit for this round");
    const substantiation = markdownSection(text, "## Parent-side substantiation");
    expect(lean).toContain(
      "It does not auto-stamp synthesis or `design-critique:triage-ready` while same-round siblings remain unposted.",
    );
    expect(substantiation).toContain(
      "AND no unposted same-round siblings remain. This conjunct applies at Operator verbs auto-stamp",
    );
    expect(verbs).toContain(
      "AND no unposted same-round siblings remain: parent auto-posts the verified-claims table",
    );
    expect(verbs).toContain(
      "AND no unposted same-round siblings remain, the auto-table + auto-stamp path runs",
    );
    expect(bind).toContain(
      "AND no unposted same-round siblings remain, parent posts `design-critique: synthesis accepted",
    );
    expect(bind).toContain("or while same-round siblings remain unposted.");
    expect(lean).toContain("After this round's same-round siblings are posted");
    expect(lean).not.toContain("After each critic EXIT");
    expect(lean).toContain(
      "A lean that closes a round of two or more names that round's dispatched sibling count",
    );
    expect(verbs).toContain("after a successor lean is posted for this round");
    expect(verbs).not.toContain("for this critic EXIT");
    expect(text).not.toContain("parent-silence-until");
    const template = readText(TEMPLATE);
    expect(template).not.toContain("parent-silence-until");
    expect(loop).toContain("when no successor lean is posted for this round");
    expect(loop).toContain("Count self-attested `role: critic` lines as panel-complete");
    const skill = readText(SKILL_REL);
    expect(skill).toContain("After this round's siblings are posted: successor lean, then verbs");
    expect(skill).toContain(
      "After same-round siblings are posted, the parent posts the successor lean",
    );
    expect(skill).not.toContain("After each critic EXIT");
    expect(skill).not.toContain("After critic post: posted successor lean, then verbs");
    expect(skill).toContain(
      "Auto-stamp after operator confirm; not while same-round siblings outstanding",
    );
    expect(skill).not.toContain("accept-into-contract");
    expect(skill).not.toContain("| Condition | Variant | N |");
  });

  it("locks same-round shared input ceiling, narrowed fallback, and N=3 dual-stop (#3660)", () => {
    const text = readText(CONTRACT);
    expect(text).toContain(
      "Critics dispatched in the same round share one issue-comment input ceiling, fixed before any sibling dispatch.",
    );
    expect(text).toContain(
      "A sibling's post is out of envelope for every other sibling in that round.",
    );
    expect(text).toContain(
      "That MUST claims only that siblings cannot read each other through the issue thread.",
    );
    expect(text).toContain("It does not claim decorrelation.");
    expect(text).toContain(
      'The "thread head at dispatch" fallback applies only to a single-critic round with no triage write-back.',
    );
    expect(text).toContain(
      "When two or more critics share the round, take one round-start snapshot before the first sibling dispatch",
    );
    expect(text).not.toContain(
      "Round-1 ceiling is the triage write-back (or the thread head at dispatch).",
    );
    expect(text).toContain("An N=3 panel is permitted three round-1 posts and no default retry.");
    expect(text).toContain(
      "A fourth post requires the operator to raise the cap for this arc and record it.",
    );
    expect(text).toContain("Panels larger than three (N>3) are unaddressed.");
    expect(text).toContain("An N=3 panel is not a recorded why for a Stop 4 retry.");
    expect(text).toContain(
      "parent posts a panel-deposit comment (`role: parent`) that names `round:`, `siblings:`, and `input-ceiling:`",
    );
    expect(text).toMatch(
      /panel-deposit\r?\nround: 1\r?\nsiblings: 3\r?\ninput-ceiling: 5390001612/,
    );
    expect(text).toContain("families: grok, claude, codex");
    expect(text).toContain("These are not rules.");
    expect(text).toContain("A parent that leans on any of them MUST carry an audit marker");
    expect(text).toContain("the most recent parent artifact that supersedes the map");
    expect(text).toContain("that amendment becomes the ceiling");
    expect(text).toContain("both panel arcs declined it");
    expect(text).toContain("the merged map");
  });

  it("locks N>=3 seat families, same-family no-lean, Grok Build launcher, and miss-file-issue (#4067)", () => {
    const text = readText(CONTRACT);
    const ceiling = markdownSection(text, "### Envelope and ceiling");
    expect(ceiling).toContain("names three claimed families before the first sibling spawn");
    expect(ceiling).toContain("A same-family sibling set is not a panel");
    expect(ceiling).toContain("re-seat (or halt), not wait for Stop 5");
    expect(ceiling).toContain("Grok Build launcher tree");
    expect(ceiling).toContain("spawn_subagent");
    expect(ceiling).toContain("codex exec");
    expect(ceiling).toContain("Paste-ready is the fallback when a named family's CLI is absent");
    expect(ceiling).toContain("evaluatePanelSeatComposition");
    expect(ceiling).toContain("After a dispatch-composition miss, offer a prevention issue");
    expect(ceiling).toContain("On yolo, file it");
    expect(ceiling).toContain("⊗ Classify family from a model slug");
    const template = readText(TEMPLATE);
    expect(template).toContain("Seat families (N≥3: three claimed families before spawn)");
    expect(template).toContain("Launcher (spawn_subagent | grok | claude | codex | paste-ready)");
    const skill = readText(SKILL_REL);
    expect(skill).toContain("Seat families");
    expect(skill).toContain("Grok Build launcher");
    expect(skill).toContain("prevention issue");
    const pasteReadyFirst = evaluatePanelSeatComposition({
      claimedSeats: [
        { family: "grok", launcher: "spawn_subagent" },
        { family: "claude", launcher: "paste-ready" },
        { family: "codex", launcher: "paste-ready" },
      ],
      path: { claude: true, codex: true },
    });
    expect(pasteReadyFirst.ok).toBe(false);
    if (!pasteReadyFirst.ok) {
      expect(pasteReadyFirst.code).toBe("paste-ready-first");
    }
  });

  it("locks parent-side substantiation MUSTs, both auto-bind sites, and omission fail-closed (#3651)", () => {
    const text = readText(CONTRACT);
    expect(text).toContain("## Parent-side substantiation");
    expect(text).toContain("ADR-006-parent-side-substantiation.md");
    expect(text).toContain("dispatch SHA, source pointer, and measured-versus-asserted");
    expect(text).toContain("The predicate is independence, not provenance.");
    expect(text).toContain("⊗ A `role: parent` artifact clears its own marker.");
    expect(text).toContain(
      "one independently reproduced premise does not clear an unaudited load-bearing one",
    );
    expect(text).toContain("An unresolved marker is residual and blocks verified-synthesis bind.");
    expect(text).toContain("⊗ Discharge a marker by promising a later pass.");
    expect(text).toContain(
      "Auto-bind requires an all-accept disposition map AND zero unresolved audit markers AND the operator has confirmed or amended that map AND no unposted same-round siblings remain.",
    );
    expect(text).toContain(
      "This conjunct applies at Operator verbs auto-stamp and at Bind after accepted synthesis path 1.",
    );
    const operatorVerbs = text.split("## Operator verbs")[1]?.split("## Dual stop")[0] ?? "";
    const bindPath = text.split("## Bind after accepted synthesis")[1] ?? "";
    expect(operatorVerbs).toContain("AND zero unresolved audit markers");
    expect(bindPath).toContain("AND zero unresolved audit markers");
    expect(text).toContain("Walk comments stay slim");
    expect(text).toContain("A token plus pointer satisfies this at the walk surface");
    expect(text).toContain("evaluateParentAudit");
    const adr = readText("docs/decisions/ADR-006-parent-side-substantiation.md");
    expect(adr).toContain("Parent adjudicating artifacts are arbitration surfaces");
    expect(adr).toContain("Primary-source citation is not independent clearance");
    expect(adr).toContain("The parent cannot self-clear");
    const omitted = evaluateParentAudit({
      premises: [{ markerId: "c9", introducedByRole: "parent", loadBearing: true }],
      clearances: [],
      envelopes: [],
      namedAuditTargets: ["c9"],
      bindAttempt: { allAcceptMap: true, unresolvedMarkerIds: [] },
    });
    expect(omitted.ok).toBe(false);
    expect(omitted.failures.map((f) => f.code)).toEqual(
      expect.arrayContaining([
        "missing-token",
        "silent-clear",
        "bind-unresolved",
        "envelope-omits-target",
      ]),
    );
    const template = readText(TEMPLATE);
    expect(template).toContain("Audit targets (marker ids, comma-separated, or `none`");
    expect(template).toContain("parent rationale on the audit-targets field (ids only)");
  });

  it("locks completed-arc ingest vs chip-is-not-consent (#3806)", () => {
    const text = readText(CONTRACT);
    const loop = markdownSection(text, "## Operator-gated loop");
    expect(loop).toContain("completed-arc record");
    expect(loop).not.toContain("until `design-critique:triage-ready`.");
    const bind = markdownSection(text, "## Bind after accepted synthesis");
    expect(bind).toContain("Chip apply miss");
    expect(bind).toContain("Any identity may run those verbs");
    expect(bind).toContain("judgmentGates");
    expect(bind).toContain("advisory/observe");
    expect(bind).toContain("Treat `design-critique:triage-ready` as ingest clearance");
    expect(text).toContain("evaluateCompletedArcRecord");
    const skill = readText(SKILL_REL);
    expect(skill).toContain("completed-arc record");
    expect(skill).toContain("Chip apply miss is non-blocking");
    const labelsDoc = readText(".github/ISSUE_LABELS.md");
    expect(labelsDoc).toContain("not ingest clearance");
    expect(labelsDoc).toContain("Chip apply miss is non-blocking");
  });

  it("publishes the closed citation grammar with a position predicate (#3831)", () => {
    const text = readText(CONTRACT);
    const grammar = markdownSection(text, "## Citation grammar");
    expect(grammar, "citation-grammar section missing").toContain("## Citation grammar");
    expect(grammar).toContain("Closed set");
    expect(grammar).toContain("scanCitations");
    expect(grammar).toContain("Nothing else parses citations.");
    for (const form of [
      "successor lean 12345678",
      "successor lean:12345678",
      "successor lean `12345678`",
      "**successor lean:** 12345678",
      "#issuecomment-12345678",
      "/issues/comments/12345678",
    ]) {
      expect(grammar, `accepted form missing: ${form}`).toContain(form);
    }
    expect(grammar).toContain("An unpublished spelling is not a citation.");
    expect(grammar).toContain("⊗ Widen the accept set with `.*`");
    expect(grammar).toContain("⊗ Count every 8-or-more digit run in the body as a citation.");

    expect(grammar).toContain("### Position predicate");
    expect(grammar).toContain("Accepting an id is not accepting a citation.");
    for (const refused of [
      "fenced code block, including a fence indented up to three spaces",
      "inline code span, including a span that opened on an earlier line",
      "in a blockquote, including an unmarked lazy-continuation line",
      "struck through",
      "explicitly negated within three words of the keyword",
    ]) {
      expect(grammar, `refused position missing: ${refused}`).toContain(refused);
    }
    expect(grammar).toContain("Those five are the whole refused set.");
    expect(grammar).toContain("Widening the refused set is a contract change");
    expect(grammar).toContain("classifyHit");
    expect(grammar).toContain("Read the enclosing block, not one physical line.");
    expect(grammar).toContain("The negation form is explicit");
    expect(grammar).toContain("A quote block also ends at a fence delimiter");
    expect(grammar).toContain("A negated verb of denial affirms the citation");
    expect(grammar).toContain("That carve-out suspends a negation that already fired");
    expect(grammar).toContain(
      "⊗ Read a trailing `that` as the complement-clause signal on its own.",
    );
    expect(grammar).toContain("⊗ Refuse on a negation word anywhere in the sentence prefix.");
    expect(grammar).toContain("⊗ Strip the span instead.");

    expect(grammar).toContain("### Which code-span convention governs");
    expect(grammar).toContain("markdown-scanners.ts");
    expect(grammar).toContain("id token only");
    expect(grammar).toContain("which governs where");

    expect(grammar).toContain("Two regexes answering one question");
    expect(grammar).toContain("Clearance is set membership");
    expect(grammar).toContain("⊗ Guess at a cause.");
    expect(grammar).not.toContain("first-match");

    const bind = markdownSection(text, "## Bind after accepted synthesis");
    expect(bind).toContain("`## Citation grammar`");

    const testSurface = markdownSection(text, "## Test surface");
    expect(testSurface).toContain("citation-grammar.test.ts");

    const skill = readText(SKILL_REL);
    expect(skill).not.toContain("## Citation grammar");
    expect(skill).not.toContain("#issuecomment-12345678");
  });

  it("locks the plain-language summary, its token, and the line-start matrix (#3929)", () => {
    const text = readText(CONTRACT);
    const summary = markdownSection(text, "## Plain-language summary");
    expect(summary, "plain-language-summary section missing").toContain(
      "## Plain-language summary",
    );
    expect(summary).toContain("one fixed heading token: `## In plain English`.");
    expect(summary).toContain("Read the token as placement only.");
    expect(summary).toContain("⊗ Justify the token as presence checkable later.");
    expect(summary).toContain("author-blindness is a locked test");
    expect(summary).toContain("no selector could pick a canonical one");
    expect(summary).toContain("### Why MUST and not SHOULD");
    expect(summary).toContain("does not rest on exemplar count");
    expect(summary).toContain("identical on every arc by construction");
    expect(summary).toContain(
      "They introduce no ADR-006 premise and record no substantiation token.",
    );
    expect(summary).toContain("would silently become a two-critic motion");
    expect(summary).toContain(
      "A summary claim that is not a reading of a recorded take or an accepted finding is a new load-bearing premise",
    );
    expect(summary).toContain("### Non-normative for downstream agents");
    expect(summary).toContain("composeOverviewWithComments");
    expect(summary).toContain("Security context (#480)");
    expect(summary).toContain(
      "⊗ Mandate a next-step or recommended-action field on either artifact.",
    );
    expect(summary).toContain("### Reserved line-starts");
    expect(summary).toContain("| Reserved line-start | In a successor lean | In a synthesis |");
    expect(summary).toContain("nine spellings");
    expect(summary).toContain("`## Verified-claims table`");
    expect(summary).toContain("the fixed accepted sentence");
    expect(summary).toContain("#3932");
    expect(summary).toContain("A fence does not help.");
    expect(summary).toContain("no one quoting convention is safe for both parsers");
    expect(summary).toContain("⊗ Read the inert cell as licence.");
    expect(summary).toContain("Nothing observes this section.");
    expect(summary).toContain("do not add a prose-quality parser");

    // Both artifact-local MUSTs name the token, not the section heading.
    const lean = markdownSection(text, "## Successor lean");
    expect(lean).toContain(
      "- ! Lead that lean with the plain-language summary under the `## In plain English` token.",
    );
    const stop5 = markdownSection(text, "## Stop 5 \u2014 Verified synthesis");
    expect(stop5).toContain(
      "- ! Lead the synthesis with the plain-language summary under the `## In plain English` token,",
    );
    expect(summary).toContain("The ghost-table half of the middle cell is the #3932 defect");
    expect(stop5).toContain(
      "The #3640 auto-posted synthesis-accepted comment carries that summary too.",
    );
    const testSurface = markdownSection(text, "## Test surface");
    expect(testSurface).toContain("reserved-line-starts.test.ts");
    expect(testSurface).toContain("No predicate observes a summary on a live arc (#3929).");

    const skill = readText(SKILL_REL);
    expect(skill).not.toContain("## In plain English");
    expect(skill).not.toContain("Reserved line-starts");
  });
  it("pins Stop 1 exclusion and refutation-target tokens by content (#3672)", () => {
    const text = readText(CONTRACT);
    const substantiation = markdownSection(text, "## Parent-side substantiation");
    expect(substantiation, "exclusion missing from substantiation section").toContain(
      "before any critic exists",
    );
    expect(substantiation).toContain("nobody has spoken");
    expect(substantiation).toContain("entire critic pass is the audit");
    expect(substantiation).toContain("post-critic arbitration");
    expect(substantiation).toContain("#3651");
    expect(substantiation).toContain("initial triage remains outside");
    expect(substantiation).not.toContain("`role: triage`");

    const stop1 = markdownSection(text, "## Stop 1 \u2014 Gate");
    expect(stop1, "refutation-target missing from Stop 1").toContain("`refutation-target:`");
    expect(stop1).toContain("highest-leverage asserted premise");
    expect(stop1).toContain("`audit:` marker");
    expect(stop1).toContain("unresolved-marker state");
    expect(stop1).toContain("never blocks bind");

    const method = markdownSection(text, "### Critic method");
    expect(method).not.toContain("`refutation-target:`");
    expect(method).not.toContain("Dispose a recorded");
    expect(method).not.toContain("no required output form");
    expect(method).not.toContain("no mechanized consumer");
    expect(method).not.toContain("when the field is present");

    const template = readText(TEMPLATE);
    expect(template).toContain("`refutation-target:`");
    expect(template).not.toContain("never blocks bind");
    expect(template).not.toContain("unresolved-marker state");
    expect(template).not.toContain("before any critic exists");
    expect(template).not.toContain("highest-leverage asserted premise");
  });

  it("locks the verified-claims table heading and the citation form it binds on (#3942)", () => {
    const text = readText(CONTRACT);
    const stop5 = markdownSection(text, "## Stop 5 \u2014 Verified synthesis");
    expect(stop5, "verified-claims table heading section missing").toContain(
      "### Verified-claims table heading",
    );
    expect(stop5).toContain("isVerifiedClaimsTableBody");
    expect(stop5).toContain("only artifact-identity signal the resolver has");
    expect(stop5).toContain(
      "- ! Open the verified-claims table with the `## Verified-claims table` heading whenever " +
        "the synthesis names that table with a typed `verified-claims table <id>` citation.",
    );
    expect(stop5).toContain("blocks on `unshaped-table-cite`");
    expect(stop5).toContain(
      "- ! State the requirement together with the citation form that makes it operative.",
    );
    expect(stop5).toContain(
      "⊗ Publish the heading as a requirement binding on every citation form.",
    );
    expect(stop5).toContain("**The untyped path has no verdict effect.**");
    expect(stop5).toContain("records a null `citedTableId`");
    expect(stop5).toContain("The resolved id has no consumer today");
    expect(stop5).toContain("`### Reserved line-starts`");

    // The re-measured matrix cell, and the cross-reference that keeps one token
    // from reading as a hazard in one section and an obligation in another.
    const summary = markdownSection(text, "## Plain-language summary");
    expect(summary).toContain("Re-measured at `764f63a6`");
    expect(summary).not.toContain("Measured at `c6761881`");
    expect(summary).toContain("the lean stands in as the table on the untyped path");
    expect(summary).toContain(
      "A typed claim now blocks whether or not the lean carries the heading",
    );
    expect(summary).toContain("- ! Read this matrix with `### Verified-claims table heading`.");

    const grammar = markdownSection(text, "## Citation grammar");
    expect(grammar).toContain("`CompletedArcBlockReason` is closed.");
    for (const reason of COMPLETED_ARC_BLOCK_REASONS) {
      expect(grammar, `reason ${reason} is unpublished`).toContain(`| \`${reason}\` |`);
    }
    expect(grammar).toContain(
      "- ! Publish a reason in that table before the evaluator returns it.",
    );
    expect(grammar).toContain("⊗ Merge two states under one reason when their remedies differ.");
    expect(grammar).toContain("That is conformance to it, not a second rule.");

    const testSurface = markdownSection(text, "## Test surface");
    expect(testSurface).toContain("### Verified-claims table heading");
    expect(testSurface).toContain("#3942");

    const skill = readText(SKILL_REL);
    expect(skill).not.toContain("unshaped-table-cite");
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
