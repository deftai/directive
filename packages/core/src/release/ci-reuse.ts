/**
 * Release Step 5 CI reuse (#6791, S1 of #6845).
 *
 * Step 5 reuses CI when the clean Step 5 input tree (the release branch HEAD
 * before Step 6 writes) is identical to the tree of the fetched delivery-branch
 * tip, and the latest run of each required check on that tip SHA completed
 * `success`. A missing, pending, failed or re-running latest attempt never
 * reuses an older success. Any read that fails returns a full-run decision;
 * nothing here throws.
 *
 * A reused cut runs no host coverage (operator ruling B on #6791): it runs only
 * the short host smoke check below. The nightly coverage lane (#6849) closes
 * that gap.
 */
import { spawnSync } from "node:child_process";
import { cliSpawnPlan } from "../check/cli-native-gates.js";
import { type CheckRunRecord, defaultRunGh, fetchCheckRunsRest } from "../pr-merge-readiness/gh.js";
import type { RunGhFn } from "../pr-merge-readiness/types.js";
import { MERGE_GATE_TASK_CHECK_NAME } from "../pr-wait-mergeable/constants.js";
import { resolvePnpm, sanitizeTsLaneEnv } from "../ts-check-lane/run-lane.js";
import { RELEASE_CHECK_TIMEOUT_MS } from "./constants.js";
import { checkGitClean, runGit } from "./git.js";
import type { ReleaseSeams } from "./types.js";

/** Required CI check name for the TypeScript build and lint job (#6791). */
export const TYPESCRIPT_BUILD_LINT_CHECK_NAME = "TypeScript (build + lint)" as const;

/** Required checks whose latest attempt on the tip must be `success` for reuse (#6791). */
export const RELEASE_CI_REUSE_REQUIRED_CHECKS: readonly string[] = [
  TYPESCRIPT_BUILD_LINT_CHECK_NAME,
  MERGE_GATE_TASK_CHECK_NAME,
];

/**
 * The short host smoke check of a reused cut (#6791): `pnpm run build`, then
 * these test files with `pnpm exec vitest run` and no coverage. They assert
 * host process spawning, Windows command shims, path handling and the reuse
 * rule itself. Documented in docs/RELEASING.md § Step 5 CI reuse.
 */
export const RELEASE_HOST_SMOKE_TEST_FILES: readonly string[] = [
  "packages/core/src/release/spawn.test.ts",
  "packages/core/src/release/paths.test.ts",
  "packages/core/src/ts-check-lane/run-lane.test.ts",
  "packages/core/src/release/ci-reuse.test.ts",
];

/** Step 5 CI decision kind. Readiness (#6876) records one so Step 5 can print a change. */
export type CiReuseKind = "reuse" | "full";

/** One required check's latest attempt on the tip. */
export interface CiReuseCheck {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string;
  readonly url: string | null;
}

export type CiReuseDecision =
  | {
      readonly kind: "reuse";
      readonly tipSha: string;
      readonly tree: string;
      readonly checks: readonly CiReuseCheck[];
    }
  | {
      readonly kind: "full";
      readonly reason: string;
      readonly tipSha: string | null;
    };

export interface EvaluateCiReuseOptions {
  readonly runGh?: RunGhFn;
  readonly env?: NodeJS.ProcessEnv;
}

function full(reason: string, tipSha: string | null = null): CiReuseDecision {
  return { kind: "full", reason, tipSha };
}

