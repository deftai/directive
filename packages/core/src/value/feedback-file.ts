import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { isFrameworkRepoRoot } from "../check/orchestrator.js";
import { policyColonInvocation } from "../policy/policy-invocation.js";
import { isValueFeedbackPathAllowed, resolveValueFeedback } from "../policy/value-feedback.js";
import {
  GhRestError,
  type GhRestSeams,
  REST_MAX_PER_PAGE,
  REST_PAGINATION_MAX_PAGES,
  REST_SHARED_ROW_BUDGET,
  restCreateIssue,
  restIssueListOpenInventory,
  restPostComment,
  runGhApi,
  splitRepo,
} from "../scm/gh-rest.js";
import { resolveProjectRoot } from "../scope/project-context.js";

export const DEFAULT_UPSTREAM_REPO = "deftai/directive";
export const FRAMEWORK_GAP_TITLE_PREFIX = "[framework-gap]";
/** Sole sanctioned title classification (#3713). Does not write `adoption-blocker`. */
export const ADOPTION_BLOCKER_TITLE_TOKEN = "BLOCKER";
/** Retained closed-issue count window for feedback:file dedup (#5099 Prefer-A Recut-2). */
export const FEEDBACK_CLOSED_DEDUP_WINDOW = 500;

const FRAMEWORK_GAP_PREFIX_RE = /^\[framework-gap\]\s*/i;
const BLOCKER_TITLE_TOKEN_RE = /^BLOCKER\b[:\s-]*/i;

/** Strip source prefix and the optional BLOCKER token so marked/unmarked titles dedup. */
export function stripTitleClassificationTokens(title: string): string {
  let rest = title.trim();
  let previous = "";
  while (rest !== previous) {
    previous = rest;
    rest = rest.replace(FRAMEWORK_GAP_PREFIX_RE, "").trim();
    rest = rest.replace(BLOCKER_TITLE_TOKEN_RE, "").trim();
  }
  return rest;
}

export type FeedbackFileOutcome =
  | "draft"
  | "filed"
  | "commented-open-duplicate"
  | "skipped-maintainer"
  | "blocked-policy"
  | "blocked-closed-duplicate"
  | "blocked-no-confirm"
  | "error-bad-args"
  | "error-config"
  | "error-network";

export type OnClosedDisposition = "comment" | "create-anyway";

export interface FeedbackGapInput {
  readonly summary: string;
  readonly context?: string;
  readonly expected?: string;
  readonly actual?: string;
  readonly sessionNotes?: string;
  /** Consumer hard-stop judgment. Advisory title token only — never applies a label. */
  readonly adoptionBlocker?: boolean;
  readonly flowAndVersion?: string;
  readonly alternatives?: string;
  readonly recoveryCost?: string;
}

export interface FeedbackFileOptions extends FeedbackGapInput {
  readonly projectRoot?: string | null;
  readonly repo?: string;
  readonly confirm?: boolean;
  readonly dryRun?: boolean;
  readonly json?: boolean;
  readonly onClosed?: OnClosedDisposition;
  /** Test/builder override for closed retained-issue window (default FEEDBACK_CLOSED_DEDUP_WINDOW). */
  readonly closedWindow?: number;
  /** Test/builder override for closed-walk raw-row budget (default REST_SHARED_ROW_BUDGET). */
  readonly closedRowBudget?: number;
  readonly seams?: GhRestSeams;
}

export interface FeedbackFileResult {
  readonly outcome: FeedbackFileOutcome;
  readonly exitCode: 0 | 1 | 2;
  readonly title: string;
  readonly body: string;
  readonly repo: string;
  readonly issueUrl?: string | null;
  readonly commentUrl?: string | null;
  readonly duplicateUrl?: string | null;
  readonly message: string;
}

export type ClosedIssueWalkOutcome = "window-exhausted" | "list-exhausted" | "cap" | "error";

export interface ClosedIssueWalkResult {
  readonly outcome: ClosedIssueWalkOutcome;
  /** Retained closed issues examined (pull rows excluded). */
  readonly inspectedIssueCount: number;
  readonly rawRows: number;
  readonly match: DuplicateMatch | null;
  readonly malformedMatch: boolean;
  readonly errorMessage?: string;
}

export interface RestClosedIssueWalkOptions {
  readonly window?: number;
  readonly perPage?: number;
  readonly remainingBudget?: number;
}

