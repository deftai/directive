/* v8 ignore file -- type-only surface */
import type { EnvMap } from "../authz/closed-verb.js";
import type { HumanOriginGrant } from "../authz/types.js";

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
  readonly runCi?: (
    projectRoot: string,
    allowCoverageDebtIssue: number | null,
  ) => [boolean, string];
  readonly refreshRoadmap?: (projectRoot: string) => [boolean, string];
  readonly checkVbriefLifecycleSync?: (
    projectRoot: string,
    repo: string,
  ) => [boolean, number, string];
  readonly runBuild?: (projectRoot: string, version: string | null) => [boolean, string];
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
