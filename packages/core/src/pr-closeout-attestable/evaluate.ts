/**
 * Merge-time closeout attestability gate (#3781).
 *
 * A pull request may leave a brief unattested; it may not MERGE one whose issue
 * it closes in the same act. The trigger is the PR's structured closing
 * references, never the branch diff: CI runs before the merge and the issue
 * closes on it, so at check time no orphan exists yet and a diff-keyed gate can
 * never fail the PR that introduces the problem (PR #3786's own merge gate
 * returned success while creating one). The brief also need not be in the diff —
 * for #3598 it landed on master seventeen hours before its closing PR.
 *
 * The rule itself is not restated here. `evaluateAcceptanceEvidenceGate` is the
 * single decision procedure `scope:complete` enforces, and this gate calls it so
 * the two cannot drift.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { hasArtifactSuffix, resolveLifecycleRoot } from "../layout/resolve.js";
import { type GateRunner, makeGateRunner } from "../orphan-active/issue-state.js";
import { collectGithubRefs } from "../orphan-active/refs.js";
import { fetchClosingIssuesReferences } from "../pr-protected-issues/gh.js";
import type { RunGhFn } from "../pr-protected-issues/types.js";
import {
  ACCEPTANCE_DISPOSITION_KEY,
  ACCEPTANCE_DISPOSITIONS,
  ACCEPTANCE_EVIDENCE_KEY,
  ACCEPTANCE_EVIDENCE_KINDS,
  evaluateAcceptanceEvidenceGate,
  inferRequiredStrictAxes,
  type StrictAcceptanceAxis,
} from "../scope/acceptance-evidence.js";
import { resolveRepo } from "../triage/queue/repo.js";

export type OutputStream = "stdout" | "stderr" | "none";

/** One acceptance criterion the merge would strand without evidence or disposition. */
export interface UnattestedCriterion {
  /** Plan-item path, e.g. `items[3]` or `items[1].subItems[0]`. */
  readonly path: string;
  readonly title: string;
  /** Verbatim detail from `evaluateAcceptanceEvidenceGate` — the reason it refused. */
  readonly detail: string;
  /**
   * Strict axes inferred for this criterion (#3240). Non-empty means `merge` and
   * `review` evidence cannot satisfy it, so the message must say which kind can.
   */
  readonly requiredAxes: readonly StrictAcceptanceAxis[];
}

/** An active/running brief the PR's closing reference would orphan on merge. */
export interface CloseoutFinding {
  /** Project-root-relative brief path. */
  readonly briefPath: string;
  /** The closing-referenced issue this brief tracks. */
  readonly issue: number;
  readonly unattested: readonly UnattestedCriterion[];
}

export interface PrCloseoutAttestableResult {
  /** 0 attestable / 1 unattested closeout / 2 config or lookup error. */
  readonly code: 0 | 1 | 2;
  readonly message: string;
  readonly stream: OutputStream;
  readonly prNumber: number;
  /** Structured closing-issue references read from the forge. */
  readonly closingIssues: readonly number[];
  readonly findings: readonly CloseoutFinding[];
  /** True when the closing-reference read resolved through `ghx`, a cached GET proxy. */
  readonly proxied: boolean;
}

/** Reads the PR's structured closing-issue references; `null` on lookup failure. */
export type FetchClosingIssuesFn = (
  prNumber: number,
  repo: string | null,
  runGh: RunGhFn,
) => number[] | null;

export interface EvaluateOptions {
  readonly repo?: string | null;
  /**
   * SCM read seam plus its freshness basis. Defaults to `makeGateRunner()`, which
   * pins plain `gh` when present so a cached `ghx` GET cannot fail this gate open.
   */
  readonly runner?: GateRunner;
  readonly quiet?: boolean;
  /** Closing-reference seam so tests do not need a forge. */
  readonly fetchClosingIssues?: FetchClosingIssuesFn;
}

