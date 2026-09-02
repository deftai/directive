/**
 * #4070 withdraw: fail-close classify --mirror, remaining-set strip of
 * triaged / triage:* chips, and a shadowed-vs-faithful digest for #4071.
 *
 * Strip is remaining-set apply, not classify. Classify engine is used only
 * for the pre-strip digest.
 */

import { type GhRestSeams, restIssueListPaginated } from "../../scm/gh-rest.js";
import { ScmLabelClient } from "../../vbrief-reconcile/labels.js";
import type { LabelClient } from "../../vbrief-reconcile/types.js";

/** Structural classify result — avoids importing ./index.js (cycle with re-export). */
export interface WithdrawClassification {
  readonly action: string;
  readonly reason: string;
  readonly ruleIndex: number;
  readonly ruleSource: string;
  readonly ruleKind: string;
  readonly resumeOn: string | null;
}

export interface WithdrawGitHubIssue {
  readonly number?: number;
  readonly state?: string;
  readonly body?: string | null;
  readonly labels?: ReadonlyArray<{ name?: string } | string>;
}

export const CLASSIFY_MIRROR_WITHDRAWN_ISSUE = 4070;
export const CLASSIFY_MIRROR_WITHDRAWN_REPLACEMENT_ISSUE = 4071;
export const CLASSIFY_MIRROR_WITHDRAWN_TRANSITIVE_ISSUE = 3579;

export const WITHDRAWN_TRIAGE_CHIPS = [
  "triaged",
  "triage:deferred",
  "triage:archived",
  "triage:lifecycle-linked",
  "triage:needs-human",
] as const;

export type WithdrawnTriageChip = (typeof WITHDRAWN_TRIAGE_CHIPS)[number];

const WITHDRAWN = new Set<string>(WITHDRAWN_TRIAGE_CHIPS);

export const CLASSIFY_MIRROR_WITHDRAWN_EXIT_CODE = 1;

export const CLASSIFY_MIRROR_WITHDRAWN_MESSAGE =
  "triage:classify --mirror is withdrawn (#4070). Dry-run and --apply both fail closed. " +
  "Replacement sieve is #4071. #3579 is transitively withdrawn for the gap. " +
  "Do not close #1423, #3579, #2611, or #3923 from this change.";

export function isWithdrawnTriageChip(name: string): name is WithdrawnTriageChip {
  return WITHDRAWN.has(name);
}

/** Remaining-set after dropping withdrawn chips. Other facets stay, including catalog chips. */
export function remainingSetAfterWithdrawnChipStrip(current: readonly string[]): string[] {
  return current.filter((name) => !WITHDRAWN.has(name));
}

export function withdrawnChipStripDelta(current: readonly string[]): {
  add: string[];
  remove: string[];
} {
  return {
    add: [],
    remove: current.filter((name) => WITHDRAWN.has(name)),
  };
}

export function applyWithdrawnChipStrip(
  client: LabelClient,
  repo: string,
  issueNumber: number,
  current?: readonly string[],
): { remaining: string[]; add: readonly string[]; remove: readonly string[] } {
  const labels = current ?? client.fetchLabels(repo, issueNumber);
  const { add, remove } = withdrawnChipStripDelta(labels);
  if (add.length > 0 || remove.length > 0) {
    client.apply(repo, issueNumber, add, remove);
  }
  return {
    remaining: remainingSetAfterWithdrawnChipStrip(labels),
    add,
    remove,
  };
}

export function labelNamesFromIssueLike(issue: {
  readonly labels?: ReadonlyArray<{ name?: string } | string>;
}): string[] {
  const labels = issue.labels ?? [];
  const names: string[] = [];
  for (const entry of labels) {
    if (typeof entry === "string") {
      if (entry.length > 0) names.push(entry);
    } else if (typeof entry === "object" && entry !== null && typeof entry.name === "string") {
      if (entry.name.length > 0) names.push(entry.name);
    }
  }
  return names;
}

export interface WithdrawnChipIssue {
  readonly number: number;
  readonly state?: string;
  readonly body?: string | null;
  readonly title?: string;
  readonly labels: readonly string[];
}

export type ListWithdrawnChipIssues = (
  repo: string,
  label: WithdrawnTriageChip,
) => readonly WithdrawnChipIssue[];

export type ClassifyIssueFn = (
  issue: WithdrawGitHubIssue,
  options?: { rules?: readonly unknown[]; holdMarkers?: string[] | null },
) => WithdrawClassification | null;

export interface ShadowDigestEntry {
  readonly repo: string;
  readonly issue_number: number;
  readonly state: string | null;
  readonly current_labels: readonly string[];
  readonly matched: WithdrawClassification | null;
  readonly without_hold_marker: WithdrawClassification | null;
  readonly shadowed: boolean;
}

export function shadowedVsFaithfulEntry(
  issue: WithdrawGitHubIssue,
  classify: ClassifyIssueFn,
  rules: readonly unknown[],
  holdMarkers: string[] | null,
): Pick<ShadowDigestEntry, "matched" | "without_hold_marker" | "shadowed"> {
  const matched = classify(issue, { rules, holdMarkers });
  const withoutHold = rules.filter((rule) => {
    if (typeof rule !== "object" || rule === null) return true;
    return (rule as { rule?: string }).rule !== "universal:hold-marker";
  });
  const without = classify(issue, { rules: withoutHold, holdMarkers });
  const shadowed =
    matched !== null &&
    matched.ruleKind === "universal:hold-marker" &&
    without !== null &&
    without.ruleKind !== matched.ruleKind;
  return { matched, without_hold_marker: without, shadowed };
}

