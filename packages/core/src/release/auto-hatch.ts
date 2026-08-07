/**
 * Release Step 5 auto-hatch for branch-only coverage hairlines (#3187 / #2866).
 *
 * Pure classifier + ledger helpers + debt-issue body. Network I/O is seamed so
 * unit tests never hit live GitHub.
 */
import {
  COVERAGE_GOAL,
  type CoverageTotals,
  metricsBelowGoal,
} from "../vitest-runner/coverage-debt.js";

/** Machine-checkable Step 5 failure classes (#3187). */
export type Step5FailureClass =
  | "REAL_FAILURE"
  | "BRANCH_HAIRLINE"
  | "OTHER_COVERAGE"
  | "UNKNOWN";

export interface ClassifyStep5FailureInput {
  /** Combined reason / stdout / stderr from the Step 5 check (may be thin). */
  readonly output?: string | null;
  /** Aggregated totals from coverage/coverage-final.json when present. */
  readonly totals?: CoverageTotals | null;
  /** Exit code when known (124 = hard timeout). */
  readonly exitCode?: number | null;
  /** True when the check hit the Step 5 wall-clock budget. */
  readonly timedOut?: boolean;
  /** Explicit failed-test count when the runner reports one. */
  readonly failedTests?: number | null;
}

const REAL_FAILURE_PATTERNS: readonly RegExp[] = [
  /\btimed?\s*out\b/i,
  /\bhang(?:ing|ed)?\b/i,
  /\b\d+\s+failed\b/i,
  /\bfailed\s+tests?\b/i,
  /\bTests?\s+failed\b/i,
  /\bFAIL\s+\S+/i,
  /\bAssertionError\b/,
  /\bError:\s/i,
  /vitest coverage hang/i,
];

const COVERAGE_THRESHOLD_PATTERNS: readonly RegExp[] = [
  /Coverage for (\w+)\s*\(([\d.]+)%\)\s*does not meet/i,
  /ERROR:\s*Coverage for (\w+)/i,
  /coverage threshold/i,
  /below (?:the )?(?:global )?threshold/i,
];

/**
 * Classify metrics alone (no output / test signals).
 * Returns null when totals are absent.
 */
export function classifyCoverageMetrics(
  totals: CoverageTotals | null | undefined,
): "ok" | "branch_hairline" | "other_coverage" | null {
  if (!totals) return null;
  const missed = metricsBelowGoal(totals);
  if (missed.length === 0) return "ok";
  if (missed.length === 1 && missed[0] === "branches") return "branch_hairline";
  return "other_coverage";
}

function outputSuggestsRealFailure(output: string): boolean {
  // Coverage-threshold lines alone are not real product failures.
  const withoutCoverage = output
    .split(/\r?\n/)
    .filter((line) => !COVERAGE_THRESHOLD_PATTERNS.some((re) => re.test(line)))
    .join("\n");
  return REAL_FAILURE_PATTERNS.some((re) => re.test(withoutCoverage));
}

function outputSuggestsCoverageThreshold(output: string): boolean {
  return COVERAGE_THRESHOLD_PATTERNS.some((re) => re.test(output));
}

/**
 * Pure classifier for release Step 5 non-zero outcomes.
 *
 * Prefer coverage-final totals when present; fall back to parseable output.
 * Fail closed to UNKNOWN when evidence is ambiguous.
 */
export function classifyStep5Failure(input: ClassifyStep5FailureInput): Step5FailureClass {
  const output = (input.output ?? "").trim();
  const timedOut = input.timedOut === true || input.exitCode === 124;
  const failedTests =
    typeof input.failedTests === "number" && Number.isFinite(input.failedTests)
      ? input.failedTests
      : null;

  if (timedOut) return "REAL_FAILURE";
  if (failedTests !== null && failedTests > 0) return "REAL_FAILURE";
  if (output && outputSuggestsRealFailure(output)) return "REAL_FAILURE";

  const metricClass = classifyCoverageMetrics(input.totals ?? null);
  if (metricClass === "branch_hairline") return "BRANCH_HAIRLINE";
  if (metricClass === "other_coverage") return "OTHER_COVERAGE";
  if (metricClass === "ok") {
    // Coverage met the bar but Step 5 still failed → non-coverage defect.
    return output ? "REAL_FAILURE" : "UNKNOWN";
  }

  // No totals — try output-only signals.
  if (output && outputSuggestsCoverageThreshold(output)) {
    // Without totals we cannot prove branch-only; refuse to auto-hatch.
    return "OTHER_COVERAGE";
  }
  if (output) return "UNKNOWN";
  return "UNKNOWN";
}