function sanitizeOneLine(value: string): string {
  return value.replace(/\r?\n/g, " ").trim();
}

/**
 * Fence free-text so line-leading `#` / `---` cannot break issue markdown (#4375).
 * Indent those lines before insertion into structured sections.
 */
export function fenceFreeTextSection(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => {
      if (/^#{1,6}(\s|$)/.test(line) || /^---\s*$/.test(line)) {
        return `    ${line}`;
      }
      return line;
    })
    .join("\n");
}

function sectionOrPlaceholder(value: string | undefined, placeholder: string): string {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) {
    return placeholder;
  }
  return fenceFreeTextSection(trimmed);
}

/** True when the resolved project root is the directive maintainer source checkout. */
export function isMaintainerFrameworkRepo(projectRoot: string): boolean {
  return isFrameworkRepoRoot(resolve(projectRoot));
}

/** Normalize a title for duplicate comparison (#1709 / #3713). */
export function normalizeForDedup(title: string): string {
  return stripTitleClassificationTokens(title)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Build the upstream issue title for a framework-gap report. */
export function buildFrameworkGapTitle(
  summary: string,
  options?: { adoptionBlocker?: boolean },
): string {
  const clean = sanitizeOneLine(summary);
  if (options?.adoptionBlocker) {
    const rest = stripTitleClassificationTokens(clean);
    return `${FRAMEWORK_GAP_TITLE_PREFIX} ${ADOPTION_BLOCKER_TITLE_TOKEN} ${rest}`;
  }
  if (clean.toLowerCase().startsWith(FRAMEWORK_GAP_TITLE_PREFIX.toLowerCase())) {
    return clean;
  }
  return `${FRAMEWORK_GAP_TITLE_PREFIX} ${clean}`;
}

function buildAdoptionImpactSection(input: FeedbackGapInput): readonly string[] {
  if (!input.adoptionBlocker) {
    return [];
  }
  return [
    "## Adoption impact",
    "",
    "This report is a consumer hard-stop: the consumer cannot complete an intended Directive flow and has no reasonable workaround.",
    "",
    `Title token: \`${ADOPTION_BLOCKER_TITLE_TOKEN}\`. This token does not apply the \`adoption-blocker\` ranking label. A privileged actor applies that label after the body-evidence test.`,
    "",
    "### Affected consumer flow and version",
    "",
    sectionOrPlaceholder(input.flowAndVersion, "_(not provided)_"),
    "",
    "### Documented alternatives attempted",
    "",
    sectionOrPlaceholder(
      input.alternatives,
      "_(not provided — why documented alternatives are not a reasonable workaround)_",
    ),
    "",
    "### Observed recovery cost",
    "",
    sectionOrPlaceholder(input.recoveryCost, "_(not provided)_"),
    "",
    "### Triage owner and date",
    "",
    "_(to be filled by a privileged actor when applying `adoption-blocker`)_",
    "",
  ];
}

export type FrameworkGapBodyMode = "issue" | "comment";

/** Build the structured framework-gap issue or evidence-comment body. */
export function buildFrameworkGapBody(
  input: FeedbackGapInput,
  options?: { mode?: FrameworkGapBodyMode; relatedClosedNumber?: number },
): string {
  const summary = sanitizeOneLine(input.summary);
  const mode = options?.mode ?? "issue";
  const footer =
    mode === "comment"
      ? "_Evidence appended via `deft feedback:file` from a directive consumer project (Refs #1709 value-feedback gap escalation)._"
      : "_Filed via `deft feedback:file` from a directive consumer project (Refs #1709 value-feedback gap escalation)._";
  const related =
    typeof options?.relatedClosedNumber === "number" &&
    Number.isFinite(options.relatedClosedNumber) &&
    options.relatedClosedNumber > 0
      ? [`Related: closed #${options.relatedClosedNumber}`, ""]
      : [];
  const lines = [
    "## Summary",
    "",
    summary,
    "",
    "## Context",
    "",
    sectionOrPlaceholder(input.context, "_(not provided)_"),
    "",
    "## Expected behavior",
    "",
    sectionOrPlaceholder(input.expected, "_(not provided)_"),
    "",
    "## Actual behavior / gap",
    "",
    sectionOrPlaceholder(input.actual, summary),
    "",
    "## Session notes",
    "",
    sectionOrPlaceholder(input.sessionNotes, "_(not provided)_"),
    "",
    ...buildAdoptionImpactSection(input),
    ...related,
    "---",
    footer,
    "",
  ];
  return lines.join("\n");
}

export interface DuplicateMatch {
  readonly number: number;
  readonly state: string;
  readonly url: string;
  readonly title: string;
}

type RowMatch = DuplicateMatch | "malformed" | null;

function matchTitleRow(row: Record<string, unknown>, needle: string): RowMatch {
  const issueTitle = typeof row.title === "string" ? row.title : "";
  if (normalizeForDedup(issueTitle) !== needle) {
    return null;
  }
  const url = typeof row.html_url === "string" ? row.html_url : "";
  const state = typeof row.state === "string" ? row.state : "";
  const number = row.number;
  if (
    typeof number !== "number" ||
    !Number.isFinite(number) ||
    number <= 0 ||
    !Number.isInteger(number) ||
    url.length === 0 ||
    state.length === 0
  ) {
    return "malformed";
  }
  return { number, state, url, title: issueTitle };
}

function fetchClosedIssuePage(
  repo: string,
  page: number,
  perPage: number,
  seams: GhRestSeams,
): Record<string, unknown>[] {
  const [owner, name] = splitRepo(repo);
  const endpoint = `repos/${owner}/${name}/issues`;
  const runner = seams.runGhApiFn ?? runGhApi;
  const args: string[] = [
    endpoint,
    "--method",
    "GET",
    "--raw-field",
    "state=closed",
    "--raw-field",
    "sort=updated",
    "--raw-field",
    "direction=desc",
    "--raw-field",
    `per_page=${perPage}`,
    "--raw-field",
    `page=${page}`,
  ];
  const result = runner(args, { whichFn: seams.whichFn });
  if (result.returncode !== 0) {
    throw new GhRestError({
      stderr: result.stderr.trim(),
      exitCode: result.returncode,
      endpoint,
      payload: null,
      hint: "verify repo and core REST bucket quota for closed-issue walk",
      binary: result.binary ?? "gh",
    });
  }
  const stdout = result.stdout.trim();
  if (stdout.length === 0) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch (exc: unknown) {
    const message = exc instanceof Error ? exc.message : String(exc);
    throw new GhRestError({
      stderr: `non-JSON closed-issue page: ${message}`,
      exitCode: 0,
      endpoint,
      payload: null,
      hint: "closed-issue walk expects a JSON array page",
    });
  }
  if (!Array.isArray(parsed)) {
    throw new GhRestError({
      stderr: `unexpected top-level type ${typeof parsed}`,
      exitCode: 0,
      endpoint,
      payload: null,
      hint: "closed-issue walk expects a JSON array page",
    });
  }
  return parsed as Record<string, unknown>[];
}

/**
 * Closed-issue sibling of `restWalkClosedPullsUpdatedDesc` for feedback:file dedup (#5099).
 * Retained-count window; pull rows consume raw budget but are excluded from match/count.
 */
export function walkClosedIssuesForFeedbackDedup(
  repo: string,
  title: string,
  options: RestClosedIssueWalkOptions = {},
  seams: GhRestSeams = {},
): ClosedIssueWalkResult {
  const needle = normalizeForDedup(title);
  if (needle.length === 0) {
    return {
      outcome: "list-exhausted",
      inspectedIssueCount: 0,
      rawRows: 0,
      match: null,
      malformedMatch: false,
    };
  }
  const window = Math.max(1, options.window ?? FEEDBACK_CLOSED_DEDUP_WINDOW);
  const cappedPerPage = Math.min(
    Math.max(1, options.perPage ?? REST_MAX_PER_PAGE),
    REST_MAX_PER_PAGE,
  );
  const budget = Math.max(0, options.remainingBudget ?? REST_SHARED_ROW_BUDGET);
  let rawRows = 0;
  let inspectedIssueCount = 0;

  try {
    for (let page = 1; page <= REST_PAGINATION_MAX_PAGES; page += 1) {
      if (rawRows >= budget) {
        return {
          outcome: "cap",
          inspectedIssueCount,
          rawRows,
          match: null,
          malformedMatch: false,
        };
      }

      const pagePayload = fetchClosedIssuePage(repo, page, cappedPerPage, seams);
      if (pagePayload.length === 0) {
        return {
          outcome: "list-exhausted",
          inspectedIssueCount,
          rawRows,
          match: null,
          malformedMatch: false,
        };
      }

      for (const item of pagePayload) {
        if (rawRows >= budget) {
          return {
            outcome: "cap",
            inspectedIssueCount,
            rawRows,
            match: null,
            malformedMatch: false,
          };
        }
        rawRows += 1;

        if ("pull_request" in item) {
          continue;
        }

        inspectedIssueCount += 1;
        const matched = matchTitleRow(item, needle);
        if (matched === "malformed") {
          return {
            outcome: "error",
            inspectedIssueCount,
            rawRows,
            match: null,
            malformedMatch: true,
            errorMessage: "closed-issue title match lacks usable numeric number/state/url",
          };
        }
        if (matched !== null) {
          return {
            outcome: "list-exhausted",
            inspectedIssueCount,
            rawRows,
            match: matched,
            malformedMatch: false,
          };
        }

        if (inspectedIssueCount >= window) {
          return {
            outcome: "window-exhausted",
            inspectedIssueCount,
            rawRows,
            match: null,
            malformedMatch: false,
          };
        }
      }

      if (pagePayload.length < cappedPerPage) {
        return {
          outcome: "list-exhausted",
          inspectedIssueCount,
          rawRows,
          match: null,
          malformedMatch: false,
        };
      }
    }

    return {
      outcome: "cap",
      inspectedIssueCount,
      rawRows,
      match: null,
      malformedMatch: false,
    };
  } catch (err: unknown) {
    const detail = err instanceof GhRestError ? err.message : String(err);
    return {
      outcome: "error",
      inspectedIssueCount,
      rawRows,
      match: null,
      malformedMatch: false,
      errorMessage: detail,
    };
  }
}

/** Search open upstream issues (complete inventory) for a normalized title match. */
export function findDuplicateIssue(
  repo: string,
  title: string,
  seams: GhRestSeams = {},
): DuplicateMatch | null {
  const needle = normalizeForDedup(title);
  if (needle.length === 0) {
    return null;
  }
  const issues = restIssueListOpenInventory(repo, seams);
  for (const issue of issues) {
    const matched = matchTitleRow(issue, needle);
    if (matched === "malformed") {
      throw new GhRestError({
        stderr: "open-issue title match lacks usable numeric number/state/url",
        exitCode: 0,
        endpoint: `repos/${repo}/issues`,
        payload: null,
        hint: "DuplicateMatch requires number+state+url from the REST list row",
      });
    }
    if (matched !== null) {
      return matched;
    }
  }
  return null;
}

function resolveRepo(options: FeedbackFileOptions): string {
  const explicit = options.repo?.trim();
  return explicit && explicit.length > 0 ? explicit : DEFAULT_UPSTREAM_REPO;
}

function isOffline(): boolean {
  return process.env.DEFT_NO_NETWORK === "1";
}

function networkErrorMessage(prefix: string, err: unknown): string {
  const detail = err instanceof GhRestError ? err.message : String(err);
  return `[deft feedback] ${prefix}: ${detail}\n`;
}

function buildConfirmationPrompt(title: string, body: string): string {
  return (
    "Draft framework-gap issue (not filed yet):\n\n" +
    `Title: ${title}\n\n` +
    `${body}\n` +
    "Re-run with --confirm to file this issue upstream after reviewing the draft.\n"
  );
}

function buildOpenMatchPreview(match: DuplicateMatch, commentBody: string): string {
  return (
    `[deft feedback] Open duplicate: ${match.url} ("${match.title}").\n` +
    "Proposed evidence comment (not posted):\n\n" +
    `${commentBody}\n` +
    "Re-run with --confirm to append this evidence as a comment (never creates a new issue).\n"
  );
}

function buildClosedMatchBlock(match: DuplicateMatch): string {
  return (
    `[deft feedback] Closed duplicate: ${match.url} ("${match.title}").\n` +
    "Re-run with an explicit disposition before any write:\n" +
    "  --on-closed=comment        append evidence on the closed issue (no reopen)\n" +
    "  --on-closed=create-anyway  create a new issue with Related: closed #<n>\n"
  );
}

function incompleteClosedSearchNote(
  stopReason: "window-exhausted" | "cap",
  inspectedIssueCount: number,
  boundary: number,
): string {
  if (stopReason === "window-exhausted") {
    return (
      `[deft feedback] Note: closed-issue search incomplete ` +
      `(stopReason=window-exhausted, inspectedIssueCount=${inspectedIssueCount}, window=${boundary}).\n`
    );
  }
  return (
    `[deft feedback] Note: closed-issue search incomplete ` +
    `(stopReason=cap, inspectedIssueCount=${inspectedIssueCount}, budget=${boundary}).\n`
  );
}

function extractCommentUrl(
  repo: string,
  issueNumber: number,
  created: Record<string, unknown>,
): string | null {
  if (typeof created.html_url === "string" && created.html_url.length > 0) {
    return created.html_url;
  }
  const id = created.id;
  if (typeof id === "number" && Number.isFinite(id)) {
    return `https://github.com/${repo}/issues/${issueNumber}#issuecomment-${id}`;
  }
  return null;
}

function mutationsAllowed(
  options: FeedbackFileOptions,
  offline: boolean,
  dryRun: boolean,
): boolean {
  return options.confirm === true && !dryRun && !offline;
}

/** Core feedback:file workflow (#1709 / #5099 Prefer-A Recut-2). */
export function runFeedbackFile(options: FeedbackFileOptions): FeedbackFileResult {
  const summary = sanitizeOneLine(options.summary);
  if (summary.length === 0) {
    return {
      outcome: "error-bad-args",
      exitCode: 2,
      title: "",
      body: "",
      repo: resolveRepo(options),
      message: "Error: summary is required (pass --summary or a positional argument).\n",
    };
  }

  const projectRootRaw = resolveProjectRoot(options.projectRoot ?? undefined);
  if (projectRootRaw === null) {
    return {
      outcome: "error-config",
      exitCode: 2,
      title: buildFrameworkGapTitle(summary),
      body: buildFrameworkGapBody(options),
      repo: resolveRepo(options),
      message:
        "Error: could not resolve project root. Pass --project-root or run from a directive consumer repo.\n",
    };
  }
  const projectRoot = resolve(projectRootRaw);

  const repo = resolveRepo(options);
  const title = buildFrameworkGapTitle(summary, { adoptionBlocker: options.adoptionBlocker });
  const issueBody = buildFrameworkGapBody(options);
  const commentBody = buildFrameworkGapBody(options, { mode: "comment" });

  if (isMaintainerFrameworkRepo(projectRoot)) {
    return {
      outcome: "skipped-maintainer",
      exitCode: 0,
      title,
      body: issueBody,
      repo,
      message:
        "[deft feedback] Skipped: maintainer framework repo detected; gap escalation targets consumer projects only.\n",
    };
  }

  const policy = resolveValueFeedback(projectRoot);
  if (!isValueFeedbackPathAllowed("upstreamPrompt", policy)) {
    const readout =
      options.dryRun === true || options.json === true
        ? `${buildConfirmationPrompt(title, issueBody)}\n`
        : "";
    return {
      outcome: "blocked-policy",
      exitCode: 1,
      title,
      body: issueBody,
      repo,
      message:
        "[deft feedback] Blocked: plan.policy.valueFeedback upstreamPrompt is OFF. " +
        `Enable with \`${policyColonInvocation("enable-value-feedback", " -- --confirm --upstream-prompt")}\`, ` +
        `or inspect via \`${policyColonInvocation("show", " --field=valueFeedback")}\`.\n` +
        readout,
    };
  }

  const offline = isOffline();
  const dryRun = options.dryRun ?? false;
  const seams = options.seams ?? {};
  let dedupSkippedNote = "";
  let incompleteNote = "";
  let createBody = issueBody;

  if (!offline) {
    try {
      const openMatch = findDuplicateIssue(repo, title, seams);
      if (openMatch !== null) {
        if (!options.confirm) {
          return {
            outcome: "draft",
            exitCode: 1,
            title,
            body: commentBody,
            repo,
            duplicateUrl: openMatch.url,
            issueUrl: openMatch.url,
            message: buildOpenMatchPreview(openMatch, commentBody),
          };
        }
        if (!mutationsAllowed(options, offline, dryRun)) {
          return {
            outcome: "draft",
            exitCode: 0,
            title,
            body: commentBody,
            repo,
            duplicateUrl: openMatch.url,
            issueUrl: openMatch.url,
            message:
              `[deft feedback] Dry run: would comment on open duplicate ${openMatch.url}.\n` +
              `${buildOpenMatchPreview(openMatch, commentBody)}`,
          };
        }
        try {
          const created = restPostComment(repo, openMatch.number, commentBody, seams);
          const commentUrl = extractCommentUrl(repo, openMatch.number, created);
          return {
            outcome: "commented-open-duplicate",
            exitCode: 0,
            title,
            body: commentBody,
            repo,
            issueUrl: openMatch.url,
            duplicateUrl: openMatch.url,
            commentUrl,
            message:
              commentUrl !== null
                ? `[deft feedback] Commented on open duplicate ${openMatch.url}\nComment: ${commentUrl}\n`
                : `[deft feedback] Commented on open duplicate ${openMatch.url}\n`,
          };
        } catch (err: unknown) {
          return {
            outcome: "error-network",
            exitCode: 2,
            title,
            body: commentBody,
            repo,
            duplicateUrl: openMatch.url,
            message: networkErrorMessage("Open-duplicate comment failed", err),
          };
        }
      }
    } catch (err: unknown) {
      return {
        outcome: "error-network",
        exitCode: 2,
        title,
        body: issueBody,
        repo,
        message: networkErrorMessage("Open-issue inventory / duplicate search failed", err),
      };
    }

    const closedWalk = walkClosedIssuesForFeedbackDedup(
      repo,
      title,
      {
        window: options.closedWindow,
        remainingBudget: options.closedRowBudget,
      },
      seams,
    );

    if (closedWalk.malformedMatch || closedWalk.outcome === "error") {
      return {
        outcome: "error-network",
        exitCode: 2,
        title,
        body: issueBody,
        repo,
        message: networkErrorMessage(
          "Closed-issue search failed",
          closedWalk.errorMessage ?? "closed walk error",
        ),
      };
    }

    if (closedWalk.match !== null) {
      const closedMatch = closedWalk.match;
      if (options.onClosed === undefined) {
        return {
          outcome: "blocked-closed-duplicate",
          exitCode: 1,
          title,
          body: issueBody,
          repo,
          duplicateUrl: closedMatch.url,
          issueUrl: closedMatch.url,
          message: buildClosedMatchBlock(closedMatch),
        };
      }

      if (options.onClosed === "comment") {
        if (!options.confirm) {
          return {
            outcome: "draft",
            exitCode: 1,
            title,
            body: commentBody,
            repo,
            duplicateUrl: closedMatch.url,
            issueUrl: closedMatch.url,
            message:
              buildClosedMatchBlock(closedMatch) +
              "\nProposed evidence comment (not posted):\n\n" +
              `${commentBody}\n` +
              "Re-run with --confirm --on-closed=comment to append evidence (no reopen).\n",
          };
        }
        if (!mutationsAllowed(options, offline, dryRun)) {
          return {
            outcome: "draft",
            exitCode: 0,
            title,
            body: commentBody,
            repo,
            duplicateUrl: closedMatch.url,
            issueUrl: closedMatch.url,
            message:
              `[deft feedback] Dry run: would comment on closed duplicate ${closedMatch.url} (no reopen).\n` +
              `${commentBody}\n`,
          };
        }
        try {
          const created = restPostComment(repo, closedMatch.number, commentBody, seams);
          const commentUrl = extractCommentUrl(repo, closedMatch.number, created);
          return {
            outcome: "commented-open-duplicate",
            exitCode: 0,
            title,
            body: commentBody,
            repo,
            issueUrl: closedMatch.url,
            duplicateUrl: closedMatch.url,
            commentUrl,
            message:
              commentUrl !== null
                ? `[deft feedback] Commented on closed duplicate ${closedMatch.url} (no reopen)\nComment: ${commentUrl}\n`
                : `[deft feedback] Commented on closed duplicate ${closedMatch.url} (no reopen)\n`,
          };
        } catch (err: unknown) {
          return {
            outcome: "error-network",
            exitCode: 2,
            title,
            body: commentBody,
            repo,
            duplicateUrl: closedMatch.url,
            message: networkErrorMessage("Closed-duplicate comment failed", err),
          };
        }
      }

      createBody = buildFrameworkGapBody(options, {
        mode: "issue",
        relatedClosedNumber: closedMatch.number,
      });
    } else if (closedWalk.outcome === "window-exhausted") {
      incompleteNote = incompleteClosedSearchNote(
        "window-exhausted",
        closedWalk.inspectedIssueCount,
        options.closedWindow ?? FEEDBACK_CLOSED_DEDUP_WINDOW,
      );
    } else if (closedWalk.outcome === "cap") {
      incompleteNote = incompleteClosedSearchNote(
        "cap",
        closedWalk.inspectedIssueCount,
        options.closedRowBudget ?? REST_SHARED_ROW_BUDGET,
      );
    }
  } else {
    dedupSkippedNote = "[deft feedback] Note: duplicate detection skipped (DEFT_NO_NETWORK=1).\n\n";
  }

  if (!options.confirm) {
    return {
      outcome: "draft",
      exitCode: 1,
      title,
      body: createBody,
      repo,
      message: `${dedupSkippedNote}${incompleteNote}${buildConfirmationPrompt(title, createBody)}`,
    };
  }

  if (!mutationsAllowed(options, offline, dryRun)) {
    return {
      outcome: "draft",
      exitCode: 0,
      title,
      body: createBody,
      repo,
      message:
        `${dedupSkippedNote}${incompleteNote}[deft feedback] Dry run: would file upstream issue in ${repo}.\n` +
        `${buildConfirmationPrompt(title, createBody)}`,
    };
  }

  try {
    const created = restCreateIssue(repo, title, createBody, [], seams);
    const issueUrl =
      typeof created.html_url === "string" && created.html_url.length > 0 ? created.html_url : null;
    const number = created.number;
    const urlLine =
      issueUrl ??
      (typeof number === "number" ? `https://github.com/${repo}/issues/${number}` : null);

    return {
      outcome: "filed",
      exitCode: 0,
      title,
      body: createBody,
      repo,
      issueUrl: urlLine,
      message:
        `${incompleteNote}` +
        (urlLine !== null
          ? `[deft feedback] Filed upstream issue: ${urlLine}\n`
          : "[deft feedback] Issue filed upstream (URL unavailable in API response).\n"),
    };
  } catch (err: unknown) {
    return {
      outcome: "error-network",
      exitCode: 2,
      title,
      body: createBody,
      repo,
      message: networkErrorMessage("Upstream filing failed", err),
    };
  }
}

export interface FeedbackFileCliArgs {
  summary?: string;
  context?: string;
  expected?: string;
  actual?: string;
  sessionNotes?: string;
  adoptionBlocker?: boolean;
  flowAndVersion?: string;
  alternatives?: string;
  recoveryCost?: string;
  confirm?: boolean;
  dryRun?: boolean;
  json?: boolean;
  onClosed?: OnClosedDisposition;
  repo?: string;
  projectRoot?: string;
  error?: string;
}

/** Join repeated --context values; schema stays `context?: string` (#3454). */
const CONTEXT_JOIN = "\n";

function appendContextValue(collected: string[], value: string | undefined): void {
  if (typeof value === "string") collected.push(value);
}

function parseOnClosedValue(value: string | undefined): OnClosedDisposition | "bad" {
  if (value === "comment" || value === "create-anyway") {
    return value;
  }
  return "bad";
}

/** Parse argv for feedback:file. */
export function parseFeedbackFileArgs(argv: readonly string[]): FeedbackFileCliArgs {
  const out: FeedbackFileCliArgs = {};
  const positionals: string[] = [];
  const contextValues: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--confirm") out.confirm = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--blocker") out.adoptionBlocker = true;
    else if (arg === "--summary") {
      out.summary = argv[++i];
    } else if (arg?.startsWith("--summary=")) {
      out.summary = arg.slice("--summary=".length);
    } else if (arg === "--context") {
      appendContextValue(contextValues, argv[++i]);
    } else if (arg?.startsWith("--context=")) {
      appendContextValue(contextValues, arg.slice("--context=".length));
    } else if (arg === "--expected") {
      out.expected = argv[++i];
    } else if (arg?.startsWith("--expected=")) {
      out.expected = arg.slice("--expected=".length);
    } else if (arg === "--actual") {
      out.actual = argv[++i];
    } else if (arg?.startsWith("--actual=")) {
      out.actual = arg.slice("--actual=".length);
    } else if (arg === "--notes" || arg === "--session-notes") {
      out.sessionNotes = argv[++i];
    } else if (arg?.startsWith("--notes=")) {
      out.sessionNotes = arg.slice("--notes=".length);
    } else if (arg?.startsWith("--session-notes=")) {
      out.sessionNotes = arg.slice("--session-notes=".length);
    } else if (arg === "--flow" || arg === "--flow-and-version") {
      out.flowAndVersion = argv[++i];
    } else if (arg?.startsWith("--flow=")) {
      out.flowAndVersion = arg.slice("--flow=".length);
    } else if (arg?.startsWith("--flow-and-version=")) {
      out.flowAndVersion = arg.slice("--flow-and-version=".length);
    } else if (arg === "--alternatives") {
      out.alternatives = argv[++i];
    } else if (arg?.startsWith("--alternatives=")) {
      out.alternatives = arg.slice("--alternatives=".length);
    } else if (arg === "--recovery-cost") {
      out.recoveryCost = argv[++i];
    } else if (arg?.startsWith("--recovery-cost=")) {
      out.recoveryCost = arg.slice("--recovery-cost=".length);
    } else if (arg === "--on-closed") {
      const parsed = parseOnClosedValue(argv[++i]);
      if (parsed === "bad") {
        return { ...out, error: "invalid --on-closed value (expected comment|create-anyway)" };
      }
      out.onClosed = parsed;
    } else if (arg?.startsWith("--on-closed=")) {
      const parsed = parseOnClosedValue(arg.slice("--on-closed=".length));
      if (parsed === "bad") {
        return { ...out, error: "invalid --on-closed value (expected comment|create-anyway)" };
      }
      out.onClosed = parsed;
    } else if (arg === "--repo") {
      out.repo = argv[++i];
    } else if (arg?.startsWith("--repo=")) {
      out.repo = arg.slice("--repo=".length);
    } else if (arg === "--project-root") {
      out.projectRoot = argv[++i];
    } else if (arg?.startsWith("--project-root=")) {
      out.projectRoot = arg.slice("--project-root=".length);
    } else if (arg.startsWith("-")) {
      return { ...out, error: `unrecognized argument: ${arg}` };
    } else {
      positionals.push(arg);
    }
  }
  if ((out.summary === undefined || out.summary.trim().length === 0) && positionals.length > 0) {
    out.summary = positionals.join(" ");
  }
  if (contextValues.length > 0) {
    out.context = contextValues.join(CONTEXT_JOIN);
  }
  return out;
}

