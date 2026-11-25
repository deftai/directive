/**
 * Release Step 5 CI reuse (#6791, S1 of #6845; #7328 tip-green).
 *
 * Step 5 reuses CI when the Step 5 input tree equals the fetched delivery-branch
 * tip tree (clean or session-scratch-only per classifyReleaseInputCleanliness),
 * and the latest run of each required check on that tip SHA completed
 * `success`. A missing, pending, failed or re-running latest attempt never
 * reuses an older success. Any read that fails returns a full-run decision;
 * nothing here throws.
 *
 * A reused cut runs no host coverage (operator ruling B on #6791): it runs only
 * the short host smoke check below. Nightly lanes (#6849) are printed with a
 * truthful per-lane disposition; tip-green reuse does not hard-require nightly
 * success (#7328). Suite-stamp still uses raw checkGitClean.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliSpawnPlan } from "../check/cli-native-gates.js";
import {
  runTimedChild,
  type SupervisedGateResult,
  type TimedChildPlan,
} from "../check/suite-gate-supervisor.js";
import { containedWrite } from "../fs/contained-write.js";
import { DIRECTIVE_GITIGNORE_LINES } from "../install-health/owned-paths.js";
import { type CheckRunRecord, defaultRunGh, fetchCheckRunsRest } from "../pr-merge-readiness/gh.js";
import type { RunGhFn } from "../pr-merge-readiness/types.js";
import { MERGE_GATE_TASK_CHECK_NAME } from "../pr-wait-mergeable/constants.js";
import { resolvePnpm, sanitizeTsLaneEnv } from "../ts-check-lane/run-lane.js";
import { RELEASE_CHECK_TIMEOUT_MS } from "./constants.js";
import { runGit } from "./git.js";
import {
  evaluateNightlyReuse,
  formatNightlyLanes,
  NIGHTLY_LANES,
  type NightlyReuse,
  windowsLaneReusable,
} from "./nightly-reuse.js";
import type { ReleaseSeams } from "./types.js";

/**
 * Windows full-suite boundary on tip-green smoke-only reuse (#7328).
 * Reported independently of host OS; never refuses.
 */
export function windowsSuiteSkippedLineForSmokeOnly(
  nightly: NightlyReuse | null | undefined,
  platform: NodeJS.Platform,
): string | null {
  if (windowsLaneReusable(nightly)) return null;
  return (
    "The Windows suite did not run for this release: the nightly Windows lane is not reusable " +
    `(smoke-only tip-green reuse; host ${platform}).`
  );
}

/** Named untracked session-scratch path admitted by the release-input classifier (#7328). */
export const RELEASE_SESSION_SCRATCH_GENERATION = ".deft/GENERATION.json" as const;

/** Named untracked session-scratch directory (porcelain-collapsed) (#7328). */
export const RELEASE_SESSION_SCRATCH_DIRECTIVE_DIR = ".deft/directive/" as const;

export type ReleaseInputCleanlinessKind = "clean" | "session-scratch-only" | "dirty";

export type ReleaseInputCleanliness =
  | { readonly kind: "clean" }
  | {
      readonly kind: "session-scratch-only";
      /** Porcelain / path entries admitted as session scratch. */
      readonly ignoredEntries: readonly string[];
      readonly detail: string;
    }
  | { readonly kind: "dirty"; readonly reason: string; readonly porcelain: string };

/** Optional seams for {@link classifyReleaseInputCleanliness} (tests). */
export interface ClassifyReleaseInputCleanlinessSeams {
  readonly porcelain?: () => string;
  readonly stagedGitignoreDiff?: () => string;
  readonly worktreeGitignoreDiff?: () => string;
  readonly headGitignore?: () => string | null;
  readonly worktreeGitignore?: () => string | null;
  readonly allUntracked?: () => readonly string[];
  /** Nested `.gitignore` bodies keyed by repo-relative POSIX path (tests). */
  readonly nestedGitignoreBodies?: () => ReadonlyMap<string, string>;
  readonly isIgnoredBy?: (gitignoreBody: string, path: string) => boolean;
}

