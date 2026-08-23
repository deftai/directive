import { randomUUID } from "node:crypto";
import { runText } from "../../swarm/subprocess.js";
import { defaultGitRunner } from "../../swarm/worktrees.js";
import { defaultGithubReader, pullsMentioning } from "./github.js";
import { sha12Of, sinkDir } from "./paths.js";
import { gcStaleSha12Dirs, writeInvocationSink } from "./sink.js";
import {
  DEFAULT_CONCURRENCY,
  type EvaluateOptions,
  type EvaluateResult,
  type GithubReader,
  type GitRunner,
  type IssueEvalVerdict,
  ORIGIN_MASTER,
  type SessionStartFn,
} from "./types.js";
import { evaluateValidity, joinValidityWithGithub } from "./validity.js";
import { buildValueAdvice } from "./value.js";
import { collectWipCensus, wipHitsForIssue } from "./wip-census.js";
import { addEvaluatorWorktree, removeEvaluatorWorktree } from "./worktrees.js";

export class EvaluateError extends Error {
  override name = "EvaluateError";
}

function resolveOriginSha(projectRoot: string, git: GitRunner): string {
  const proc = git(["rev-parse", ORIGIN_MASTER], projectRoot);
  if (proc.returncode !== 0) {
    throw new EvaluateError(
      `could not resolve ${ORIGIN_MASTER}: ${proc.stderr.trim() || "<no stderr>"}`,
    );
  }
  return proc.stdout.trim();
}

function defaultSessionStart(worktreePath: string): void {
  const proc = runText(["deft", "session:start", "--read-only"], { cwd: worktreePath });
  if (proc.returncode !== 0) {
    throw new EvaluateError(
      `session:start --read-only failed in ${worktreePath}: ${proc.stderr.trim() || "<no stderr>"}`,
    );
  }
}

async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await fn(items[index] as T, index);
    }
  };
  const n = Math.max(1, Math.min(limit, Math.max(items.length, 1)));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

function collectGithubForRepo(
  repo: string,
  issues: readonly number[],
  reader: GithubReader,
): {
  issues: ReturnType<GithubReader["viewIssue"]>[];
  openPulls: ReturnType<GithubReader["listOpenPulls"]>;
} {
  const views = issues.map((n) => reader.viewIssue(repo, n));
  const openPulls = reader.listOpenPulls(repo);
  reader.listOpenIssues(repo);
  return { issues: views, openPulls };
}

/**
 * Stage A parent: WIP census + GitHub REST + worktree fan-out + sink write.
 * Evaluators never receive the WIP census.
 */
export async function evaluateIssues(options: EvaluateOptions): Promise<EvaluateResult> {
  const issues = [...new Set(options.issues)].filter((n) => Number.isInteger(n) && n > 0);
  if (issues.length === 0) {
    throw new EvaluateError("triage:evaluate requires one or more issue numbers");
  }
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new EvaluateError("--concurrency must be a positive integer");
  }
  const git = options.git ?? defaultGitRunner;
  const sessionStart: SessionStartFn = options.sessionStart ?? defaultSessionStart;
  const github = options.github ?? defaultGithubReader();
  const originSha = resolveOriginSha(options.projectRoot, git);
  const sha12 = sha12Of(originSha);
  const invocationId = options.invocationId ?? randomUUID();
  const wip = collectWipCensus(options.projectRoot, issues);
  const githubViews = collectGithubForRepo(options.repo, issues, github);
  const viewByIssue = new Map(githubViews.issues.map((snap) => [snap.number, snap]));

  const runOne = async (issue: number): Promise<IssueEvalVerdict> => {
    let worktreePath: string | null = null;
    try {
      worktreePath = addEvaluatorWorktree(options.projectRoot, issue, invocationId, git);
      sessionStart(worktreePath);
      const validity = evaluateValidity(worktreePath, issue);
      const snap = viewByIssue.get(issue) ?? null;
      const joined = joinValidityWithGithub(validity, snap?.state ?? null);
      const pulls = pullsMentioning(githubViews.openPulls, issue);
      const duplicates =
        snap?.duplicateOf !== null && snap?.duplicateOf !== undefined ? [snap.duplicateOf] : [];
      return {
        issue,
        sha12,
        invocationId,
        validity: joined,
        wip: wipHitsForIssue(wip, issue),
        github: snap,
        openPulls: pulls,
        duplicates,
        value: buildValueAdvice(snap),
        error: null,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        issue,
        sha12,
        invocationId,
        validity: null,
        wip: wipHitsForIssue(wip, issue),
        github: viewByIssue.get(issue) ?? null,
        openPulls: pullsMentioning(githubViews.openPulls, issue),
        duplicates: [],
        value: buildValueAdvice(viewByIssue.get(issue) ?? null),
        error: message,
      };
    } finally {
      if (worktreePath !== null) {
        try {
          removeEvaluatorWorktree(options.projectRoot, worktreePath, git);
        } catch {
          // Teardown is best-effort after the per-issue verdict is recorded.
        }
      }
    }
  };

  try {
    const verdicts = await mapPool(issues, concurrency, (issue) => runOne(issue));
    const result: EvaluateResult = {
      sha12,
      invocationId,
      originSha,
      sinkDir: sinkDir(options.projectRoot, sha12, invocationId),
      concurrency,
      verdicts,
    };
    writeInvocationSink(options.projectRoot, result);
    gcStaleSha12Dirs(options.projectRoot, sha12);
    return result;
  } catch (err: unknown) {
    gcStaleSha12Dirs(options.projectRoot, sha12);
    throw err;
  }
}

export function renderEvaluateText(result: EvaluateResult): string {
  const lines: string[] = [
    `triage:evaluate sha12=${result.sha12} invocation=${result.invocationId} concurrency=${result.concurrency}`,
    `sink: ${result.sinkDir}`,
  ];
  for (const verdict of result.verdicts) {
    const state = verdict.validity?.state ?? "error";
    const evidence = verdict.validity?.evidence ?? verdict.error ?? "";
    const wip = verdict.wip.length > 0 ? ` wip=${verdict.wip.length}` : " wip=0";
    lines.push(
      `#${verdict.issue} validity=${state}${wip} critique-recommend: ${verdict.value["critique-recommend"]}`,
    );
    if (evidence.length > 0) {
      lines.push(`  ${evidence}`);
    }
    if (verdict.error !== null) {
      lines.push(`  error: ${verdict.error}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
