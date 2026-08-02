import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluate as evaluateBranchPolicy } from "../branch/evaluate.js";
import { extractIssueRef } from "../capacity/backfill.js";
import { resolveLifecycleRoot } from "../layout/resolve.js";
import { resolveDeliveryBranch } from "../policy/delivery-branch.js";
import { defaultRunGh, fetchClosingIssuesReferences } from "../pr-protected-issues/gh.js";
import type { RunGhFn } from "../pr-protected-issues/types.js";
import {
  classifyStoredDeliveryDisposition,
  type DeliveryEvidenceInput,
  evidenceFromPrPayload,
  verifyDeliveryAncestry,
} from "../scope/delivery-evidence.js";
import type { GitRunner } from "../session/git.js";
import { completeCohort, type SweepResult } from "./complete-cohort.js";
import { EXIT_CONFIG_ERROR, EXIT_GATE_FAILED, EXIT_OK } from "./constants.js";
import { completedBriefReferencesIssue, resolveStories } from "./launch.js";
import { runText } from "./subprocess.js";

export interface FinalizeCohortResult {
  readonly project_root: string;
  readonly dry_run: boolean;
  readonly no_commit: boolean;
  readonly pr_numbers: readonly number[];
  readonly story_paths: readonly string[];
  readonly closing_issues: readonly number[];
  readonly sweep: SweepResult | null;
  readonly commit_sha: string | null;
  readonly branch: string | null;
  readonly pr_url: string | null;
  readonly delivery_branch: string | null;
  readonly delivery_errors: readonly string[];
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly ok: boolean;
}

export interface FinalizeCohortArgs {
  readonly prNumbers?: readonly number[];
  readonly storyTokens?: readonly string[];
  readonly repo?: string | null;
  readonly projectRoot?: string;
  /**
   * Swarm/PR base for the post-merge lifecycle sweep PR only.
   * Distinct from plan.policy.deliveryBranch (#3041).
   */
  readonly baseBranch?: string;
  /** Override delivery branch for this run (defaults to policy/git default). */
  readonly deliveryBranch?: string | null;
  readonly label?: string | null;
  readonly dryRun?: boolean;
  readonly noCommit?: boolean;
  readonly noOpenPr?: boolean;
  readonly emitJson?: boolean;
  readonly runGh?: RunGhFn;
  readonly runGit?: typeof runText;
}

function splitCsv(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    for (const piece of value.split(",")) {
      const trimmed = piece.trim();
      if (trimmed.length > 0) {
        out.push(trimmed);
      }
    }
  }
  return out;
}

function safeSegment(text: string): string {
  let cleaned = "";
  for (const ch of text.trim()) {
    if (
      (ch >= "A" && ch <= "Z") ||
      (ch >= "a" && ch <= "z") ||
      (ch >= "0" && ch <= "9") ||
      ch === "." ||
      ch === "_" ||
      ch === "-"
    ) {
      cleaned += ch;
    } else {
      cleaned += "-";
    }
  }
  let start = 0;
  let end = cleaned.length;
  while (start < end && (cleaned[start] === "-" || cleaned[start] === ".")) {
    start += 1;
  }
  while (end > start && (cleaned[end - 1] === "-" || cleaned[end - 1] === ".")) {
    end -= 1;
  }
  cleaned = cleaned.slice(start, end);
  return cleaned.length > 0 ? cleaned : "cohort";
}

function oneLine(text: string): string {
  return text.replace(/\r?\n/g, " ");
}

function parseRepo(repo: string): { owner: string; name: string } | null {
  const slash = repo.indexOf("/");
  if (slash <= 0 || slash >= repo.length - 1) {
    return null;
  }
  return { owner: repo.slice(0, slash), name: repo.slice(slash + 1) };
}

interface PrDeliverySnapshot {
  readonly mergedAt: string;
  readonly prBase: string | null;
  readonly mergeCommitSha: string | null;
  readonly payload: Record<string, unknown>;
  readonly evidence: DeliveryEvidenceInput;
}