/** Open-issue shape used by the coverage-debt ledger probe. */
export interface CoverageDebtIssueProbe {
  readonly number: number;
  readonly title?: string | null;
  readonly body?: string | null;
  readonly state?: string | null;
}

const DEBT_MARKER_RE = /coverage[- ]debt|--allow-coverage-debt/i;

/** True when title/body carry the mandatory debt markers (#2866). */
export function issueHasCoverageDebtMarkers(issue: CoverageDebtIssueProbe): boolean {
  const blob = `${issue.title ?? ""}\n${issue.body ?? ""}`;
  return DEBT_MARKER_RE.test(blob);
}

/**
 * Filter issues that count as unpaid coverage debt on the ledger.
 *
 * Accepts:
 * - open issues with coverage-debt / --allow-coverage-debt markers
 * - citation-only probes (`{ number }` only) from CHANGELOG scan after state check
 */
export function filterOpenCoverageDebtIssues(
  issues: readonly CoverageDebtIssueProbe[],
): number[] {
  const open = new Set<number>();
  for (const issue of issues) {
    if (!issue.number || issue.number <= 0) continue;
    const state = (issue.state ?? "OPEN").toUpperCase();
    if (state !== "OPEN") continue;
    const citationOnly = issue.title == null && issue.body == null;
    if (citationOnly || issueHasCoverageDebtMarkers(issue)) {
      open.add(issue.number);
    }
  }
  return [...open].sort((a, b) => a - b);
}

/**
 * Parse `--allow-coverage-debt=#N` / `allow-coverage-debt=#N` citations from
 * CHANGELOG Unreleased + the last few version sections (legacy hatch ledger).
 */
export function extractCoverageDebtCitationsFromChangelog(
  changelog: string,
  maxVersionSections = 3,
): number[] {
  const versionHeader = /^## \[(?!Unreleased)/m;
  const parts = changelog.split(versionHeader);
  // parts[0] includes ## [Unreleased] and preamble; then each version section.
  const windows = [parts[0] ?? "", ...parts.slice(1, maxVersionSections + 1)];
  const found = new Set<number>();
  const re = /allow-coverage-debt=#?(\d+)/gi;
  for (const section of windows) {
    let m: RegExpExecArray | null = re.exec(section);
    while (m) {
      const n = Number.parseInt(m[1] ?? "", 10);
      if (Number.isFinite(n) && n > 0) found.add(n);
      m = re.exec(section);
    }
  }
  return [...found].sort((a, b) => a - b);
}

/** Union marker-search hits with CHANGELOG-cited open issues. */
export function mergeOpenDebtLedger(
  markerHits: readonly number[],
  changelogCitedOpen: readonly number[],
): number[] {
  return [...new Set([...markerHits, ...changelogCitedOpen])].sort((a, b) => a - b);
}

export interface CoverageDebtIssueDraft {
  readonly title: string;
  readonly body: string;
}

/** Build a marker-compliant coverage-debt issue for auto-hatch (#3187). */
export function buildCoverageDebtIssueDraft(options: {
  readonly version: string;
  readonly totals: CoverageTotals;
  readonly autoHatched?: boolean;
}): CoverageDebtIssueDraft {
  const { version, totals } = options;
  const auto = options.autoHatched !== false;
  const fmt = (n: number) => n.toFixed(2);
  const title = `coverage-debt: restore branch coverage after v${version} hairline (${fmt(totals.branches)}%)`;
  const body = [
    `## coverage-debt`,
    "",
    auto
      ? "Auto-filed by `task release` Step 5 auto-hatch (#3187) after a branch-only hairline."
      : "Filed for release Step 5 coverage-debt hatch (#2866).",
    "",
    "### Markers",
    "",
    "- `coverage-debt`",
    "- `--allow-coverage-debt`",
    "",
    "### Measured (at hatch)",
    "",
    `| Metric | Measured | Goal |`,
    `| --- | ---: | ---: |`,
    `| branches | ${fmt(totals.branches)}% | ${COVERAGE_GOAL.branches}% |`,
    `| lines | ${fmt(totals.lines)}% | ${COVERAGE_GOAL.lines}% |`,
    `| functions | ${fmt(totals.functions)}% | ${COVERAGE_GOAL.functions}% |`,
    `| statements | ${fmt(totals.statements)}% | ${COVERAGE_GOAL.statements}% |`,
    "",
    `### Cut`,
    "",
    `- Release version: \`v${version}\``,
    "- Trigger: **branches** sole metric below 85% (lines / functions / statements all ≥ 85%)",
    "",
    "### Acceptance",
    "",
    "- [ ] All four coverage metrics (lines, functions, branches, statements) ≥ 85%",
    "- [ ] Close this issue only after real coverage is restored (no consecutive soft-pass while open)",
    "",
    "Refs #3187, #2866, #2573.",
  ].join("\n");
  return { title, body };
}

