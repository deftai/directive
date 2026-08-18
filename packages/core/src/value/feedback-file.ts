import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { isFrameworkRepoRoot } from "../check/orchestrator.js";
import { policyColonInvocation } from "../policy/policy-invocation.js";
import { isValueFeedbackPathAllowed, resolveValueFeedback } from "../policy/value-feedback.js";
import {
  GhRestError,
  type GhRestSeams,
  restCreateIssue,
  restIssueListPaginated,
} from "../scm/gh-rest.js";
import { resolveProjectRoot } from "../scope/project-context.js";

export const DEFAULT_UPSTREAM_REPO = "deftai/directive";
export const FRAMEWORK_GAP_TITLE_PREFIX = "[framework-gap]";

export type FeedbackFileOutcome =
  | "draft"
  | "filed"
  | "skipped-maintainer"
  | "blocked-policy"
  | "blocked-duplicate"
  | "blocked-no-confirm"
  | "error-bad-args"
  | "error-config"
  | "error-network";

export interface FeedbackGapInput {
  readonly summary: string;
  readonly context?: string;
  readonly expected?: string;
  readonly actual?: string;
  readonly sessionNotes?: string;
}

export interface FeedbackFileOptions extends FeedbackGapInput {
  readonly projectRoot?: string | null;
  readonly repo?: string;
  readonly confirm?: boolean;
  readonly dryRun?: boolean;
  readonly json?: boolean;
  readonly seams?: GhRestSeams;
}

export interface FeedbackFileResult {
  readonly outcome: FeedbackFileOutcome;
  readonly exitCode: 0 | 1 | 2;
  readonly title: string;
  readonly body: string;
  readonly repo: string;
  readonly issueUrl?: string | null;
  readonly duplicateUrl?: string | null;
  readonly message: string;
}

function sanitizeOneLine(value: string): string {
  return value.replace(/\r?\n/g, " ").trim();
}

function sectionOrPlaceholder(value: string | undefined, placeholder: string): string {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : placeholder;
}

/** True when the resolved project root is the directive maintainer source checkout. */
export function isMaintainerFrameworkRepo(projectRoot: string): boolean {
  return isFrameworkRepoRoot(resolve(projectRoot));
}

/** Normalize a title for duplicate comparison (#1709). */
export function normalizeForDedup(title: string): string {
  return title
    .trim()
    .replace(/^\[framework-gap\]\s*/i, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Build the upstream issue title for a framework-gap report. */
export function buildFrameworkGapTitle(summary: string): string {
  const clean = sanitizeOneLine(summary);
  if (clean.toLowerCase().startsWith(FRAMEWORK_GAP_TITLE_PREFIX.toLowerCase())) {
    return clean;
  }
  return `${FRAMEWORK_GAP_TITLE_PREFIX} ${clean}`;
}

/** Build the structured framework-gap issue body. */
export function buildFrameworkGapBody(input: FeedbackGapInput): string {
  const summary = sanitizeOneLine(input.summary);
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
    "---",
    "_Filed via `task feedback:file` from a directive consumer project (Refs #1709 value-feedback gap escalation)._",
    "",
  ];
  return lines.join("\n");
}

export interface DuplicateMatch {
  readonly url: string;
  readonly title: string;
}

/** Search open upstream issues for a normalized title match. */
export function findDuplicateIssue(
  repo: string,
  title: string,
  seams: GhRestSeams = {},
): DuplicateMatch | null {
  const needle = normalizeForDedup(title);
  if (needle.length === 0) {
    return null;
  }
  const issues = restIssueListPaginated(
    repo,
    { state: "open", limit: 100, excludePulls: true },
    seams,
  );
  for (const issue of issues) {
    const issueTitle = typeof issue.title === "string" ? issue.title : "";
    if (normalizeForDedup(issueTitle) === needle) {
      const url = typeof issue.html_url === "string" ? issue.html_url : "";
      if (url.length > 0) {
        return { url, title: issueTitle };
      }
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

/** Core feedback:file workflow (#1709 gap escalation). */
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
  const title = buildFrameworkGapTitle(summary);
  const body = buildFrameworkGapBody(options);

  if (isMaintainerFrameworkRepo(projectRoot)) {
    return {
      outcome: "skipped-maintainer",
      exitCode: 0,
      title,
      body,
      repo,
      message:
        "[deft feedback] Skipped: maintainer framework repo detected; gap escalation targets consumer projects only.\n",
    };
  }

  const policy = resolveValueFeedback(projectRoot);
  if (!isValueFeedbackPathAllowed("upstreamPrompt", policy)) {
    return {
      outcome: "blocked-policy",
      exitCode: 1,
      title,
      body,
      repo,
      message:
        "[deft feedback] Blocked: plan.policy.valueFeedback upstreamPrompt is OFF. " +
        `Enable with \`${policyColonInvocation("enable-value-feedback", " -- --confirm")}\` and set upstreamPrompt, ` +
        `or inspect via \`${policyColonInvocation("show", " --field=valueFeedback")}\`.\n`,
    };
  }

  const offline = isOffline();
  const dryRun = options.dryRun ?? false;
  const seams = options.seams ?? {};
  let dedupSkippedNote = "";

  if (!offline) {
    try {
      const duplicate = findDuplicateIssue(repo, title, seams);
      if (duplicate !== null) {
        return {
          outcome: "blocked-duplicate",
          exitCode: 1,
          title,
          body,
          repo,
          duplicateUrl: duplicate.url,
          message:
            `[deft feedback] Duplicate detected: open issue ${duplicate.url} ` +
            `("${duplicate.title}") matches this report.\n`,
        };
      }
    } catch (err: unknown) {
      return {
        outcome: "error-network",
        exitCode: 2,
        title,
        body,
        repo,
        message: networkErrorMessage("Duplicate search failed", err),
      };
    }
  } else {
    dedupSkippedNote = "[deft feedback] Note: duplicate detection skipped (DEFT_NO_NETWORK=1).\n\n";
  }

  if (!options.confirm) {
    return {
      outcome: "draft",
      exitCode: 1,
      title,
      body,
      repo,
      message: `${dedupSkippedNote}${buildConfirmationPrompt(title, body)}`,
    };
  }

  if (dryRun || offline) {
    return {
      outcome: "draft",
      exitCode: 0,
      title,
      body,
      repo,
      message:
        `${dedupSkippedNote}[deft feedback] Dry run: would file upstream issue in ${repo}.\n` +
        `${buildConfirmationPrompt(title, body)}`,
    };
  }

  try {
    const created = restCreateIssue(repo, title, body, [], seams);
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
      body,
      repo,
      issueUrl: urlLine,
      message:
        urlLine !== null
          ? `[deft feedback] Filed upstream issue: ${urlLine}\n`
          : "[deft feedback] Issue filed upstream (URL unavailable in API response).\n",
    };
  } catch (err: unknown) {
    return {
      outcome: "error-network",
      exitCode: 2,
      title,
      body,
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
  confirm?: boolean;
  dryRun?: boolean;
  json?: boolean;
  repo?: string;
  projectRoot?: string;
  error?: string;
}

/** Join repeated --context values; schema stays `context?: string` (#3454). */
const CONTEXT_JOIN = "\n";

function appendContextValue(collected: string[], value: string | undefined): void {
  if (typeof value === "string") collected.push(value);
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
    confirm: args.confirm,
    dryRun: args.dryRun,
    json: args.json,
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