function fetchPrDeliverySnapshot(
  prNumber: number,
  repo: string,
  deliveryBranch: string,
  runGh: RunGhFn,
): { snapshot: PrDeliverySnapshot | null; error: string | null } {
  const parsed = parseRepo(repo);
  if (parsed === null) {
    return { snapshot: null, error: `invalid --repo value: ${JSON.stringify(repo)}` };
  }
  const path = `repos/${parsed.owner}/${parsed.name}/pulls/${prNumber}`;
  const result = runGh(["gh", "api", path]);
  if (result.returncode !== 0) {
    return {
      snapshot: null,
      error: `gh api ${path} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    };
  }
  try {
    const body = JSON.parse(result.stdout) as unknown;
    if (body === null || typeof body !== "object") {
      return {
        snapshot: null,
        error: `unexpected gh api response for PR #${prNumber}: not a JSON object`,
      };
    }
    const payload = body as Record<string, unknown>;
    const mergedAt = payload.merged_at;
    if (mergedAt === null || typeof mergedAt !== "string" || mergedAt.length === 0) {
      return { snapshot: null, error: `PR #${prNumber} is not merged yet.` };
    }
    const base = payload.base;
    const prBase =
      typeof base === "object" &&
      base !== null &&
      !Array.isArray(base) &&
      typeof (base as Record<string, unknown>).ref === "string"
        ? String((base as Record<string, unknown>).ref)
        : null;
    const mergeCommitSha =
      typeof payload.merge_commit_sha === "string" && payload.merge_commit_sha.length > 0
        ? payload.merge_commit_sha
        : null;
    const evidence = evidenceFromPrPayload(payload, prNumber, repo, deliveryBranch);
    return {
      snapshot: {
        mergedAt,
        prBase,
        mergeCommitSha,
        payload,
        evidence,
      },
      error: null,
    };
  } catch (exc: unknown) {
    const message = exc instanceof Error ? exc.message : String(exc);
    return {
      snapshot: null,
      error: `failed to parse gh api response for PR #${prNumber}: ${message}`,
    };
  }
}

