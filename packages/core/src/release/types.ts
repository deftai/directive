/* v8 ignore file -- type-only surface */
import type { EnvMap } from "../authz/closed-verb.js";
import type { HumanOriginGrant } from "../authz/types.js";
import type { ReleaseInputPhase, ReleaseInputResult } from "./release-input.js";

export type { CachedCheckCompletion } from "../check/orchestrator.js";

export interface ReleaseConfig {
  readonly version: string;
  readonly repo: string;
  readonly baseBranch: string;
  readonly projectRoot: string;
  readonly dryRun: boolean;
  readonly skipTag: boolean;
  readonly skipRelease: boolean;
  readonly allowDirty: boolean;
  readonly draft: boolean;
  readonly skipCi: boolean;
  readonly skipBuild: boolean;
  readonly summary: string | null;
  readonly allowVbriefDrift: boolean;
  readonly allowCoverageDebtIssue: number | null;
  readonly allowSkipCiIssue: number | null;
  /** Distinct override for unpaid skip-ci citations (#5239). Optional; default null. */
  readonly allowUnpaidSkipCiIssue?: number | null;
  /**
   * #6296 item 10 -- break-glass: run on the base branch and push the release
   * commit and tag atomically (today's path). Default false: the cut runs on
   * `release/v<version>` and opens a release PR.
   */
  readonly breakGlass?: boolean;
  /**
   * #6875 -- set only by `deft release:run`. The finish step then refuses
   * unless the sole parent of M is the cut base, and the tag gate accepts only
   * the run's own grant for `<version>@<tree of M>`. Absent: today's behaviour
   * (a version-only grant still works on the manual `--finish` path).
   */
  readonly runBinding?: ReleaseRunBinding | null;
  /**
   * #6791 -- the CI decision readiness recorded (`deft release:run`, #6876).
   * Step 5 evaluates the reuse rule again and prints the decision when it
   * changed. Absent: Step 5 prints its own decision only.
   */
  readonly ciReuseAtReadiness?: import("./ci-reuse.js").CiReuseKind | null;
  /**
   * #6876 -- set only by `deft release:run` for its local cut: run Steps 1 to
   * 9 (commit included) and return before any push or release PR. Absent or
   * false: today's behaviour.
   */
  readonly stopBeforePush?: boolean;
}

/** #6875 -- what a `deft release:run` recorded before the merge. */
export interface ReleaseRunBinding {
  /** Id of the `release-publish` grant the run minted; no other grant counts. */
  readonly grantId: string;
  /** Cut base B: the fetched delivery-branch tip the release branch was made from. */
  readonly expectedBase: string;
}

export interface ReleaseFlags {
  readonly help: boolean;
  readonly version: string | null;
  readonly repo: string | null;
  readonly baseBranch: string;
  readonly projectRoot: string | null;
  readonly dryRun: boolean;
  readonly skipTag: boolean;
  readonly skipRelease: boolean;
  readonly allowDirty: boolean;
  readonly allowVbriefDrift: boolean;
  readonly skipCi: boolean;
  readonly skipBuild: boolean;
  readonly draft: boolean;
  readonly summary: string | null;
  readonly allowCoverageDebtIssue: number | null;
  readonly allowSkipCiIssue: number | null;
  readonly allowUnpaidSkipCiIssue: number | null;
  /** #6296 item 10 -- `--break-glass`. */
  readonly breakGlass: boolean;
  /** #6296 item 3 -- `--finish <version>`; null when absent. */
  readonly finish: string | null;
  readonly unknown: readonly string[];
}