/** CLI entry for feedback:file. */
export function feedbackFileMain(argv: readonly string[]): number {
  const args = parseFeedbackFileArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`feedback:file: ${args.error}\n`);
    return 2;
  }

  const result = runFeedbackFile({
    summary: args.summary ?? "",
    context: args.context,
    expected: args.expected,
    actual: args.actual,
    sessionNotes: args.sessionNotes,
    adoptionBlocker: args.adoptionBlocker,
    flowAndVersion: args.flowAndVersion,
    alternatives: args.alternatives,
    recoveryCost: args.recoveryCost,
    confirm: args.confirm,
    dryRun: args.dryRun,
    json: args.json,
    onClosed: args.onClosed,
    repo: args.repo,
    projectRoot: args.projectRoot,
  });

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          outcome: result.outcome,
          exit_code: result.exitCode,
          title: result.title,
          body: result.body,
          repo: result.repo,
          issue_url: result.issueUrl ?? null,
          comment_url: result.commentUrl ?? null,
          duplicate_url: result.duplicateUrl ?? null,
          message: result.message.trim(),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(result.message);
  }

  return result.exitCode;
}

/** CLI module entrypoint for dispatch (#1709). */
export function mainEntry(argv: string[] = process.argv.slice(2)): number {
  return feedbackFileMain(argv);
}

/** Convenience probe used in tests for project-root sentinel presence. */
export function projectRootLooksLikeConsumer(projectRoot: string): boolean {
  const root = resolve(projectRoot);
  return (
    existsSync(resolve(root, "xbrief")) ||
    existsSync(resolve(root, "vbrief")) ||
    existsSync(resolve(root, ".deft"))
  );
}