/** Adapt swarm runText to the session GitRunner shape used by delivery-evidence. */
function asGitRunner(runGit: typeof runText): GitRunner {
  return (projectRoot, args) => {
    const result = runGit(["git", ...args], { cwd: projectRoot });
    return {
      code: result.returncode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };
}

function fetchClosingIssues(
  prNumber: number,
  repo: string,
  runGh: RunGhFn,
): { issues: number[]; error: string | null } {
  const parsed = parseRepo(repo);
  if (parsed === null) {
    return { issues: [], error: `invalid --repo value: ${JSON.stringify(repo)}` };
  }
  const linked = fetchClosingIssuesReferences(prNumber, repo, runGh);
  if (linked === null) {
    return {
      issues: [],
      error: `failed to fetch closing issue references for PR #${prNumber}`,
    };
  }
  return { issues: [...new Set(linked)].sort((a, b) => a - b), error: null };
}

/**
 * Read an issue's open/closed state via the scm shim (`gh api .../issues/<N>`).
 * Returns true only when the live state is definitively "closed". Any lookup
 * failure (no repo, gh error, unparseable payload) returns false so a genuine
 * misconfig is surfaced rather than silently swallowed as a benign skip (#2247).
 */
function fetchIssueClosed(issue: number, repo: string | null, runGh: RunGhFn): boolean {
  if (repo === null || repo.length === 0) {
    return false;
  }
  const parsed = parseRepo(repo);
  if (parsed === null) {
    return false;
  }
  const path = `repos/${parsed.owner}/${parsed.name}/issues/${issue}`;
  const result = runGh(["gh", "api", path]);
  if (result.returncode !== 0) {
    return false;
  }
  try {
    const payload = JSON.parse(result.stdout) as unknown;
    if (payload === null || typeof payload !== "object") {
      return false;
    }
    return (payload as Record<string, unknown>).state === "closed";
  } catch {
    return false;
  }
}

function deriveLabel(
  label: string | null | undefined,
  prNumbers: readonly number[],
  storyTokens: readonly string[],
): string {
  if (label !== null && label !== undefined && label.trim().length > 0) {
    return safeSegment(label);
  }
  if (prNumbers.length > 0) {
    return safeSegment(`pr-${prNumbers.join("-")}`);
  }
  if (storyTokens.length > 0) {
    return safeSegment(storyTokens.slice(0, 3).join("-"));
  }
  return "cohort";
}

function storySlugs(storyPaths: readonly string[]): string {
  return storyPaths
    .map((p) => {
      const name = p.split(/[/\\]/).pop() ?? p;
      return name.replace(/\.(xbrief|vbrief)\.json$/i, "");
    })
    .join(", ");
}

function syncBaseBranch(
  projectRoot: string,
  baseBranch: string,
  runGit: typeof runText,
): { ok: boolean; error: string | null } {
  const fetch = runGit(["git", "fetch", "origin", baseBranch], { cwd: projectRoot });
  if (fetch.returncode !== 0) {
    return {
      ok: false,
      error: `git fetch origin ${baseBranch} failed: ${fetch.stderr.trim() || fetch.stdout.trim()}`,
    };
  }
  const merge = runGit(["git", "merge", "--ff-only", `origin/${baseBranch}`], { cwd: projectRoot });
  if (merge.returncode !== 0) {
    return {
      ok: false,
      error:
        `git merge --ff-only origin/${baseBranch} failed: ` +
        `${merge.stderr.trim() || merge.stdout.trim()}`,
    };
  }
  return { ok: true, error: null };
}

function ensureFeatureBranch(
  projectRoot: string,
  branchName: string,
  runGit: typeof runText,
): { ok: boolean; error: string | null; branch: string | null } {
  const branchCheck = evaluateBranchPolicy(projectRoot);
  if (branchCheck.exitCode === 1) {
    const create = runGit(["git", "switch", "-c", branchName], { cwd: projectRoot });
    if (create.returncode !== 0) {
      return {
        ok: false,
        error: `git switch -c ${branchName} failed: ${create.stderr.trim()}`,
        branch: null,
      };
    }
    return { ok: true, error: null, branch: branchName };
  }
  if (branchCheck.exitCode === 2) {
    return { ok: false, error: branchCheck.message, branch: null };
  }
  const current = runGit(["git", "symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd: projectRoot,
  });
  const currentBranch = current.stdout.trim();
  if (current.returncode !== 0 || currentBranch.length === 0) {
    const create = runGit(["git", "switch", "-c", branchName], { cwd: projectRoot });
    if (create.returncode !== 0) {
      return {
        ok: false,
        error: `git switch -c ${branchName} failed: ${create.stderr.trim()}`,
        branch: null,
      };
    }
    return { ok: true, error: null, branch: branchName };
  }
  return { ok: true, error: null, branch: currentBranch };
}

function commitLifecycleMoves(
  projectRoot: string,
  storyPaths: readonly string[],
  runGit: typeof runText,
): { ok: boolean; error: string | null; sha: string | null } {
  const branchCheck = evaluateBranchPolicy(projectRoot);
  if (branchCheck.exitCode !== 0) {
    return { ok: false, error: branchCheck.message, sha: null };
  }

  const add = runGit(["git", "add", "-A", "xbrief/"], { cwd: projectRoot });
  if (add.returncode !== 0) {
    return { ok: false, error: `git add failed: ${add.stderr.trim()}`, sha: null };
  }

  const slugs = storySlugs(storyPaths);
  const subject = `chore(xbrief): complete ${slugs} post-merge`;
  const commit = runGit(["git", "commit", "-m", subject], { cwd: projectRoot });
  if (commit.returncode !== 0) {
    const status = runGit(["git", "status", "--short"], { cwd: projectRoot });
    if (status.stdout.trim().length === 0) {
      return { ok: true, error: null, sha: null };
    }
    return { ok: false, error: `git commit failed: ${commit.stderr.trim()}`, sha: null };
  }

  const rev = runGit(["git", "rev-parse", "HEAD"], { cwd: projectRoot });
  return {
    ok: true,
    error: null,
    sha: rev.returncode === 0 ? rev.stdout.trim() : null,
  };
}

function pushAndOpenPr(
  projectRoot: string,
  branch: string,
  repo: string,
  baseBranch: string,
  storyPaths: readonly string[],
  prNumbers: readonly number[],
  runGit: typeof runText,
  runGh: RunGhFn,
): { ok: boolean; error: string | null; prUrl: string | null } {
  const push = runGit(["git", "push", "-u", "origin", branch], { cwd: projectRoot });
  if (push.returncode !== 0) {
    return {
      ok: false,
      error: `git push failed: ${push.stderr.trim() || push.stdout.trim()}`,
      prUrl: null,
    };
  }

  const slugs = storySlugs(storyPaths);
  const prList = prNumbers.length > 0 ? prNumbers.map((n) => `#${n}`).join(", ") : "cohort";
  const title = `chore(xbrief): complete ${slugs} post-merge`;
  const body =
    `## Summary\n` +
    `Automated cohort lifecycle sweep after merge cascade (${prList}).\n\n` +
    `## Test plan\n` +
    `- [x] \`task xbrief:validate\` green\n` +
    `- [x] WIP reset via active/ -> completed/ moves\n`;

  const create = runGh([
    "gh",
    "pr",
    "create",
    "--repo",
    repo,
    "--base",
    baseBranch,
    "--head",
    branch,
    "--title",
    title,
    "--body",
    body,
  ]);
  if (create.returncode !== 0) {
    return {
      ok: false,
      error: `gh pr create failed: ${create.stderr.trim()}`,
      prUrl: null,
    };
  }
  return { ok: true, error: null, prUrl: create.stdout.trim() };
}

export function finalizeCohort(args: FinalizeCohortArgs): {
  exitCode: number;
  stdout: string;
  stderr: string;
  result: FinalizeCohortResult;
} {
  const projectRoot = resolve(args.projectRoot ?? process.cwd());
  const runGh = args.runGh ?? defaultRunGh;
  const runGit = args.runGit ?? runText;
  const gitRunner = asGitRunner(runGit);
  const prNumbers = [...(args.prNumbers ?? [])].sort((a, b) => a - b);
  const storyTokens = splitCsv(args.storyTokens ?? []);
  const repo = args.repo ?? process.env.GH_REPO ?? null;
  // baseBranch is for the lifecycle sweep PR only — not delivery proof (#3041).
  const baseBranch = args.baseBranch ?? "master";
  const dryRun = args.dryRun ?? false;
  const noCommit = args.noCommit ?? false;
  const noOpenPr = args.noOpenPr ?? false;
  const errors: string[] = [];
  const deliveryErrors: string[] = [];

  // plan.policy.deliveryBranch (or git default) is SoT. CLI may only fill when policy is
  // not typed — never redefine a typed delivery branch to an integration target (#3041).
  const policyDelivery = resolveDeliveryBranch(projectRoot, gitRunner);
  const cliDelivery =
    args.deliveryBranch !== null &&
    args.deliveryBranch !== undefined &&
    args.deliveryBranch.trim().length > 0
      ? args.deliveryBranch.trim()
      : null;
  if (cliDelivery !== null && cliDelivery !== policyDelivery.branch) {
    if (policyDelivery.source === "typed") {
      errors.push(
        `--delivery-branch '${cliDelivery}' conflicts with plan.policy.deliveryBranch ` +
          `'${policyDelivery.branch}'. Typed policy wins; do not redefine delivery via CLI (#3041).`,
      );
    }
  }
  const deliveryBranch =
    policyDelivery.source === "typed"
      ? policyDelivery.branch
      : (cliDelivery ?? policyDelivery.branch);

  if (!existsSync(projectRoot)) {
    return buildResponse({
      projectRoot,
      dryRun,
      noCommit,
      prNumbers,
      storyPaths: [],
      closingIssues: [],
      sweep: null,
      commitSha: null,
      branch: null,
      prUrl: null,
      deliveryBranch,
      deliveryErrors: [],
      errors: [`project root does not exist: ${projectRoot}`],
      warnings: [],
      ok: false,
      emitJson: args.emitJson ?? false,
      exitCode: EXIT_CONFIG_ERROR,
    });
  }

  if (!existsSync(resolveLifecycleRoot(projectRoot))) {
    return buildResponse({
      projectRoot,
      dryRun,
      noCommit,
      prNumbers,
      storyPaths: [],
      closingIssues: [],
      sweep: null,
      commitSha: null,
      branch: null,
      prUrl: null,
      deliveryBranch,
      deliveryErrors: [],
      errors: [`no xbrief/ directory under project root: ${projectRoot}`],
      warnings: [],
      ok: false,
      emitJson: args.emitJson ?? false,
      exitCode: EXIT_CONFIG_ERROR,
    });
  }

  const closingIssues = new Set<number>();
  /** Per-closing-issue delivery evidence so multi-PR cohorts do not collapse provenance (#3041). */
  const evidenceByIssue = new Map<number, DeliveryEvidenceInput>();
  const validatedPrs: number[] = [];

  if (prNumbers.length > 0 && errors.length === 0) {
    if (repo === null || repo.length === 0) {
      errors.push("--repo OWNER/REPO is required when --pr is supplied (or set $GH_REPO).");
    } else {
      for (const prNumber of prNumbers) {
        const fetched = fetchPrDeliverySnapshot(prNumber, repo, deliveryBranch, runGh);
        if (fetched.error !== null || fetched.snapshot === null) {
          errors.push(fetched.error ?? `PR #${prNumber}: delivery snapshot unavailable`);
          continue;
        }
        const snap = fetched.snapshot;

        // base.ref must equal configured deliveryBranch — integration bases fail closed (#3041).
        if (snap.prBase === null || snap.prBase.length === 0) {
          deliveryErrors.push(
            `PR #${prNumber}: missing base.ref; cannot verify delivery branch (#3041).`,
          );
          continue;
        }
        if (snap.prBase !== deliveryBranch) {
          deliveryErrors.push(
            `PR #${prNumber}: base.ref '${snap.prBase}' is not the delivery branch ` +
              `'${deliveryBranch}'. Merged-to-integration is not delivery evidence (#3041). ` +
              `(Note: --base-branch only controls the lifecycle sweep PR target, not delivery.)`,
          );
          continue;
        }
        if (snap.mergeCommitSha === null) {
          deliveryErrors.push(
            `PR #${prNumber}: missing merge_commit_sha; cannot prove delivery ancestry (#3041).`,
          );
          continue;
        }

        // Refresh remote delivery ref and require merge commit ancestry (#3041).
        const ancestry = verifyDeliveryAncestry(
          projectRoot,
          snap.mergeCommitSha,
          deliveryBranch,
          gitRunner,
        );
        if (!ancestry.ok) {
          deliveryErrors.push(`PR #${prNumber}: ${ancestry.error}`);
          continue;
        }

        validatedPrs.push(prNumber);
        const prEvidence: DeliveryEvidenceInput = {
          ...snap.evidence,
          deliveryBranch,
          deliveryCommit: ancestry.remoteTip,
          verifier: "swarm:finalize-cohort",
        };

        const closing = fetchClosingIssues(prNumber, repo, runGh);
        if (closing.error !== null) {
          errors.push(closing.error);
        }
        for (const issue of closing.issues) {
          closingIssues.add(issue);
          evidenceByIssue.set(issue, prEvidence);
        }
      }
    }
  }

  if (deliveryErrors.length > 0) {
    errors.push(...deliveryErrors);
  }

  if (storyTokens.length === 0 && closingIssues.size === 0) {
    errors.push("empty cohort: pass --pr <numbers> and/or --stories <ids|paths>.");
  }

  const warnings: string[] = [];
  const storyPaths: string[] = [];
  const seenPaths = new Set<string>();
  const addStory = (path: string): void => {
    const resolvedPath = resolve(path);
    if (!seenPaths.has(resolvedPath)) {
      seenPaths.add(resolvedPath);
      storyPaths.push(path);
    }
  };

  // Operator-supplied story tokens keep the hard-error contract: an explicit
  // --stories token that does not resolve to an active brief is a real error.
  if (storyTokens.length > 0) {
    const resolved = resolveStories(projectRoot, storyTokens);
    for (const story of resolved.resolved) {
      addStory(story.path);
    }
    errors.push(...resolved.errors);
  }

  // Closing-issue tokens are incidental (they come from a merged PR's structured
  // closing refs, not the operator). A benign ref -- one whose issue is already
  // closed OR already has a brief in completed/ -- is SKIPPED WITH A WARNING
  // rather than aborting the whole sweep. A genuine misconfig (open issue, no
  // active and no completed brief) is still surfaced as a hard error (#2247).
  for (const issue of [...closingIssues].sort((a, b) => a - b)) {
    const resolved = resolveStories(projectRoot, [String(issue)]);
    if (resolved.resolved.length > 0) {
      for (const story of resolved.resolved) {
        addStory(story.path);
      }
      continue;
    }
    const noActiveBrief = resolved.errors.some((e) => e.includes("no active story references"));
    if (!noActiveBrief) {
      // A different resolution problem (e.g. ambiguous match) is not a benign
      // incidental ref -- surface it verbatim.
      errors.push(...resolved.errors);
      continue;
    }
    const completedBrief = completedBriefReferencesIssue(projectRoot, issue);
    const issueClosed = completedBrief || fetchIssueClosed(issue, repo, runGh);
    if (completedBrief || issueClosed) {
      let dispositionNote = "";
      if (completedBrief) {
        try {
          const completedDir = resolve(projectRoot, "xbrief", "completed");
          // Best-effort surface of legacy delivery disposition for completed briefs (#3041).
          if (existsSync(completedDir)) {
            for (const name of readdirSync(completedDir)) {
              if (!name.endsWith(".json")) continue;
              const raw = JSON.parse(readFileSync(resolve(completedDir, name), "utf8")) as unknown;
              if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
              const plan = (raw as Record<string, unknown>).plan;
              if (typeof plan !== "object" || plan === null || Array.isArray(plan)) continue;
              const disposition = classifyStoredDeliveryDisposition(
                plan as Record<string, unknown>,
              );
              dispositionNote = ` deliveryDisposition=${disposition}`;
              break;
            }
          }
        } catch {
          /* best-effort disposition surfacing for legacy completed records */
        }
      }
      const reason = completedBrief
        ? `a completed brief already exists${dispositionNote}`
        : "the issue is already closed";
      warnings.push(
        `#${issue}: no active story references this closing issue; skipped (${reason}).`,
      );
    } else {
      errors.push(`#${issue}: no active story references this closing issue.`);
    }
  }

  if (storyPaths.length === 0) {
    // When every closing ref was a benign skip and no real stories remain, the
    // run is clean-with-warnings (nothing to sweep), not a config error.
    const cleanNoop = errors.length === 0 && warnings.length > 0;
    return buildResponse({
      projectRoot,
      dryRun,
      noCommit,
      prNumbers,
      storyPaths,
      closingIssues: [...closingIssues],
      sweep: null,
      commitSha: null,
      branch: null,
      prUrl: null,
      deliveryBranch,
      deliveryErrors,
      errors,
      warnings,
      ok: cleanNoop,
      emitJson: args.emitJson ?? false,
      exitCode: cleanNoop
        ? EXIT_OK
        : errors.some((e) => e.includes("not merged") || e.includes("delivery"))
          ? EXIT_GATE_FAILED
          : EXIT_CONFIG_ERROR,
    });
  }

  // When --pr was supplied, every PR must pass delivery validation before sweep (#3041).
  if (prNumbers.length > 0 && validatedPrs.length !== prNumbers.length && errors.length > 0) {
    return buildResponse({
      projectRoot,
      dryRun,
      noCommit,
      prNumbers,
      storyPaths,
      closingIssues: [...closingIssues],
      sweep: null,
      commitSha: null,
      branch: null,
      prUrl: null,
      deliveryBranch,
      deliveryErrors,
      errors,
      warnings,
      ok: false,
      emitJson: args.emitJson ?? false,
      exitCode: EXIT_GATE_FAILED,
    });
  }

  // Stories without PR-backed delivery evidence still hit the complete gate; if
  // only --stories was supplied, complete-cohort fails closed for code-bearing
  // scopes unless callers pass evidence (finalize requires --pr for delivery).
  if (prNumbers.length === 0 && evidenceByIssue.size === 0) {
    warnings.push(
      "No --pr supplied: code-bearing stories require delivery evidence or " +
        "will fail closed at scope:complete (#3041).",
    );
  }

  // Bind each story path to the evidence of its closing-issue PR (no cohort-wide collapse).
  const evidenceByPath = new Map<string, DeliveryEvidenceInput>();
  for (const storyPath of storyPaths) {
    try {
      const raw = JSON.parse(readFileSync(storyPath, "utf8")) as unknown;
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        continue;
      }
      const plan = (raw as Record<string, unknown>).plan;
      if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
        continue;
      }
      const [, issueNum] = extractIssueRef(plan as Record<string, unknown>);
      if (issueNum !== null) {
        const bound = evidenceByIssue.get(issueNum);
        if (bound !== undefined) {
          evidenceByPath.set(resolve(storyPath), bound);
        }
      }
    } catch {
      /* unreadable brief — complete gate fails closed later if code-bearing */
    }
  }
  // Single-PR cohorts: every story inherits that PR's evidence when issue binding misses
  // (operator --stories + one --pr is the common finalize path).
  let defaultEvidence: DeliveryEvidenceInput | null = null;
  if (validatedPrs.length === 1 && evidenceByIssue.size > 0) {
    defaultEvidence = evidenceByIssue.values().next().value ?? null;
  }

  let commitSha: string | null = null;
  let branch: string | null = null;
  let prUrl: string | null = null;

  if (!dryRun && !noCommit) {
    const sync = syncBaseBranch(projectRoot, baseBranch, runGit);
    if (!sync.ok) {
      errors.push(sync.error ?? "base branch sync failed");
    } else {
      const branchName = `swarm/finalize/${deriveLabel(args.label, prNumbers, storyTokens)}`;
      const branchResult = ensureFeatureBranch(projectRoot, branchName, runGit);
      if (!branchResult.ok) {
        errors.push(branchResult.error ?? "branch setup failed");
      } else {
        branch = branchResult.branch;
      }
    }
  }

  const hasDelivery = evidenceByPath.size > 0 || defaultEvidence !== null;
  const sweepResult = completeCohort({
    stories: storyPaths,
    projectRoot,
    dryRun,
    emitJson: false,
    delivery: hasDelivery
      ? {
          evidenceByPath,
          defaultEvidence,
          // Ancestry already verified above; avoid double remote fetch on each story.
          assumeEvidenceValidated: true,
          verifier: "swarm:finalize-cohort",
        }
      : null,
  });
  if (sweepResult.exitCode !== 0) {
    errors.push("cohort completion sweep failed.");
    return buildResponse({
      projectRoot,
      dryRun,
      noCommit,
      prNumbers,
      storyPaths,
      closingIssues: [...closingIssues],
      sweep: null,
      commitSha: null,
      branch: null,
      prUrl: null,
      deliveryBranch,
      deliveryErrors,
      errors,
      warnings,
      ok: false,
      emitJson: args.emitJson ?? false,
      exitCode: EXIT_GATE_FAILED,
    });
  }

  if (!dryRun && !noCommit && errors.length === 0) {
    const commitResult = commitLifecycleMoves(projectRoot, storyPaths, runGit);
    if (!commitResult.ok) {
      errors.push(commitResult.error ?? "commit failed");
    } else {
      commitSha = commitResult.sha;
      if (!noOpenPr && repo !== null && branch !== null && branch.length > 0) {
        const prResult = pushAndOpenPr(
          projectRoot,
          branch,
          repo,
          baseBranch,
          storyPaths,
          prNumbers,
          runGit,
          runGh,
        );
        if (!prResult.ok) {
          errors.push(prResult.error ?? "PR open failed");
        } else {
          prUrl = prResult.prUrl;
        }
      }
    }
  }

  const ok = errors.length === 0;
  return buildResponse({
    projectRoot,
    dryRun,
    noCommit,
    prNumbers,
    storyPaths,
    closingIssues: [...closingIssues],
    sweep: null,
    commitSha,
    branch,
    prUrl,
    deliveryBranch,
    deliveryErrors,
    errors,
    warnings,
    ok,
    emitJson: args.emitJson ?? false,
    exitCode: ok ? EXIT_OK : EXIT_GATE_FAILED,
  });
}