export interface SpawnResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ReleaseSeams {
  readonly todayIso?: () => string;
  readonly sleep?: (seconds: number) => void;
  readonly whichGh?: (name: string) => string | null;
  readonly whichUv?: (name: string) => string | null;
  readonly spawnText?: (
    cmd: string,
    args: readonly string[],
    options: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      timeoutMs?: number;
    },
  ) => SpawnResult;
  readonly writeFile?: (path: string, content: string) => void;
  readonly readFile?: (path: string) => string;
  readonly fileExists?: (path: string) => boolean;
  /**
   * #3900 check 4 -- consumer hard-stop census. When omitted, production lists
   * open issues via REST. Tests inject a [ok, message] tuple so they do not
   * hit GitHub.
   */
  readonly consumerHardStops?: (repo: string, projectRoot: string) => [boolean, string];
  readonly runCi?: (
    projectRoot: string,
    allowCoverageDebtIssue: number | null,
  ) => [boolean, string];
  readonly checkVbriefLifecycleSync?: (
    projectRoot: string,
    repo: string,
  ) => [boolean, number, string];
  readonly validateReleaseInputs?: (
    projectRoot: string,
    phase: ReleaseInputPhase,
  ) => ReleaseInputResult;
  readonly runBuild?: (projectRoot: string, version: string | null) => [boolean, string];
  /**
   * #6315 -- delete one captured changelog fragment in Step 7. When omitted,
   * production uses unlinkSync. Tests inject a failure between the write and
   * the commit.
   */
  readonly unlinkFragment?: (absPath: string) => void;
  readonly runUvLock?: (projectRoot: string) => [boolean, string];
  readonly checkTagAvailable?: (
    version: string,
    repo: string,
    projectRoot: string,
  ) => [boolean, string];
  /**
   * #3187 — open coverage-debt issue numbers (marker + CHANGELOG ledger).
   * When omitted, production probes via gh + CHANGELOG.
   */
  readonly listOpenCoverageDebtIssues?: (repo: string, projectRoot: string) => number[];
  /**
   * #3187 — create coverage-debt tracking issue; return issue number.
   * When omitted, production uses `gh issue create`.
   */
  readonly createCoverageDebtIssue?: (
    repo: string,
    projectRoot: string,
    title: string,
    body: string,
  ) => number;
  /**
   * #3187 — read coverage totals after a failed Step 5 suite (coverage-final.json).
   * When omitted, reads `coverage/coverage-final.json` under projectRoot.
   */
  readonly readCoverageTotals?: (
    projectRoot: string,
  ) => import("../vitest-runner/coverage-debt.js").CoverageTotals | null;
  /** #3187 — current HEAD sha for suite stamp binding. */
  readonly headSha?: (projectRoot: string) => string | null;
  /** #3187 — CI detector; when true suite stamp is never trusted. */
  readonly isCi?: () => boolean;
  /** #6071 — hermetic suites opt out of the always-on named Merge gate on stamp hit. */
  readonly skipNamedMergeGate?: boolean;
  readonly namedMergeGateFn?: import("../pr-wait-mergeable/semantic-green.js").NamedMergeGateFn;
  readonly runGh?: import("../pr-merge-readiness/types.js").RunGhFn;
  /**
   * #6791 -- Step 5 CI reuse rule. Production uses evaluateCiReuse. When a
   * caller injects `runCi` without this seam, that caller owns the Step 5 CI
   * path and the rule is not evaluated (hermetic suites never reach GitHub).
   */
  readonly evaluateCiReuse?: (
    projectRoot: string,
    repo: string,
    baseBranch: string,
  ) => import("./ci-reuse.js").CiReuseDecision;
  /** #6849 -- host platform for the Windows host-boundary line. Production uses process.platform. */
  readonly hostPlatform?: NodeJS.Platform;
  /** #6791 -- host smoke check of a reused cut. Production uses runHostSmokeCheck. */
  readonly runHostSmoke?: (projectRoot: string) => [boolean, string];
  /**
   * #5239 F1 / #6041 — whether Step 5 child lane wrote local coverage-final.json.
   * Production defaults to true (host coverage at Step 5). Tests inject false
   * to exercise the "not expected to write" diagnostic without setting
   * parent `DEFT_RELEASE_PREFLIGHT`.
   */
  readonly step5HostCoverage?: boolean;
  /**
   * #5239 R3+S1 — override skip-ci unpaid ledger probe (tests).
   * When omitted, production uses probeSkipCiIncidentLedger.
   */
  readonly probeSkipCiIncidentLedger?: (
    repo: string,
    projectRoot: string,
    citedIssue: number,
  ) => import("./coverage-debt-ledger.js").SkipCiIncidentLedgerResult;
  /**
   * #3527 — closed-verb grants for the tag-push / npm-publish gate.
   * When omitted, production loads active human-origin grants from disk.
   */
  readonly closedVerbGrants?: readonly HumanOriginGrant[];
  /**
   * #3527 — env map for DEFT_ALLOW_RELEASE_PUBLISH. When omitted, process.env.
   * Tests inject `{}` so a host env bypass cannot leak into fail-closed cases.
   */
  readonly closedVerbEnv?: EnvMap;
  /**
   * #6296 -- resolve the merged release PR for the finish step. When omitted,
   * production reads the REST pulls list for `release/v<version>`.
   */
  readonly findMergedReleasePr?: (
    repo: string,
    baseBranch: string,
    version: string,
  ) => import("./finish.js").MergedReleasePrResult;
  /**
   * #3753 — override the active-CLI probe used by the local-vs-released report.
   * When omitted, production calls `checkActiveCliAgainstTarget`.
   */
  readonly checkActiveCli?: (
    targetVersion: string,
  ) => import("../session/active-cli.js").ActiveCliCheckResult;
  /**
   * #3753 — override one `npm view <pkg>@<ver> --prefer-online` (tests).
   * When omitted, production spawns npm. Never used to install.
   */
  readonly viewWorkspacePackage?: (
    name: string,
    version: string,
  ) => {
    readonly name: string;
    readonly visible: boolean;
    readonly version: string | null;
  };
}
