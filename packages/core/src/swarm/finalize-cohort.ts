import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { evaluate as evaluateBranchPolicy } from "../branch/evaluate.js";
import { resolveLifecycleRoot } from "../layout/resolve.js";
import { defaultRunGh, fetchClosingIssuesReferences } from "../pr-protected-issues/gh.js";
import type { RunGhFn } from "../pr-protected-issues/types.js";
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
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly ok: boolean;
}

export interface FinalizeCohortArgs {
  readonly prNumbers?: readonly number[];
  readonly storyTokens?: readonly string[];
  readonly repo?: string | null;
  readonly projectRoot?: string;
  readonly baseBranch?: string;
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

function fetchPrMergedAt(
  prNumber: number,
  repo: string,
  runGh: RunGhFn,
): { mergedAt: string | null; error: string | null } {
  const parsed = parseRepo(repo);
  if (parsed === null) {
    return { mergedAt: null, error: `invalid --repo value: ${JSON.stringify(repo)}` };
  }
  const path = `repos/${parsed.owner}/${parsed.name}/pulls/${prNumber}`;
  const result = runGh(["gh", "api", path]);
  if (result.returncode !== 0) {
    return {
      mergedAt: null,
      error: `gh api ${path} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    };
  }
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (parsed === null || typeof parsed !== "object") {
      return {
        mergedAt: null,
        error: `unexpected gh api response for PR #${prNumber}: not a JSON object`,
      };
    }
    const payload = parsed as Record<string, unknown>;
    const mergedAt = payload.merged_at;
    if (mergedAt === null) {
      return { mergedAt: null, error: `PR #${prNumber} is not merged yet.` };
    }
    if (typeof mergedAt !== "string" || mergedAt.length === 0) {
      return { mergedAt: null, error: `PR #${prNumber} is not merged yet.` };
    }
    return { mergedAt, error: null };
  } catch (exc: unknown) {
    const message = exc instanceof Error ? exc.message : String(exc);
    return {
      mergedAt: null,
      error: `failed to parse gh api response for PR #${prNumber}: ${message}`,
    };
  }
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
  const prNumbers = [...(args.prNumbers ?? [])].sort((a, b) => a - b);
  const storyTokens = splitCsv(args.storyTokens ?? []);
  const repo = args.repo ?? process.env.GH_REPO ?? null;
  const baseBranch = args.baseBranch ?? "master";
  const dryRun = args.dryRun ?? false;
  const noCommit = args.noCommit ?? false;
  const noOpenPr = args.noOpenPr ?? false;
  const errors: string[] = [];

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
      errors: [`no xbrief/ directory under project root: ${projectRoot}`],
      warnings: [],
      ok: false,
      emitJson: args.emitJson ?? false,
      exitCode: EXIT_CONFIG_ERROR,
    });
  }

  const closingIssues = new Set<number>();
  if (prNumbers.length > 0) {
    if (repo === null || repo.length === 0) {
      errors.push("--repo OWNER/REPO is required when --pr is supplied (or set $GH_REPO).");
    } else {
      for (const prNumber of prNumbers) {
        const merged = fetchPrMergedAt(prNumber, repo, runGh);
        if (merged.error !== null) {
          errors.push(merged.error);
          continue;
        }
        const closing = fetchClosingIssues(prNumber, repo, runGh);
        if (closing.error !== null) {
          errors.push(closing.error);
        }
        for (const issue of closing.issues) {
          closingIssues.add(issue);
        }
      }
    }
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
      const reason = completedBrief
        ? "a completed brief already exists"
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
      errors,
      warnings,
      ok: cleanNoop,
      emitJson: args.emitJson ?? false,
      exitCode: cleanNoop
        ? EXIT_OK
        : errors.some((e) => e.includes("not merged"))
          ? EXIT_GATE_FAILED
          : EXIT_CONFIG_ERROR,
    });
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

  const sweepResult = completeCohort({
    stories: storyPaths,
    projectRoot,
    dryRun,
    emitJson: false,
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
