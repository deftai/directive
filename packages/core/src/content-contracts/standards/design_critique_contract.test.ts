/** Content contract for design-critique SoT + brief template + thin skill (#3434). */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { remainingSetAfterDesignCritiqueChip } from "../../design-critique/exclusive-chip.js";
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
  "model: grok-4.6",
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
  "AND zero unresolved audit markers",
  "independence, not provenance",
  "measured-versus-asserted",
  "before any critic exists",
  "`refutation-target:`",
  "highest-leverage asserted premise",
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
    expect(contract).toContain("```text\nmodel: grok-4.6\nrole: critic\n```");
    expect(contract).toContain("! First line of the triage write-back comment is `model: <slug>`.");
    expect(contract).toContain("! Second line of the triage write-back comment is `role: triage`.");
    expect(contract).toContain(
      "! First line of every critic comment is `model: <slug>` for the model that produced that comment.",
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
      "⊗ Infer role from `verify:routing` or spawn metadata and omit it from the comment.",
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
    expect(text).toContain("These are not rules.");
    expect(text).toContain("A parent that leans on any of them MUST carry an audit marker");
    expect(text).toContain("the most recent parent artifact that supersedes the map");
    expect(text).toContain("that amendment becomes the ceiling");
    expect(text).toContain("both panel arcs declined it");
    expect(text).toContain("the merged map");
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
      "Auto-bind requires an all-accept disposition map AND zero unresolved audit markers.",
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