function issueFromRow(row: Record<string, unknown>): WithdrawnChipIssue | null {
  if ("pull_request" in row) return null;
  const n = row.number;
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) return null;
  const labels = labelNamesFromIssueLike({
    labels: Array.isArray(row.labels)
      ? (row.labels as Array<{ name?: string } | string>)
      : undefined,
  });
  return {
    number: n,
    state: typeof row.state === "string" ? row.state : undefined,
    body: typeof row.body === "string" ? row.body : row.body === null ? null : undefined,
    title: typeof row.title === "string" ? row.title : undefined,
    labels,
  };
}

export function defaultListWithdrawnChipIssues(
  repo: string,
  label: WithdrawnTriageChip,
  seams: GhRestSeams = {},
): WithdrawnChipIssue[] {
  const rows = restIssueListPaginated(
    repo,
    { state: "all", labels: [label], perPage: 100, excludePulls: true },
    seams,
  );
  const out: WithdrawnChipIssue[] = [];
  for (const row of rows) {
    const issue = issueFromRow(row);
    if (issue !== null) out.push(issue);
  }
  return out;
}

export function unionWithdrawnChipIssues(
  perChip: ReadonlyArray<readonly WithdrawnChipIssue[]>,
): WithdrawnChipIssue[] {
  const byNumber = new Map<number, WithdrawnChipIssue>();
  for (const batch of perChip) {
    for (const issue of batch) {
      const prior = byNumber.get(issue.number);
      if (prior === undefined) {
        byNumber.set(issue.number, issue);
        continue;
      }
      const labels = [...new Set([...prior.labels, ...issue.labels])];
      byNumber.set(issue.number, { ...prior, labels });
    }
  }
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

export interface StripWithdrawnChipsOptions {
  readonly repo: string;
  readonly dryRun?: boolean;
  readonly client?: LabelClient;
  readonly listIssues?: ListWithdrawnChipIssues;
  readonly classify?: ClassifyIssueFn;
  readonly rules?: readonly unknown[];
  readonly holdMarkers?: string[] | null;
  readonly emitDigest?: boolean;
}

export interface StripWithdrawnChipsItem {
  readonly repo: string;
  readonly issue_number: number;
  readonly current: readonly string[];
  readonly remaining: readonly string[];
  readonly remove: readonly string[];
  readonly status: "planned" | "applied" | "unchanged" | "error";
  readonly message: string | null;
}

export interface StripWithdrawnChipsOutcome {
  readonly repo: string;
  readonly dry_run: boolean;
  readonly scanned: number;
  readonly planned: number;
  readonly applied: number;
  readonly unchanged: number;
  readonly errors: number;
  readonly items: readonly StripWithdrawnChipsItem[];
  readonly digest: readonly ShadowDigestEntry[] | null;
}

export function stripWithdrawnChips(
  options: StripWithdrawnChipsOptions,
): [number, StripWithdrawnChipsOutcome] {
  const dryRun = options.dryRun ?? true;
  const list = options.listIssues ?? defaultListWithdrawnChipIssues;
  const batches = WITHDRAWN_TRIAGE_CHIPS.map((chip) => list(options.repo, chip));
  const issues = unionWithdrawnChipIssues(batches);
  const client = options.client ?? new ScmLabelClient();

  const digest: ShadowDigestEntry[] | null =
    options.emitDigest === true && options.classify !== undefined
      ? issues.map((issue) => {
          const ghIssue: WithdrawGitHubIssue = {
            number: issue.number,
            state: issue.state,
            body: issue.body,
            labels: issue.labels,
          };
          const shadow = shadowedVsFaithfulEntry(
            ghIssue,
            options.classify as ClassifyIssueFn,
            options.rules ?? [],
            options.holdMarkers ?? null,
          );
          return {
            repo: options.repo,
            issue_number: issue.number,
            state: issue.state ?? null,
            current_labels: issue.labels,
            ...shadow,
          };
        })
      : options.emitDigest === true
        ? []
        : null;

  const items: StripWithdrawnChipsItem[] = [];
  let planned = 0;
  let applied = 0;
  let unchanged = 0;
  let errors = 0;

  for (const issue of issues) {
    const current =
      issue.labels.length > 0 ? [...issue.labels] : client.fetchLabels(options.repo, issue.number);
    const delta = withdrawnChipStripDelta(current);
    if (delta.remove.length === 0) {
      unchanged += 1;
      items.push({
        repo: options.repo,
        issue_number: issue.number,
        current,
        remaining: remainingSetAfterWithdrawnChipStrip(current),
        remove: [],
        status: "unchanged",
        message: null,
      });
      continue;
    }
    if (dryRun) {
      planned += 1;
      items.push({
        repo: options.repo,
        issue_number: issue.number,
        current,
        remaining: remainingSetAfterWithdrawnChipStrip(current),
        remove: delta.remove,
        status: "planned",
        message: null,
      });
      continue;
    }
    try {
      const result = applyWithdrawnChipStrip(client, options.repo, issue.number, current);
      applied += 1;
      items.push({
        repo: options.repo,
        issue_number: issue.number,
        current,
        remaining: result.remaining,
        remove: result.remove,
        status: "applied",
        message: null,
      });
    } catch (err) {
      errors += 1;
      items.push({
        repo: options.repo,
        issue_number: issue.number,
        current,
        remaining: remainingSetAfterWithdrawnChipStrip(current),
        remove: delta.remove,
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const outcome: StripWithdrawnChipsOutcome = {
    repo: options.repo,
    dry_run: dryRun,
    scanned: issues.length,
    planned,
    applied,
    unchanged,
    errors,
    items,
    digest,
  };
  return [errors > 0 ? 1 : 0, outcome];
}