function normalizePosix(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Collapse `.deft/directive/...` to the named directory form used in porcelain. */
export function collapseReleaseSessionScratchPath(path: string): string {
  const norm = normalizePosix(path);
  if (norm === RELEASE_SESSION_SCRATCH_GENERATION) return norm;
  if (norm === ".deft/directive" || norm.startsWith(".deft/directive/")) {
    return RELEASE_SESSION_SCRATCH_DIRECTIVE_DIR;
  }
  return norm;
}

export function isAllowlistedReleaseSessionScratch(path: string): boolean {
  const collapsed = collapseReleaseSessionScratchPath(path);
  return (
    collapsed === RELEASE_SESSION_SCRATCH_GENERATION ||
    collapsed === RELEASE_SESSION_SCRATCH_DIRECTIVE_DIR
  );
}

export function releaseInputAllowsProceed(cleanliness: ReleaseInputCleanliness): boolean {
  return cleanliness.kind === "clean" || cleanliness.kind === "session-scratch-only";
}

function parsePorcelainPaths(porcelain: string): {
  readonly entries: readonly { readonly xy: string; readonly path: string }[];
} {
  const entries: { xy: string; path: string }[] = [];
  for (const raw of porcelain.split(/\r?\n/)) {
    if (raw.length < 4) continue;
    const xy = raw.slice(0, 2);
    let path = raw.slice(3);
    const renameSep = path.indexOf(" -> ");
    if (renameSep >= 0) path = path.slice(renameSep + 4);
    entries.push({ xy, path: normalizePosix(path) });
  }
  return { entries };
}

function parseGitignoreAddedLines(
  diff: string,
):
  | { readonly ok: true; readonly added: readonly string[] }
  | { readonly ok: false; readonly reason: string } {
  const added: string[] = [];
  for (const line of diff.split(/\r?\n/)) {
    if (
      line.length === 0 ||
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("---") ||
      line.startsWith("+++") ||
      line.startsWith("@@")
    ) {
      continue;
    }
    if (line.startsWith("-")) {
      return { ok: false, reason: "working-tree .gitignore has removals or modified lines" };
    }
    if (line.startsWith("+")) {
      const content = line.slice(1);
      if (!(DIRECTIVE_GITIGNORE_LINES as readonly string[]).includes(content)) {
        return {
          ok: false,
          reason: `working-tree .gitignore addition is not a DIRECTIVE_GITIGNORE_LINES member: ${content}`,
        };
      }
      added.push(content);
    }
  }
  return { ok: true, added };
}

type NestedGitignoreBodiesResult =
  | { readonly ok: true; readonly bodies: ReadonlyMap<string, string> }
  | { readonly ok: false; readonly reason: string };

/**
 * Load tracked nested `.gitignore` bodies (not the repo-root file).
 * Fail closed via returned-failure so no-concealment never drops nested rules
 * (operational probe path — no throw-site hard fact).
 */
function loadNestedGitignoreBodies(
  projectRoot: string,
  seams: ReleaseSeams,
): NestedGitignoreBodiesResult {
  const listed = runGit(projectRoot, ["ls-files", "-z", "--", ":(glob)**/.gitignore"], seams);
  if (listed.status !== 0) {
    const detail = listed.stderr.trim() || listed.stdout.trim() || "unknown";
    return {
      ok: false,
      reason: `git ls-files nested .gitignore failed (exit ${String(listed.status)}): ${detail}`,
    };
  }
  const out = new Map<string, string>();
  for (const raw of listed.stdout.split("\0")) {
    if (raw.length === 0) continue;
    const rel = normalizePosix(raw);
    // Root `.gitignore` is supplied separately as the HEAD/WT body under test.
    if (rel === ".gitignore" || !rel.includes("/")) continue;
    try {
      out.set(rel, readFileSync(join(projectRoot, rel), "utf8"));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `could not read nested .gitignore ${rel}: ${detail}` };
    }
  }
  return { ok: true, bodies: out };
}

type IgnoreProbeResult =
  | { readonly ok: true; readonly ignored: boolean }
  | { readonly ok: false; readonly reason: string };

/**
 * Evaluate whether `path` is ignored by an arbitrary root gitignore body plus
 * nested `.gitignore` files from the project. Uses a throwaway repo —
 * `git check-ignore` has no `-f` exclude-file flag (unlike check-attr). Exit 0
 * = ignored, 1 = not ignored; any other status is a returned-failure so
 * no-concealment fails closed without a throw-site hard fact. Nested rules
 * (e.g. `packages/runtime/.gitignore` → `.pack-stage/`) must be materialized
 * or `ls-files -o` hits poison session-scratch-only.
 */