function buildResponse(input: {
  projectRoot: string;
  dryRun: boolean;
  noCommit: boolean;
  prNumbers: readonly number[];
  storyPaths: readonly string[];
  closingIssues: readonly number[];
  sweep: SweepResult | null;
  commitSha: string | null;
  branch: string | null;
  prUrl: string | null;
  deliveryBranch: string | null;
  deliveryErrors: readonly string[];
  errors: readonly string[];
  warnings: readonly string[];
  ok: boolean;
  emitJson: boolean;
  exitCode: number;
}): { exitCode: number; stdout: string; stderr: string; result: FinalizeCohortResult } {
  const result: FinalizeCohortResult = {
    project_root: input.projectRoot,
    dry_run: input.dryRun,
    no_commit: input.noCommit,
    pr_numbers: input.prNumbers,
    story_paths: input.storyPaths,
    closing_issues: input.closingIssues,
    sweep: input.sweep,
    commit_sha: input.commitSha,
    branch: input.branch,
    pr_url: input.prUrl,
    delivery_branch: input.deliveryBranch,
    delivery_errors: input.deliveryErrors,
    errors: input.errors,
    warnings: input.warnings,
    ok: input.ok,
  };

  if (input.emitJson) {
    return {
      exitCode: input.exitCode,
      stdout: `${JSON.stringify(result, null, 2)}\n`,
      stderr: "",
      result,
    };
  }

  const lines: string[] = [
    `Swarm cohort finalize ${input.dryRun ? "DRY-RUN" : "live"} ` +
      `(${input.storyPaths.length} stor${input.storyPaths.length === 1 ? "y" : "ies"})`,
    `  Project root: ${input.projectRoot}`,
  ];
  if (input.deliveryBranch !== null) {
    lines.push(`  Delivery branch: ${input.deliveryBranch}`);
  }
  if (input.prNumbers.length > 0) {
    lines.push(`  PRs: ${input.prNumbers.map((n) => `#${n}`).join(", ")}`);
  }
  if (input.closingIssues.length > 0) {
    lines.push(`  Closing issues: ${input.closingIssues.map((n) => `#${n}`).join(", ")}`);
  }
  if (input.storyPaths.length > 0) {
    lines.push("  Stories:");
    for (const path of input.storyPaths) {
      lines.push(`    - ${oneLine(path)}`);
    }
  }
  if (input.branch !== null) {
    lines.push(`  Branch: ${input.branch}`);
  }
  if (input.commitSha !== null) {
    lines.push(`  Commit: ${input.commitSha}`);
  }
  if (input.prUrl !== null) {
    lines.push(`  PR: ${input.prUrl}`);
  }
  if (input.warnings.length > 0) {
    lines.push("  Warnings:");
    for (const warning of input.warnings) {
      lines.push(`    - ${oneLine(warning)}`);
    }
  }
  if (input.errors.length > 0) {
    lines.push("  Errors:");
    for (const err of input.errors) {
      lines.push(`    - ${oneLine(err)}`);
    }
  }
  lines.push("");
  const skipNote =
    input.warnings.length > 0
      ? ` (${input.warnings.length} incidental closing ref${
          input.warnings.length === 1 ? "" : "s"
        } skipped)`
      : "";
  lines.push(
    input.ok
      ? `Result: FINALIZE CLEAN -- cohort briefs swept to completed/.${skipNote}`
      : "Result: FINALIZE INCOMPLETE -- see errors above.",
  );

  return {
    exitCode: input.exitCode,
    stdout: `${lines.join("\n")}\n`,
    stderr: "",
    result,
  };
}