function revParse(projectRoot: string, ref: string, seams: ReleaseSeams): string | null {
  const result = runGit(projectRoot, ["rev-parse", ref], seams);
  if (result.status !== 0) return null;
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

function runTime(run: CheckRunRecord): number {
  const raw = run.created_at ?? run.started_at ?? null;
  const ms = raw !== null ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(ms) ? ms : -1;
}

/**
 * Pick the latest attempt of a named check. A re-run is a new check run with a
 * larger id, so the id decides when both runs carry one; otherwise the later
 * created_at / started_at decides.
 */
export function selectLatestCheckRun(
  checkRuns: readonly CheckRunRecord[],
  name: string,
): CheckRunRecord | null {
  let best: CheckRunRecord | null = null;
  for (const run of checkRuns) {
    if (run.name !== name) continue;
    if (best === null) {
      best = run;
      continue;
    }
    const runId = run.runId ?? null;
    const bestId = best.runId ?? null;
    const newer =
      runId !== null && bestId !== null ? runId > bestId : runTime(run) >= runTime(best);
    if (newer) best = run;
  }
  return best;
}

/** Check-run page URL from its id (`html_url` shape for check runs). */
export function checkRunUrl(repo: string, runId: number | null | undefined): string | null {
  if (runId === null || runId === undefined) return null;
  return `https://github.com/${repo}/runs/${runId}`;
}

/**
 * Decide reuse from the tip's check runs alone (no git, no network).
 * Every required check must have a latest attempt that is completed/success.
 */
export function decideCiReuseFromRuns(
  repo: string,
  tipSha: string,
  tree: string,
  checkRuns: readonly CheckRunRecord[],
  required: readonly string[] = RELEASE_CI_REUSE_REQUIRED_CHECKS,
): CiReuseDecision {
  const checks: CiReuseCheck[] = [];
  for (const name of required) {
    const run = selectLatestCheckRun(checkRuns, name);
    if (run === null) {
      return full(`required check '${name}' is missing on tip ${tipSha}`, tipSha);
    }
    if (run.status !== "completed") {
      return full(
        `latest attempt of '${name}' on tip ${tipSha} is ${run.status}, not completed`,
        tipSha,
      );
    }
    if (run.conclusion !== "success") {
      return full(
        `latest attempt of '${name}' on tip ${tipSha} concluded ${run.conclusion}`,
        tipSha,
      );
    }
    checks.push({
      name,
      status: run.status,
      conclusion: run.conclusion,
      url: checkRunUrl(repo, run.runId),
    });
  }
  return { kind: "reuse", tipSha, tree, checks };
}

/**
 * Evaluate the Step 5 reuse rule against the checkout and GitHub.
 * Exported so the release:run readiness phase (#6876) applies the same rule.
 */
export function evaluateCiReuse(
  projectRoot: string,
  repo: string,
  baseBranch: string,
  seams: ReleaseSeams = {},
  options: EvaluateCiReuseOptions = {},
): CiReuseDecision {
  const env = options.env ?? process.env;
  if (env.DEFT_NO_NETWORK === "1") {
    return full("check runs are not readable under DEFT_NO_NETWORK=1");
  }
  const [clean] = checkGitClean(projectRoot, seams);
  if (!clean) {
    return full("the Step 5 input tree is not clean");
  }
  const fetch = runGit(projectRoot, ["fetch", "origin", baseBranch], seams);
  if (fetch.status !== 0) {
    return full(`git fetch origin ${baseBranch} failed: ${fetch.stderr.trim()}`);
  }
  const tipSha = revParse(projectRoot, `origin/${baseBranch}`, seams);
  if (tipSha === null) {
    return full(`could not resolve the fetched origin/${baseBranch} tip`);
  }
  const headTree = revParse(projectRoot, "HEAD^{tree}", seams);
  const tipTree = revParse(projectRoot, `origin/${baseBranch}^{tree}`, seams);
  if (headTree === null || tipTree === null) {
    return full("could not resolve the HEAD or tip tree", tipSha);
  }
  if (headTree !== tipTree) {
    return full(
      `HEAD tree ${headTree.slice(0, 12)} differs from the origin/${baseBranch} tip tree ${tipTree.slice(0, 12)}`,
      tipSha,
    );
  }
  const fetched = fetchCheckRunsRest(tipSha, repo, options.runGh ?? seams.runGh ?? defaultRunGh);
  if (fetched.error.length > 0) {
    return full(`check runs on tip ${tipSha} unreadable: ${fetched.error}`, tipSha);
  }
  return decideCiReuseFromRuns(repo, tipSha, tipTree, fetched.checkRuns);
}

/** Lines Step 5 prints for a decision (the SHA and check-run URLs on reuse). */
export function formatCiReuseDecision(decision: CiReuseDecision): string[] {
  if (decision.kind === "full") {
    return [`CI reuse: no (${decision.reason}); running the full local check`];
  }
  const lines = [
    `CI reuse: yes; tip ${decision.tipSha} has the same tree as this release branch, and the latest required checks concluded success`,
  ];
  for (const check of decision.checks) {
    lines.push(`  ${check.name}: ${check.conclusion} ${check.url ?? "(no check-run URL)"}`);
  }
  lines.push("CI reuse: a reused cut runs no host coverage; only the short host smoke check runs");
  return lines;
}

/** Line for a decision that changed since readiness, or null when it did not change. */
export function formatCiReuseChange(
  readinessKind: CiReuseKind | null | undefined,
  decision: CiReuseDecision,
): string | null {
  if (readinessKind === null || readinessKind === undefined) return null;
  if (readinessKind === decision.kind) return null;
  return decision.kind === "full"
    ? `CI reuse decision changed since readiness: was reuse, now the full local check (${decision.reason})`
    : "CI reuse decision changed since readiness: was the full local check, now reuse";
}

type SmokeRunner = (
  command: string,
  args: readonly string[],
  cwd: string,
) => { status: number | null; error?: Error };

/**
 * Shell-free spawn plan for one smoke command. The project root travels only
 * as the child's cwd, never on a command line. On win32 a `.cmd` shim runs
 * through `cmd.exe /d /s /c` with every token quoted and
 * `windowsVerbatimArguments` (the cliSpawnPlan rule), never `shell: true`.
 */
export function smokeSpawnPlan(
  command: string,
  args: readonly string[],
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly shell: false;
  readonly windowsVerbatimArguments: boolean;
} {
  const plan = cliSpawnPlan(command, args, platform);
  return {
    command: plan.command,
    args: plan.args,
    cwd,
    shell: false,
    windowsVerbatimArguments: plan.windowsVerbatimArguments === true,
  };
}

/** Run one smoke command without a shell (#6791). */
export function runSmokeCommand(
  command: string,
  args: readonly string[],
  cwd: string,
): { status: number | null; error?: Error } {
  const plan = smokeSpawnPlan(command, args, cwd);
  const result = spawnSync(plan.command, [...plan.args], {
    cwd: plan.cwd,
    env: sanitizeTsLaneEnv(process.env),
    stdio: "inherit",
    shell: plan.shell,
    windowsVerbatimArguments: plan.windowsVerbatimArguments,
    timeout: RELEASE_CHECK_TIMEOUT_MS,
  });
  return { status: result.status, error: result.error };
}

/**
 * Run the short host smoke check: build, then the fixed host test files
 * without coverage. Returns the pipeline's `[ok, message]` tuple.
 */
export function runHostSmokeCheck(
  projectRoot: string,
  options: { readonly pnpm?: string | null; readonly runner?: SmokeRunner } = {},
): [boolean, string] {
  const pnpm = options.pnpm !== undefined ? options.pnpm : resolvePnpm();
  if (pnpm === null) {
    return [false, "host smoke check needs pnpm on PATH"];
  }
  const runner = options.runner ?? runSmokeCommand;
  const steps: ReadonlyArray<readonly string[]> = [
    ["run", "build"],
    ["exec", "vitest", "run", ...RELEASE_HOST_SMOKE_TEST_FILES],
  ];
  for (const args of steps) {
    const result = runner(pnpm, args, projectRoot);
    if (result.status !== 0) {
      const why = result.error ? result.error.message : `exit ${result.status ?? "signal"}`;
      return [false, `host smoke check failed at pnpm ${args.join(" ")} (${why})`];
    }
  }
  return [
    true,
    `host smoke check passed (build + ${RELEASE_HOST_SMOKE_TEST_FILES.length} host test files; no coverage)`,
  ];
}