export type AutoHatchDecision =
  | {
      readonly kind: "pass_with_debt";
      readonly issue: number;
      readonly created: boolean;
      readonly class: "BRANCH_HAIRLINE";
      readonly totals: CoverageTotals;
    }
  | {
      readonly kind: "fail_closed";
      readonly class: Step5FailureClass;
      readonly reason: string;
      readonly openDebtIssues?: readonly number[];
    };

export interface AutoHatchEvaluateInput {
  readonly classification: Step5FailureClass;
  readonly totals: CoverageTotals | null;
  readonly openDebtIssues: readonly number[];
  /** When true, create a new issue via createIssue (seamed). */
  readonly createIssue?: () => number;
  /** Operator already supplied --allow-coverage-debt=#N — never auto-create. */
  readonly existingDebtIssue?: number | null;
  /** Optional hard cut: refuse auto-hatch even on hairline. */
  readonly noAutoCoverageDebt?: boolean;
}

/**
 * Decide whether Step 5 may soft-pass after one suite run (#3187).
 * Never continues without a durable issue number (file-before-continue).
 */
export function evaluateAutoHatch(input: AutoHatchEvaluateInput): AutoHatchDecision {
  if (input.classification !== "BRANCH_HAIRLINE") {
    return {
      kind: "fail_closed",
      class: input.classification,
      reason:
        input.classification === "REAL_FAILURE"
          ? "real failure / hang / failed tests — use file-and-merge (#2859)"
          : input.classification === "OTHER_COVERAGE"
            ? "non-hairline coverage miss — auto-hatch refused"
            : "cannot classify Step 5 failure (UNKNOWN) — fail closed",
    };
  }

  if (input.noAutoCoverageDebt) {
    return {
      kind: "fail_closed",
      class: "BRANCH_HAIRLINE",
      reason: "auto-hatch disabled (--no-auto-coverage-debt)",
    };
  }

  if (!input.totals) {
    return {
      kind: "fail_closed",
      class: "UNKNOWN",
      reason: "BRANCH_HAIRLINE without measurable totals — refuse auto-hatch",
    };
  }

  if (input.openDebtIssues.length > 0) {
    const listed = input.openDebtIssues.map((n) => `#${n}`).join(", ");
    return {
      kind: "fail_closed",
      class: "BRANCH_HAIRLINE",
      reason: `open coverage-debt ledger not empty (${listed}); restore coverage and close before soft-pass`,
      openDebtIssues: input.openDebtIssues,
    };
  }

  if (input.existingDebtIssue != null && input.existingDebtIssue > 0) {
    // Operator already bound a debt issue; treat as acknowledged hatch without create.
    return {
      kind: "pass_with_debt",
      issue: input.existingDebtIssue,
      created: false,
      class: "BRANCH_HAIRLINE",
      totals: input.totals,
    };
  }

  if (!input.createIssue) {
    return {
      kind: "fail_closed",
      class: "BRANCH_HAIRLINE",
      reason: "auto-hatch requires createIssue seam to file durable debt before continue",
    };
  }

  const issue = input.createIssue();
  if (!Number.isFinite(issue) || issue <= 0) {
    return {
      kind: "fail_closed",
      class: "BRANCH_HAIRLINE",
      reason: "auto-hatch issue create returned invalid number — refuse continue without ledger",
    };
  }

  return {
    kind: "pass_with_debt",
    issue,
    created: true,
    class: "BRANCH_HAIRLINE",
    totals: input.totals,
  };
}

/** Loud stderr banner when Step 5 continues via auto-hatch. */
export function formatAutoHatchBanner(issue: number, totals: CoverageTotals): string {
  return (
    `*** AUTO-HATCH: coverage-debt #${issue} filed; Step 5 PASS_WITH_DEBT (no suite re-run) ***\n` +
    `  branches ${totals.branches.toFixed(2)}% (sole metric < ${COVERAGE_GOAL.branches}%); ` +
    `lines ${totals.lines.toFixed(2)}% | functions ${totals.functions.toFixed(2)}% | ` +
    `statements ${totals.statements.toFixed(2)}% all ≥ goal\n` +
    `  Cite #${issue} in CHANGELOG / release notes. Restore all four metrics before close.\n`
  );
}

/** Parse exit code from the default runReleaseCheck reason string when present. */
export function parseExitCodeFromReason(reason: string): number | null {
  const m = /exit\s+(\d+)/i.exec(reason);
  if (!m) return null;
  const n = Number.parseInt(m[1] ?? "", 10);
  return Number.isFinite(n) ? n : null;
}

export function reasonLooksLikeTimeout(reason: string): boolean {
  return /timed out|timeout/i.test(reason);
}