interface ActiveBrief {
  readonly path: string;
  readonly plan: Record<string, unknown>;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function planOf(data: Record<string, unknown> | null): Record<string, unknown> | null {
  const plan = data?.plan;
  return typeof plan === "object" && plan !== null && !Array.isArray(plan)
    ? (plan as Record<string, unknown>)
    : null;
}

function relBriefPath(path: string, projectRoot: string): string {
  try {
    return relative(resolve(projectRoot), resolve(path)).replace(/\\/g, "/");
  } catch {
    return path.replace(/\\/g, "/");
  }
}

function listActiveRunningBriefs(lifecycleRoot: string): ActiveBrief[] {
  const activeDir = join(lifecycleRoot, "active");
  if (!existsSync(activeDir)) {
    return [];
  }
  const out: ActiveBrief[] = [];
  for (const entry of readdirSync(activeDir, { withFileTypes: true })) {
    if (!entry.isFile() || !hasArtifactSuffix(entry.name)) {
      continue;
    }
    const path = join(activeDir, entry.name);
    const plan = planOf(readJson(path));
    if (plan === null || String(plan.status ?? "").toLowerCase() !== "running") {
      continue;
    }
    out.push({ path, plan });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Index plan items by the same path the acceptance gate reports, so a blocker can
 * be mapped back to its item for axis inference. Traversal order mirrors
 * `walkItems` in `scope/acceptance-evidence.ts`; the attestation rule stays there.
 */
function indexPlanItems(
  items: unknown,
  pathPrefix: string,
  out: Map<string, Record<string, unknown>>,
): void {
  if (!Array.isArray(items)) {
    return;
  }
  items.forEach((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return;
    }
    const obj = item as Record<string, unknown>;
    const path = `${pathPrefix}[${index}]`;
    out.set(path, obj);
    indexPlanItems(obj.subItems, `${path}.subItems`, out);
    indexPlanItems(obj.items, `${path}.items`, out);
  });
}

const DISPOSITION_SHAPE =
  `${ACCEPTANCE_DISPOSITION_KEY} {disposition: ${ACCEPTANCE_DISPOSITIONS.join("|")}, ` +
  `reason, provenance {kind: operator-cli|operator-session|human-event, actor: <non-agent>}, recorded_at}`;

function evidenceShape(kinds: string): string {
  return `${ACCEPTANCE_EVIDENCE_KEY} {kind: ${kinds}, pointer, recorded_at, recorded_by}`;
}

/**
 * Name the exact shape this criterion needs. A single evidence.kind covers one
 * axis, so two inferred axes cannot be satisfied by any kind — say that instead of
 * printing a kind list that would still be refused (#3240 suitability rule).
 */
function renderCriterion(criterion: UnattestedCriterion): string[] {
  const axes = criterion.requiredAxes;
  const lines = [
    `      - ${criterion.path} "${criterion.title}"`,
    `          why:   ${criterion.detail}`,
  ];

  if (axes.length > 1) {
    lines.push(
      `          axis:  this criterion requires ${axes.join(" + ")}; no single evidence.kind covers`,
      "                 two axes, so evidence cannot satisfy it as written",
      `          needs: pin one axis with "requires": "${axes[0]}" then ` +
        `${evidenceShape(axes[0] as string)},`,
      "                 or split the criterion one axis per item,",
      `                 or ${DISPOSITION_SHAPE}`,
    );
    return lines;
  }

  const kinds = axes.length === 1 ? (axes[0] as string) : ACCEPTANCE_EVIDENCE_KINDS.join("|");
  lines.push(
    `          needs: ${evidenceShape(kinds)}`,
    `                 or ${DISPOSITION_SHAPE}`,
  );
  if (axes.length === 1) {
    lines.push(
      `          axis:  this criterion requires ${axes[0]} — ` +
        "merge and review evidence cannot satisfy it (#3240)",
    );
  }
  return lines;
}

/**
 * `gh` was absent so the closing-reference read went through `ghx`, a cached GET
 * proxy this gate cannot inspect. Say so rather than implying a fresh read
 * (#3767 / #3737).
 */
const PROXIED_CAVEAT =
  "  Note: `gh` was not on PATH, so the closing-reference read resolved through `ghx`, a cached\n" +
  "  GET proxy; freshness is bounded by that proxy, which this gate cannot inspect (#3737).";

function formatRefusal(
  prNumber: number,
  findings: readonly CloseoutFinding[],
  projectRoot: string,
  proxied: boolean,
): string {
  const criteria = findings.reduce((sum, f) => sum + f.unattested.length, 0);
  const briefNoun = findings.length === 1 ? "brief" : "briefs";
  const criterionNoun = criteria === 1 ? "criterion" : "criteria";
  const issues = findings.map((f) => `#${f.issue}`).join(", ");

  const lines = [
    `verify:pr-closeout-attestable: PR #${prNumber} closes ${issues}, leaving ${findings.length} ` +
      `active/running ${briefNoun} with ${criteria} unattested acceptance ${criterionNoun} ` +
      `(project_root=${projectRoot}).`,
    "  Merging now strands the brief on master: the issue closes, the brief stays running in",
    "  active/, and scope:complete then refuses it. A PR may leave a brief unattested; it may",
    "  not merge one whose issue is closing in the same act (#3781).",
    "  Unattested criteria:",
  ];

  for (const finding of findings) {
    lines.push(`    ${finding.briefPath} (closes #${finding.issue})`);
    for (const criterion of finding.unattested) {
      lines.push(...renderCriterion(criterion));
    }
  }

  lines.push(
    "  Evidence is not authenticated — recorded_by accepts any non-empty string. Record what you",
    "  actually did: a pointer must be the artifact its kind names (a test run for test, this PR's",
    "  merge for merge, a deployment for deploy). An agent may evidence a criterion; only",
    "  human-origin provenance may waive one (#3240 / #2944).",
    "  Remediation (performable by this PR's author): stamp the criteria above on the brief in this",
    "  branch, commit, push, then re-run:",
    `    task verify:pr-closeout-attestable -- --pr ${prNumber}`,
    "  Trigger is the PR's closing references, not the branch diff. A PR that leaves an unattested",
    "  brief without closing its issue is unaffected.",
  );
  if (proxied) {
    lines.push(PROXIED_CAVEAT);
  }
  return lines.join("\n");
}

function configError(
  prNumber: number,
  message: string,
  proxied = false,
): PrCloseoutAttestableResult {
  return {
    code: 2,
    message: `verify:pr-closeout-attestable: ${message}`,
    stream: "stderr",
    prNumber,
    closingIssues: [],
    findings: [],
    proxied,
  };
}

/**
 * Fail closed when merging `prNumber` would close an issue whose brief is still
 * `running` in `active/` with acceptance criteria carrying neither
 * `x-directive/evidence` nor `x-directive/disposition`.
 *
 * Exit contract: 0 attestable (including "this PR closes nothing") / 1 unattested
 * closeout / 2 config or closing-reference lookup error. A lookup that cannot be
 * resolved is 2, not 0 — the gate never green-lights a merge it could not check.
 *
 * The brief is read from `projectRoot`'s working tree, which at merge time is the
 * PR head checkout. That is the tree the merge lands, and it is the same
 * working-tree basis `verify:orphan-active` uses.
 */
export function evaluate(
  projectRoot: string,
  prNumber: number,
  options: EvaluateOptions = {},
): PrCloseoutAttestableResult {
  const root = resolve(projectRoot);
  const quiet = options.quiet ?? false;

  if (!existsSync(root)) {
    return configError(prNumber, `project root does not exist: ${root}`);
  }

  let lifecycleRoot: string;
  try {
    lifecycleRoot = resolveLifecycleRoot(root);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Consumers may still be on a legacy vbrief/-only layout (#2112). Closeout
    // attestability applies to xbrief/active/ only — skip cleanly, not config fail.
    if (message.includes("No xbrief/ layout found")) {
      return {
        code: 0,
        message: quiet
          ? ""
          : "verify:pr-closeout-attestable: no xbrief/ lifecycle root; nothing to check.",
        stream: quiet ? "none" : "stdout",
        prNumber,
        closingIssues: [],
        findings: [],
        proxied: false,
      };
    }
    return configError(prNumber, message);
  }

  if (!existsSync(lifecycleRoot)) {
    return {
      code: 0,
      message: quiet
        ? ""
        : "verify:pr-closeout-attestable: no xbrief/ lifecycle root; nothing to check.",
      stream: quiet ? "none" : "stdout",
      prNumber,
      closingIssues: [],
      findings: [],
      proxied: false,
    };
  }

  // Pin plain `gh` when it exists: `ghx` is a cached GET proxy and a stale
  // closing-reference read would fail this gate open (#3767 / #3737).
  const runner = options.runner ?? makeGateRunner();
  const fetchClosing = options.fetchClosingIssues ?? fetchClosingIssuesReferences;
  const repo = resolveRepo(options.repo, root);
  if (repo === null || repo.length === 0) {
    // Closing references are repository-scoped. Without the slug this gate could
    // only compare bare numbers, and a same-numbered issue in an unrelated
    // repository would block a valid merge.
    return configError(
      prNumber,
      "cannot resolve OWNER/REPO for the closing-reference read. Pass --repo OWNER/REPO, " +
        "set $GH_REPO, or run inside a checkout with a GitHub origin remote.",
      runner.proxied,
    );
  }

  const linked = fetchClosing(prNumber, repo, runner.runGh);
  if (linked === null) {
    return configError(
      prNumber,
      `could not read closing-issue references for PR #${prNumber}` +
        ` (repo=${repo}). ` +
        "Refusing to certify the merge on an unverified lookup — retry after fixing gh auth, " +
        "rate limit, or network.",
      runner.proxied,
    );
  }

  const closingIssues = [...new Set(linked)].sort((a, b) => a - b);
  if (closingIssues.length === 0) {
    return {
      code: 0,
      message: quiet
        ? ""
        : `verify:pr-closeout-attestable: PR #${prNumber} closes no issue; closeout attestability does not apply.`,
      stream: quiet ? "none" : "stdout",
      prNumber,
      closingIssues,
      findings: [],
      proxied: runner.proxied,
    };
  }

  const closingSet = new Set(closingIssues);
  const findings: CloseoutFinding[] = [];

  for (const brief of listActiveRunningBriefs(lifecycleRoot)) {
    const { issues } = collectGithubRefs(brief.plan, repo);
    // Match on (repo, number). Closing references are scoped to the PR's repository,
    // so a bare-number match would let an unrelated brief tracking the same number in
    // another repository block this merge. Refs with no repo of their own inherit the
    // PR's repo from collectGithubRefs, which is the correct reading of a bare number.
    // GitHub slugs are case-insensitive; a case-sensitive compare would let
    // DeftAI/Directive vs deftai/directive miss and fail the gate open.
    const issue = issues.find(
      (ref) => ref.repo.toLowerCase() === repo.toLowerCase() && closingSet.has(ref.number),
    )?.number;
    if (issue === undefined) {
      continue;
    }
    const gate = evaluateAcceptanceEvidenceGate(brief.plan);
    if (gate.ok) {
      continue;
    }
    const itemsByPath = new Map<string, Record<string, unknown>>();
    indexPlanItems(brief.plan.items, "items", itemsByPath);
    const unattested: UnattestedCriterion[] = gate.reports
      .filter((report) => report.outcome === "missing" || report.outcome === "invalid")
      .map((report) => {
        const item = itemsByPath.get(report.path);
        return {
          path: report.path,
          title: report.title,
          detail: report.detail,
          requiredAxes: item === undefined ? [] : inferRequiredStrictAxes(item),
        };
      });
    findings.push({ briefPath: relBriefPath(brief.path, root), issue, unattested });
  }

  if (findings.length > 0) {
    return {
      code: 1,
      message: formatRefusal(prNumber, findings, root, runner.proxied),
      stream: "stderr",
      prNumber,
      closingIssues,
      findings,
      proxied: runner.proxied,
    };
  }

  const issueList = closingIssues.map((n) => `#${n}`).join(", ");
  const pass =
    `verify:pr-closeout-attestable: PR #${prNumber} closes ${issueList}; ` +
    "no active/running brief for those issues has unattested acceptance criteria.";
  return {
    code: 0,
    message: quiet ? "" : runner.proxied ? `${pass}\n${PROXIED_CAVEAT}` : pass,
    stream: quiet ? "none" : "stdout",
    prNumber,
    closingIssues,
    findings: [],
    proxied: runner.proxied,
  };
}