function defaultIsIgnoredBy(
  gitignoreBody: string,
  path: string,
  seams: ReleaseSeams,
  nestedBodies: ReadonlyMap<string, string>,
): IgnoreProbeResult {
  const dir = mkdtempSync(join(tmpdir(), "deft-rel-ign-"));
  try {
    const init = runGit(dir, ["init", "-q"], seams);
    if (init.status !== 0) {
      return {
        ok: false,
        reason: `git init for ignore probe failed: ${init.stderr.trim() || "unknown"}`,
      };
    }
    for (const [rel, nestedBody] of nestedBodies) {
      const data = nestedBody.endsWith("\n") ? nestedBody : `${nestedBody}\n`;
      containedWrite({
        root: dir,
        target: rel,
        data,
        mode: "create",
        mutation: false,
      });
    }
    const body = gitignoreBody.endsWith("\n") ? gitignoreBody : `${gitignoreBody}\n`;
    containedWrite({
      root: dir,
      target: ".gitignore",
      data: body,
      mode: "create",
      mutation: false,
    });
    // check-ignore has no -f; rules come from this temp work tree's ignores.
    const check = runGit(dir, ["check-ignore", "--no-index", "-q", "--", path], seams);
    if (check.status === 0) return { ok: true, ignored: true };
    if (check.status === 1) return { ok: true, ignored: false };
    const detail = check.stderr.trim() || check.stdout.trim() || "unknown";
    return {
      ok: false,
      reason: `git check-ignore probe failed (exit ${String(check.status)}): ${detail}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * One named release-input classifier shared by readiness Phase 1, pipeline
 * Step 1, and evaluateCiReuse (#7328 Prefer-A Recut-3).
 *
 * `session-scratch-only` means pure working-tree `.gitignore` additions where
 * every added line is a member of imported DIRECTIVE_GITIGNORE_LINES and/or
 * untracked paths limited to `.deft/GENERATION.json` and `.deft/directive/`
 * (porcelain collapsed), with a no-concealment union check. Removals, modified
 * lines, non-member lines, staged `.gitignore`, and other tracked dirt are
 * `dirty`. Does not invent `--allow-dirty`.
 */
export function classifyReleaseInputCleanliness(
  projectRoot: string,
  seams: ReleaseSeams = {},
  options: ClassifyReleaseInputCleanlinessSeams = {},
): ReleaseInputCleanliness {
  const porcelain =
    options.porcelain?.() ??
    (() => {
      const result = runGit(projectRoot, ["status", "--porcelain"], seams);
      if (result.status !== 0) {
        return `\0git-status-failed:${result.stderr.trim()}`;
      }
      return result.stdout;
    })();
  if (porcelain.startsWith("\0git-status-failed:")) {
    return {
      kind: "dirty",
      reason: porcelain.slice("\0git-status-failed:".length) || "git status failed",
      porcelain: "",
    };
  }
  const trimmed = porcelain.replace(/^\uFEFF/, "");
  if (trimmed.trim().length === 0) return { kind: "clean" };

  const { entries } = parsePorcelainPaths(trimmed);
  const ignoredEntries: string[] = [];
  let gitignoreTouched = false;

  for (const entry of entries) {
    if (entry.path === ".gitignore") {
      gitignoreTouched = true;
      const indexStatus = entry.xy[0] ?? " ";
      const workStatus = entry.xy[1] ?? " ";
      if (indexStatus !== " " && indexStatus !== "?") {
        return {
          kind: "dirty",
          reason: "staged .gitignore changes are not session-scratch-only",
          porcelain: trimmed.trimEnd(),
        };
      }
      if (workStatus !== "M" && workStatus !== "A" && entry.xy !== "??") {
        return {
          kind: "dirty",
          reason: `unsupported .gitignore porcelain status '${entry.xy}'`,
          porcelain: trimmed.trimEnd(),
        };
      }
      ignoredEntries.push(`${entry.xy} .gitignore`);
      continue;
    }
    if (entry.xy === "??" && isAllowlistedReleaseSessionScratch(entry.path)) {
      ignoredEntries.push(`${entry.xy} ${collapseReleaseSessionScratchPath(entry.path)}`);
      continue;
    }
    return {
      kind: "dirty",
      reason: `non-allowlisted dirt: ${entry.xy} ${entry.path}`,
      porcelain: trimmed.trimEnd(),
    };
  }

  if (gitignoreTouched) {
    // #7328 Greptile P1: a failed/timed-out git diff must not parse as empty success
    let stagedDiff: string;
    if (options.stagedGitignoreDiff) {
      stagedDiff = options.stagedGitignoreDiff();
    } else {
      const staged = runGit(projectRoot, ["diff", "--cached", "--", ".gitignore"], seams);
      if (staged.status !== 0) {
        return {
          kind: "dirty",
          reason: `git diff --cached -- .gitignore failed: ${staged.stderr.trim() || `exit ${staged.status}`}`,
          porcelain: trimmed.trimEnd(),
        };
      }
      stagedDiff = staged.stdout;
    }
    if (stagedDiff.trim().length > 0) {
      return {
        kind: "dirty",
        reason: "staged .gitignore changes are not session-scratch-only",
        porcelain: trimmed.trimEnd(),
      };
    }
    let wtDiff: string;
    if (options.worktreeGitignoreDiff) {
      wtDiff = options.worktreeGitignoreDiff();
    } else {
      const wt = runGit(projectRoot, ["diff", "--", ".gitignore"], seams);
      if (wt.status !== 0) {
        return {
          kind: "dirty",
          reason: `git diff -- .gitignore failed: ${wt.stderr.trim() || `exit ${wt.status}`}`,
          porcelain: trimmed.trimEnd(),
        };
      }
      wtDiff = wt.stdout;
    }
    const parsed = parseGitignoreAddedLines(wtDiff);
    if (!parsed.ok) {
      return { kind: "dirty", reason: parsed.reason, porcelain: trimmed.trimEnd() };
    }
    if (parsed.added.length === 0 && !entries.some((e) => e.xy === "??")) {
      return {
        kind: "dirty",
        reason: "working-tree .gitignore change has no pure DIRECTIVE_GITIGNORE_LINES additions",
        porcelain: trimmed.trimEnd(),
      };
    }
  }

  const headIgnore =
    options.headGitignore?.() ??
    (() => {
      const shown = runGit(projectRoot, ["show", "HEAD:.gitignore"], seams);
      return shown.status === 0 ? shown.stdout : null;
    })();
  const wtIgnore =
    options.worktreeGitignore?.() ??
    (() => {
      try {
        return readFileSync(join(projectRoot, ".gitignore"), "utf8");
      } catch {
        return null;
      }
    })();
  if (headIgnore === null || wtIgnore === null) {
    return {
      kind: "dirty",
      reason: "could not read HEAD or working-tree .gitignore for no-concealment",
      porcelain: trimmed.trimEnd(),
    };
  }

  let allUntracked: readonly string[];
  try {
    if (options.allUntracked) {
      allUntracked = options.allUntracked();
    } else {
      const listed = runGit(projectRoot, ["ls-files", "-o", "--directory", "-z"], seams);
      if (listed.status !== 0) {
        const detail = listed.stderr.trim() || listed.stdout.trim() || "unknown";
        return {
          kind: "dirty",
          reason: `git ls-files -o --directory failed (exit ${String(listed.status)}): ${detail}`,
          porcelain: trimmed.trimEnd(),
        };
      }
      allUntracked = listed.stdout
        .split("\0")
        .filter((p) => p.length > 0)
        .map(normalizePosix);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      kind: "dirty",
      reason: `git ls-files -o --directory failed: ${detail}`,
      porcelain: trimmed.trimEnd(),
    };
  }

  type IgnoreFn = (body: string, path: string) => IgnoreProbeResult;
  let probeIgnored: IgnoreFn;
  if (options.isIgnoredBy) {
    const seam = options.isIgnoredBy;
    probeIgnored = (body, path) => {
      try {
        return { ok: true, ignored: seam(body, path) };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: detail };
      }
    };
  } else {
    const nestedLoaded =
      options.nestedGitignoreBodies !== undefined
        ? { ok: true as const, bodies: options.nestedGitignoreBodies() }
        : loadNestedGitignoreBodies(projectRoot, seams);
    if (!nestedLoaded.ok) {
      return {
        kind: "dirty",
        reason: `no-concealment nested .gitignore load failed: ${nestedLoaded.reason}`,
        porcelain: trimmed.trimEnd(),
      };
    }
    const nestedBodies = nestedLoaded.bodies;
    probeIgnored = (body, path) => defaultIsIgnoredBy(body, path, seams, nestedBodies);
  }

  const visible = new Set<string>();
  for (const path of allUntracked) {
    const headProbe = probeIgnored(headIgnore, path);
    if (!headProbe.ok) {
      return {
        kind: "dirty",
        reason: `no-concealment ignore probe failed: ${headProbe.reason}`,
        porcelain: trimmed.trimEnd(),
      };
    }
    if (!headProbe.ignored) visible.add(collapseReleaseSessionScratchPath(path));
    const wtProbe = probeIgnored(wtIgnore, path);
    if (!wtProbe.ok) {
      return {
        kind: "dirty",
        reason: `no-concealment ignore probe failed: ${wtProbe.reason}`,
        porcelain: trimmed.trimEnd(),
      };
    }
    if (!wtProbe.ignored) visible.add(collapseReleaseSessionScratchPath(path));
  }
  for (const path of visible) {
    if (!isAllowlistedReleaseSessionScratch(path)) {
      return {
        kind: "dirty",
        reason: `no-concealment: non-allowlisted untracked path visible under HEAD or working-tree ignore rules: ${path}`,
        porcelain: trimmed.trimEnd(),
      };
    }
  }

  const uniqueIgnored = [...new Set(ignoredEntries)];
  return {
    kind: "session-scratch-only",
    ignoredEntries: uniqueIgnored,
    detail: uniqueIgnored.join("\n"),
  };
}

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
      /** #6849 nightly lanes read for this tree; absent only in older literals. */
      readonly nightly?: NightlyReuse | null;
    }
  | {
      readonly kind: "full";
      readonly reason: string;
      readonly tipSha: string | null;
      /** #6849 nightly lanes, when the rule got as far as reading them. */
      readonly nightly?: NightlyReuse | null;
    };

export interface EvaluateCiReuseOptions {
  readonly runGh?: RunGhFn;
  readonly env?: NodeJS.ProcessEnv;
  /** #6849 seam: read the nightly lanes for the input tree. Production uses evaluateNightlyReuse. */
  readonly evaluateNightly?: (inputTree: string) => NightlyReuse;
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
 * Attach nightly lane disposition to a CI reuse decision (#6849 / #7328).
 *
 * Tip-green reuse admits without a hard nightly-lane success conjunct; the
 * nightly read still rides the decision so readiness and Step 5 print each
 * lane truthfully. Name kept for call-site stability.
 */
export function applyNightlyConjunct(
  decision: CiReuseDecision,
  nightly: NightlyReuse,
): CiReuseDecision {
  return { ...decision, nightly };
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
  const cleanliness = classifyReleaseInputCleanliness(projectRoot, seams);
  if (!releaseInputAllowsProceed(cleanliness)) {
    return full(
      cleanliness.kind === "dirty"
        ? `the Step 5 input tree is not clean (${cleanliness.reason})`
        : "the Step 5 input tree is not clean",
    );
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
  const runGh = options.runGh ?? seams.runGh ?? defaultRunGh;
  const fetched = fetchCheckRunsRest(tipSha, repo, runGh);
  if (fetched.error.length > 0) {
    return full(`check runs on tip ${tipSha} unreadable: ${fetched.error}`, tipSha);
  }
  const readNightly =
    options.evaluateNightly ??
    ((inputTree: string) =>
      evaluateNightlyReuse(projectRoot, repo, baseBranch, inputTree, runGh, seams));
  return applyNightlyConjunct(
    decideCiReuseFromRuns(repo, tipSha, tipTree, fetched.checkRuns),
    readNightly(headTree),
  );
}

/** Lines Step 5 prints for a decision (the SHA and check-run URLs on reuse). */
export function formatCiReuseDecision(decision: CiReuseDecision): string[] {
  if (decision.kind === "full") {
    const lines = [`CI reuse: no (${decision.reason}); running the full local check`];
    if (decision.nightly !== undefined && decision.nightly !== null) {
      lines.push(...formatNightlyLanes(decision.nightly));
    }
    return lines;
  }
  const lines = [
    `CI reuse: yes; tip ${decision.tipSha} has the same tree as this release branch, and the latest required checks concluded success`,
  ];
  for (const check of decision.checks) {
    lines.push(`  ${check.name}: ${check.conclusion} ${check.url ?? "(no check-run URL)"}`);
  }
  if (decision.nightly !== undefined && decision.nightly !== null) {
    lines.push(...formatNightlyLanes(decision.nightly));
    if (decision.nightly.reusable) {
      lines.push(
        `CI reuse: the nightly ${NIGHTLY_LANES.map((lane) => lane.label).join(" and ")} lanes ran on this tree instead`,
      );
    } else {
      for (const lane of decision.nightly.lanes.filter((entry) => !entry.reusable)) {
        lines.push(
          `CI reuse: nightly ${lane.label} not reusable (${lane.reason}); tip-green smoke-only reuse continues`,
        );
      }
    }
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
  timeoutMs: number,
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

/** Sync timed-child runner seam for one smoke command (#6904). */
export type SmokeTimedRunner = (plan: TimedChildPlan) => SupervisedGateResult;

/**
 * Failure text for a smoke command the timed runner stopped or could not run
 * (#6904). It says the process tree was stopped only when the cleanup outcome
 * is `stopped`.
 */
export function describeSmokeFailure(label: string, result: SupervisedGateResult): string | null {
  const head = result.timedOut
    ? `${label} passed its deadline`
    : `${label} failed to run (${result.spawnError ?? "supervisor gave no result"})`;
  switch (result.treeCleanup) {
    case "stopped":
      return `${head}; its process tree was stopped`;
    case "survivors":
      return `${head}; processes still running after the kill: PID ${(result.survivorPids ?? []).join(", ")}`;
    case "unverified": {
      const pid =
        result.lastReportedPid !== undefined
          ? `; check PID ${result.lastReportedPid}, which may already have exited and been reused`
          : "";
      return `${head}; cleanup could not be checked and its processes may still be running${pid}`;
    }
    default:
      break;
  }
  if (result.spawnError !== undefined) return result.spawnError;
  if (result.timedOut) return head;
  return null;
}

/**
 * Run one smoke command without a shell (#6791) under the timed-child
 * supervisor (#6904): at the deadline the supervisor worker stops the whole
 * process tree, not only the direct child. Output is delayed: the captured
 * stdout and stderr are written when the command ends, and only the last
 * 256 KiB of each stream is kept.
 */
export function runSmokeCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number = RELEASE_CHECK_TIMEOUT_MS,
  options: {
    readonly timedRunner?: SmokeTimedRunner;
    readonly platform?: NodeJS.Platform;
    readonly write?: (stream: "stdout" | "stderr", text: string) => void;
  } = {},
): { status: number | null; error?: Error } {
  const platform = options.platform ?? process.platform;
  const write =
    options.write ??
    ((stream: "stdout" | "stderr", text: string) => {
      process[stream].write(text);
    });
  const label = [command, ...args].join(" ");
  write("stdout", `host smoke check: ${label} (${timeoutMs} ms left)\n`);
  const plan = smokeSpawnPlan(command, args, cwd, platform);
  const result = (options.timedRunner ?? runTimedChild)({
    command: plan.command,
    args: plan.args,
    cwd: plan.cwd,
    env: sanitizeTsLaneEnv(process.env),
    timeoutMs,
    platform,
    windowsVerbatimArguments: plan.windowsVerbatimArguments,
  });
  if (result.stdout.length > 0) write("stdout", result.stdout);
  if (result.stderr.length > 0) write("stderr", result.stderr);
  const failure = describeSmokeFailure(label, result);
  if (failure !== null) return { status: null, error: new Error(failure) };
  return { status: result.exitCode };
}

/**
 * Run the short host smoke check: build, then the fixed host test files
 * without coverage. Both commands share one deadline of
 * RELEASE_CHECK_TIMEOUT_MS from the start, so the smoke check never outlasts
 * the full check's budget. Returns the pipeline's `[ok, message]` tuple.
 */
export function runHostSmokeCheck(
  projectRoot: string,
  options: {
    readonly pnpm?: string | null;
    readonly runner?: SmokeRunner;
    readonly nowMs?: () => number;
  } = {},
): [boolean, string] {
  const pnpm = options.pnpm !== undefined ? options.pnpm : resolvePnpm();
  if (pnpm === null) {
    return [false, "host smoke check needs pnpm on PATH"];
  }
  const runner = options.runner ?? runSmokeCommand;
  const nowMs = options.nowMs ?? Date.now;
  const deadlineMs = nowMs() + RELEASE_CHECK_TIMEOUT_MS;
  const steps: ReadonlyArray<readonly string[]> = [
    ["run", "build"],
    ["exec", "vitest", "run", ...RELEASE_HOST_SMOKE_TEST_FILES],
  ];
  for (const args of steps) {
    const remainingMs = deadlineMs - nowMs();
    if (remainingMs <= 0) {
      return [false, `host smoke check ran out of time before pnpm ${args.join(" ")}`];
    }
    const result = runner(pnpm, args, projectRoot, remainingMs);
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
