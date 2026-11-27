/**
 * `deft release:run <version>` (#6876, S3 of #6845).
 *
 * One verb for a stable cut. It runs, in order: readiness; setup (release
 * branch from the fetched tip B, `session:start --primary-claim-exception=release-cut`,
 * cut context); the local cut (Steps 1 to 9, no push); approve; push and open
 * the release PR; review wait and merge; finish (tag, draft release, clear the
 * cut context); npm publish watch; draft flip; promote only when its grant was
 * minted. It ends by printing the pin PR, `release:local-update` and `npm i -g`
 * commands.
 *
 * Approve is the single operator act: after the local cut made release commit
 * R with tree T, the run shows the version, B, T and the promoted CHANGELOG
 * section, then mints one `release-publish` grant for `<version>@<T>` with the
 * operator's `--expires` (and optionally one `release-promote-latest` grant)
 * through the existing `authz:grant` mint path (typed `mint` on a TTY). Without
 * a TTY it prints the mint commands and stops; `--resume` continues. The run
 * records the grant ids, and the S2 gates (#6875) accept only that grant.
 * After the mint no phase reads stdin, so no later phase can prompt.
 *
 * The merge phase (#6877, S4) enqueues the release PR only while the origin
 * tip is still B and the merge queue is empty, waits in-process with
 * `pr:watch` until CLEAN and then with `pr:wait-mergeable-and-merge --wait`,
 * and re-runs a failed required check once per run (run-merge.ts). Under the
 * run the finish step pushes a tag left only local on M and stops on a tag on
 * any other commit. Publish watch, draft flip and promote (#6878, S5) decide
 * from what GitHub and npm show on every run and `--resume` (run-reconcile.ts):
 * a done step is never redone and anything they cannot place stops the run.
 * `--resume` continues at the first phase the run record has not completed.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isDelegatedOrigin } from "../authz/origin.js";
import { listActiveHumanGrants, listDelegatedGrants, loadAuthzState } from "../authz/store.js";
import type { HumanOriginGrant } from "../authz/types.js";
import { defaultRunGh } from "../pr-merge-readiness/gh.js";
import type { RunGhFn } from "../pr-merge-readiness/types.js";
import {
  evaluateReleasePromoteLatestGate,
  evaluateReleasePublishGate,
  runPromoteLatest,
} from "../release-publish/pipeline.js";
import { sectionForVersion } from "./changelog.js";
import { runBoundTarget } from "./closed-verb-gate.js";
import { DEFAULT_BASE_BRANCH, EXIT_CONFIG_ERROR, EXIT_OK, EXIT_VIOLATION } from "./constants.js";
import { runFinish } from "./finish.js";
import { checkTagAvailable } from "./gh.js";
import { releaseCommitSubject, runGit } from "./git.js";
import { resolveProjectRoot, resolveRepo } from "./paths.js";
import { runPipeline } from "./pipeline.js";
import { openReleasePr, pushReleaseBranch, releaseBranchName } from "./release-pr.js";
import { type ReleaseMergeSeams, runMergePhase } from "./run-merge.js";
import {
  formatReadiness,
  type ReadinessInput,
  type ReadinessResult,
  runReleaseReadiness,
} from "./run-readiness.js";
import {
  defaultRunFlip,
  defaultRunPromote,
  type ReconcileContext,
  type ReconcileSeams,
  reconcileFlip,
  reconcilePromote,
  reconcilePublishWatch,
} from "./run-reconcile.js";
import {
  markPhaseCompleted,
  newReleaseRunRecord,
  nextReleaseRunPhase,
  type ReleaseRunGrantIds,
  type ReleaseRunPhase,
  type ReleaseRunRecord,
  readReleaseRunRecord,
  releaseRunRecordPath,
  writeReleaseRunRecord,
} from "./run-record.js";
import type { ReleaseConfig, ReleaseSeams } from "./types.js";
import { isPrereleaseTag, validateReleaseChannelVersion } from "./version.js";

export const RELEASE_RUN_HELP =
  "usage: deft release:run <version> --expires <ISO> [--promote-latest] [--summary <text>]\n" +
  "                        [--repo owner/name] [--base-branch <branch>] [--project-root <path>]\n" +
  "       deft release:run <version> --resume\n" +
  "\n" +
  "One command for a stable cut (#6845). In order: readiness; setup (release branch from the\n" +
  "fetched tip B, session:start --primary-claim-exception=release-cut, cut context); the local cut\n" +
  "(Steps 1 to 9, no push); approve; push and open the release PR; review wait and merge; finish\n" +
  "(tag, draft release, clear the cut context); npm publish watch; draft flip; promote only when its\n" +
  "grant was minted. It ends by printing the pin PR, release:local-update and npm i -g commands.\n" +
  "\n" +
  "Readiness runs before any write and refuses on a failed check; queued PRs and armed auto-merge\n" +
  "are reported only. Approve shows the version, B, T and the promoted CHANGELOG section, then mints\n" +
  "one release-publish grant for <version>@<T> (and, with --promote-latest, one\n" +
  "release-promote-latest grant) through deft authz:grant with typed `mint` on a TTY. Without a TTY\n" +
  "it prints the mint commands and stops; --resume continues. After the mint no phase prompts.\n" +
  "\n" +
  "Merge: the run waits on the release PR with pr:watch until CLEAN, then runs\n" +
  "pr:wait-mergeable-and-merge --wait, enqueueing only while the origin tip is still B and the merge\n" +
  "queue is empty (otherwise it stops without enqueueing). A failed required check or a queue\n" +
  "ejection for a failed check is re-run once per run; the count is in the run record and --resume\n" +
  "keeps it. A second failure or a review finding stops the run. Finish pushes a tag left only local\n" +
  "on M and stops on a v<version> tag on any other commit.\n" +
  "\n" +
  "Publish watch, draft flip and promote decide from GitHub and npm on every run and --resume:\n" +
  "npm is done when the tag-triggered npm-publish run at M and its post-publish fixture concluded\n" +
  "success and both packages are on maintainer (a failed run stops; no republish dispatch); a\n" +
  "published release is done; promote looks for its run first and dispatches at most once. An\n" +
  "expired or spent grant a phase still needs stops the run and names the mint command.\n" +
  "\n" +
  "  --expires <ISO>     Grant expiry, chosen by the operator (required for a new run).\n" +
  "  --promote-latest    Also mint a release-promote-latest grant at approve.\n" +
  "  --resume            Continue the run recorded in .deft-scratch/release-run/<version>.json.\n" +
  "  --summary <text>    One-line release summary for the CHANGELOG section.\n" +
  "  --repo owner/name   Default: the origin remote.\n" +
  "  --base-branch <b>   Default: master.\n" +
  "  --project-root <p>  Default: $DEFT_PROJECT_ROOT, else the current working directory.\n";

export interface ReleaseRunFlags {
  readonly help: boolean;
  readonly version: string | null;
  readonly expires: string | null;
  readonly promoteLatest: boolean;
  readonly resume: boolean;
  readonly summary: string | null;
  readonly repo: string | null;
  readonly baseBranch: string;
  readonly projectRoot: string | null;
  readonly unknown: readonly string[];
}

export function parseReleaseRunFlags(args: readonly string[]): ReleaseRunFlags {
  let help = false;
  let version: string | null = null;
  let expires: string | null = null;
  let promoteLatest = false;
  let resume = false;
  let summary: string | null = null;
  let repo: string | null = null;
  let baseBranch = DEFAULT_BASE_BRANCH;
  let projectRoot: string | null = null;
  const unknown: string[] = [];
  const valued = new Set(["--expires", "--summary", "--repo", "--base-branch", "--project-root"]);
  const set = (flag: string, value: string): void => {
    if (flag === "--expires") expires = value;
    else if (flag === "--summary") summary = value;
    else if (flag === "--repo") repo = value;
    else if (flag === "--base-branch") baseBranch = value;
    else projectRoot = value;
  };
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] ?? "";
    if (token === "--") continue;
    if (token === "-h" || token === "--help") {
      help = true;
    } else if (token === "--promote-latest") {
      promoteLatest = true;
    } else if (token === "--resume") {
      resume = true;
    } else if (valued.has(token)) {
      const value = args[i + 1];
      if (value === undefined || value.length === 0) {
        unknown.push(`${token} (missing value)`);
      } else {
        set(token, value);
        i += 1;
      }
    } else if (token.includes("=") && valued.has(token.slice(0, token.indexOf("=")))) {
      const flag = token.slice(0, token.indexOf("="));
      const value = token.slice(token.indexOf("=") + 1);
      if (value.length === 0) unknown.push(`${flag}= (empty value)`);
      else set(flag, value);
    } else if (token.startsWith("-")) {
      unknown.push(token);
    } else if (version === null) {
      version = token.startsWith("v") ? token.slice(1) : token;
    } else {
      unknown.push(token);
    }
  }
  return {
    help,
    version,
    expires,
    promoteLatest,
    resume,
    summary,
    repo,
    baseBranch,
    projectRoot,
    unknown,
  };
}

/** The `deft authz:grant` argv approve uses (and prints without a TTY). */
export function releaseRunMintArgv(
  template: "release-publish" | "release-promote-latest",
  target: string,
  expires: string,
): string[] {
  return [
    "authz:grant",
    "--",
    "--template",
    template,
    "--target",
    target,
    "--expires",
    expires,
    "--confirm",
  ];
}

/** Approved-scope clash paths considered by release:local-update (#7331). */
export const APPROVED_SCOPE_CLASH_PREFIX = ".deft/approved-scope/";

export type ApprovedScopeClashDecision =
  | { readonly kind: "ignore-not-on-tip"; readonly relPath: string }
  | { readonly kind: "remove-identical"; readonly relPath: string }
  | { readonly kind: "move-aside"; readonly relPath: string };

/**
 * Per-path decision for an untracked tip-tracked approved-scope twin (#7331).
 * Compare untracked bytes to the tip blob ff-only would materialize.
 */
export function decideApprovedScopeClash(input: {
  readonly relPath: string;
  readonly untrackedBytes: Buffer;
  readonly tipBytes: Buffer | null;
}): ApprovedScopeClashDecision {
  const relPath = input.relPath.replace(/\\/g, "/");
  if (input.tipBytes === null) {
    return { kind: "ignore-not-on-tip", relPath };
  }
  if (Buffer.compare(input.untrackedBytes, input.tipBytes) === 0) {
    return { kind: "remove-identical", relPath };
  }
  return { kind: "move-aside", relPath };
}

/** One-step remediation lines after clash handling (#7331 P2). */
export function formatApprovedScopeClashRemediation(
  decisions: readonly ApprovedScopeClashDecision[],
  backupRoot: string,
): string[] {
  const removed = decisions.filter((d) => d.kind === "remove-identical").map((d) => d.relPath);
  const moved = decisions.filter((d) => d.kind === "move-aside").map((d) => d.relPath);
  const lines: string[] = [];
  if (removed.length === 0 && moved.length === 0) return lines;
  lines.push(
    "release:local-update: remediated untracked tip-tracked approved-scope twins before ff-only (#7331).",
  );
  if (removed.length > 0) {
    lines.push(
      `  removed tip-identical untracked (${removed.length}): ${removed.slice(0, 5).join(", ")}${
        removed.length > 5 ? ", …" : ""
      }`,
    );
  }
  if (moved.length > 0) {
    lines.push(
      `  moved divergent untracked aside to ${backupRoot} (${moved.length}): ${moved
        .slice(0, 5)
        .join(", ")}${moved.length > 5 ? ", …" : ""}`,
    );
  }
  lines.push(
    "  re-run is not needed for these paths; ff-only proceeds. Never git clean -fd .deft/approved-scope/.",
  );
  return lines;
}

/** Runnable pin-PR setup carrier named after finish+promote (#7331 P1/P3). */
export function releasePinPrCommand(version: string): string {
  return `task release:pin-pr -- ${version}`;
}

/** The post-run commands (clause 31) plus pin-PR setup + local-update clash path (#7331). */
export function releaseRunFinalLines(
  version: string,
  baseBranch: string,
  projectRoot: string,
): string[] {
  return [
    `Release v${version} run complete. Remaining steps for the operator, after the run:`,
    `  1. Pin PR setup (runnable): ${releasePinPrCommand(version)}` +
      ` — tip worktree + chore/pin-directive-${version}; bumps package.json pin +` +
      " minimumReleaseAgeExclude; ensures changelog.d/ exists; writes the pin fragment;" +
      ` runs \`pnpm update -w @deftai/directive-runtime@${version}\` and` +
      " `pnpm install --frozen-lockfile`; opens the PR with Documentation impact" +
      " change_class: none (commit the pin from your own terminal until #5771 lands;" +
      ` base origin/${baseBranch}).`,
    `  2. task release:local-update -- ${version} --checkout ${projectRoot}` +
      " — remediates untracked tip-tracked .deft/approved-scope/** twins per-path" +
      " (identical → remove; divergent → OS temp move-aside) before ff-only; never" +
      " git clean -fd the whole approved-scope tree.",
    `  3. npm i -g @deftai/directive@${version}`,
  ];
}

/**
 * Inherited by every release:run child verb. Runtime self-complete honors it so
 * setupRitual's session:start (and hooks) cannot dirt a tip pin+wiring tree
 * before the cut (#7327 Greptile P1). Must match runtime self-complete.ts.
 */
export const DEFT_SKIP_SELF_COMPLETE = "DEFT_SKIP_SELF_COMPLETE";

/** Env for release:run child processes: suppress launcher self-complete (#7327). */
export function releaseRunChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, [DEFT_SKIP_SELF_COMPLETE]: "1" };
}

export interface RunVerbOptions {
  readonly cwd: string;
  /** Only the mint reads stdin; every other child gets no stdin, so it cannot prompt. */
  readonly interactive: boolean;
}

export interface ReleaseRunSeams {
  /** Seams handed to the release pipeline, finish and publish steps. */
  readonly release?: ReleaseSeams;
  readonly runGh?: RunGhFn;
  readonly now?: () => Date;
  readonly isTty?: () => boolean;
  readonly out?: (text: string) => void;
  /** Run one `deft` verb. Production re-invokes this CLI with node. */
  readonly runVerb?: (argv: readonly string[], options: RunVerbOptions) => number;
  /** Run `node <script> ...args` (the cut-context producer). */
  readonly runNode?: (args: readonly string[], cwd: string) => number;
  readonly readiness?: (input: ReadinessInput) => ReadinessResult;
  readonly cut?: (config: ReleaseConfig) => number;
  readonly pushAndOpenPr?: (config: ReleaseConfig) => { ok: boolean; reason: string };
  /** Seams of the merge phase (#6877): watch, enqueue reads, re-run and queue waits. */
  readonly merge?: ReleaseMergeSeams;
  readonly finish?: (config: ReleaseConfig) => number;
  /** Reads of the publish watch, draft flip and promote reconciliation (#6878). */
  readonly reconcile?: ReconcileSeams;
  /** The run-bound draft flip with this grant id. */
  readonly flip?: (config: ReleaseConfig, grantId: string) => number;
  /** The promote-latest dispatch with this grant id (spent before the dispatch). */
  readonly promote?: (config: ReleaseConfig, grantId: string) => number;
  readonly listGrants?: (projectRoot: string) => readonly HumanOriginGrant[];
}

function defaultRunVerb(argv: readonly string[], options: RunVerbOptions): number {
  const entry = process.argv[1];
  if (entry === undefined) return EXIT_CONFIG_ERROR;
  const result = spawnSync(process.execPath, [entry, ...argv], {
    cwd: options.cwd,
    env: releaseRunChildEnv(),
    stdio: options.interactive ? "inherit" : ["ignore", "inherit", "inherit"],
  });
  return result.status ?? EXIT_VIOLATION;
}

function defaultRunNode(args: readonly string[], cwd: string): number {
  const result = spawnSync(process.execPath, [...args], {
    cwd,
    stdio: ["ignore", "inherit", "inherit"],
  });
  return result.status ?? EXIT_VIOLATION;
}

function defaultIsTty(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

function releaseConfigOf(record: ReleaseRunRecord, projectRoot: string): ReleaseConfig {
  return {
    version: record.version,
    repo: record.repo,
    baseBranch: record.baseBranch,
    projectRoot,
    dryRun: false,
    skipTag: false,
    skipRelease: false,
    allowDirty: false,
    draft: true,
    skipCi: false,
    skipBuild: false,
    summary: record.summary,
    allowVbriefDrift: false,
    allowCoverageDebtIssue: null,
    allowSkipCiIssue: null,
    breakGlass: false,
    ciReuseAtReadiness: record.ciReuseAtReadiness,
  };
}

interface Ctx {
  record: ReleaseRunRecord;
  readonly projectRoot: string;
  readonly seams: ReleaseRunSeams;
  readonly out: (text: string) => void;
  readonly now: () => Date;
}

function git(ctx: Ctx, args: readonly string[]): { ok: boolean; out: string } {
  const r = runGit(ctx.projectRoot, args, ctx.seams.release ?? {});
  return { ok: r.status === 0, out: r.status === 0 ? r.stdout.trim() : r.stderr.trim() };
}

function line(ctx: Ctx, phase: ReleaseRunPhase, status: string): void {
  ctx.out(`[release:run ${phase}] ${status}\n`);
}

function save(ctx: Ctx, patch: Partial<ReleaseRunRecord>): void {
  ctx.record = { ...ctx.record, ...patch, updatedAt: ctx.now().toISOString() };
  writeReleaseRunRecord(ctx.projectRoot, ctx.record);
}

function phaseSetup(ctx: Ctx): number {
  const { baseBranch, version } = ctx.record;
  if (ctx.record.cutBase !== null) {
    // Resumed after the branch was made: keep the recorded B, never re-cut it.
    const branch = git(ctx, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (!branch.ok || branch.out !== releaseBranchName(version)) {
      line(
        ctx,
        "setup",
        `FAIL (B is recorded but the checkout is not on ${releaseBranchName(version)})`,
      );
      return EXIT_VIOLATION;
    }
    return setupRitual(ctx);
  }
  const fetch = git(ctx, ["fetch", "origin", baseBranch]);
  if (!fetch.ok) {
    line(ctx, "setup", `FAIL (git fetch origin ${baseBranch}: ${fetch.out})`);
    return EXIT_VIOLATION;
  }
  const tip = git(ctx, ["rev-parse", `origin/${baseBranch}`]);
  if (!tip.ok || tip.out.length === 0) {
    line(ctx, "setup", `FAIL (cannot resolve origin/${baseBranch})`);
    return EXIT_VIOLATION;
  }
  const branch = releaseBranchName(version);
  const sw = git(ctx, ["switch", "-c", branch, tip.out]);
  if (!sw.ok) {
    line(ctx, "setup", `FAIL (git switch -c ${branch} ${tip.out.slice(0, 12)}: ${sw.out})`);
    return EXIT_VIOLATION;
  }
  save(ctx, { cutBase: tip.out });
  line(ctx, "setup", `OK (${branch} at B=${tip.out})`);
  return setupRitual(ctx);
}

function setupRitual(ctx: Ctx): number {
  const runVerb = ctx.seams.runVerb ?? defaultRunVerb;
  const ritual = runVerb(["session:start", "--primary-claim-exception=release-cut"], {
    cwd: ctx.projectRoot,
    interactive: false,
  });
  if (ritual !== 0) {
    line(
      ctx,
      "setup",
      `FAIL (session:start --primary-claim-exception=release-cut exited ${String(ritual)})`,
    );
    return EXIT_VIOLATION;
  }
  const producer = join(ctx.projectRoot, "tasks", "materialize.cjs");
  if (ctx.seams.runNode === undefined && !existsSync(producer)) {
    line(ctx, "setup", `FAIL (cut-context producer not found at ${producer})`);
    return EXIT_CONFIG_ERROR;
  }
  const runNode = ctx.seams.runNode ?? defaultRunNode;
  const marker = runNode([producer, "--write-cut-context", ctx.projectRoot], ctx.projectRoot);
  if (marker !== 0) {
    line(ctx, "setup", `FAIL (cut-context write exited ${String(marker)})`);
    return EXIT_VIOLATION;
  }
  line(ctx, "setup", "OK (session started with release-cut; cut context written)");
  return EXIT_OK;
}

/**
 * A stop after the Step 9 commit and before the record write leaves R on the
 * branch with no record of it. True when HEAD is that commit: its parent is B
 * and its subject is the release commit subject. HEAD at B means no commit yet.
 */
function headIsUnrecordedReleaseCommit(ctx: Ctx): { known: boolean; adopt: boolean } {
  const head = git(ctx, ["rev-parse", "HEAD"]);
  if (!head.ok) return { known: false, adopt: false };
  if (head.out === ctx.record.cutBase) return { known: true, adopt: false };
  const parent = git(ctx, ["rev-parse", "HEAD^"]);
  const subject = git(ctx, ["log", "-1", "--format=%s", "HEAD"]);
  const adopt =
    parent.ok &&
    subject.ok &&
    parent.out === ctx.record.cutBase &&
    subject.out === releaseCommitSubject(ctx.record.version);
  return { known: adopt, adopt };
}

function phaseCut(ctx: Ctx): number {
  const state =
    ctx.record.releaseCommit === null
      ? headIsUnrecordedReleaseCommit(ctx)
      : { known: true, adopt: true };
  if (!state.known) {
    line(
      ctx,
      "cut",
      "FAIL (HEAD is neither the cut base B nor a release commit on B; nothing overwritten)",
    );
    return EXIT_VIOLATION;
  }
  if (!state.adopt) {
    const config: ReleaseConfig = {
      ...releaseConfigOf(ctx.record, ctx.projectRoot),
      stopBeforePush: true,
    };
    const cut = ctx.seams.cut ?? ((c: ReleaseConfig) => runPipeline(c, ctx.seams.release ?? {}));
    const code = cut(config);
    if (code !== EXIT_OK) {
      line(ctx, "cut", `FAIL (local cut exited ${String(code)})`);
      return code;
    }
  } else if (ctx.record.releaseCommit === null) {
    line(ctx, "cut", "OK (found the release commit on B from an earlier run; not cut again)");
  }
  const head = git(ctx, ["rev-parse", "HEAD"]);
  const tree = git(ctx, ["rev-parse", "HEAD^{tree}"]);
  const parent = git(ctx, ["rev-parse", "HEAD^"]);
  if (!head.ok || !tree.ok || !parent.ok) {
    line(ctx, "cut", "FAIL (cannot read the release commit, its tree or its parent)");
    return EXIT_VIOLATION;
  }
  if (parent.out !== ctx.record.cutBase) {
    line(
      ctx,
      "cut",
      `FAIL (release commit parent ${parent.out} is not the cut base B=${String(ctx.record.cutBase)})`,
    );
    return EXIT_VIOLATION;
  }
  save(ctx, { releaseCommit: head.out, releaseTree: tree.out });
  line(ctx, "cut", `OK (R=${head.out}, T=${tree.out}; nothing pushed)`);
  return EXIT_OK;
}

function mintedAfter(grant: HumanOriginGrant, sinceIso: string): boolean {
  const minted = Date.parse(grant.origin.mintedAt);
  const since = Date.parse(sinceIso);
  // Grant timestamps carry whole seconds; compare at that precision.
  return (
    Number.isFinite(minted) &&
    Number.isFinite(since) &&
    Math.floor(minted / 1000) >= Math.floor(since / 1000)
  );
}

function newest(grants: readonly HumanOriginGrant[]): HumanOriginGrant | null {
  let best: HumanOriginGrant | null = null;
  for (const g of grants) {
    if (best === null || Date.parse(g.origin.mintedAt) >= Date.parse(best.origin.mintedAt))
      best = g;
  }
  return best;
}

/** Grants minted since approve asked: the run-bound publish grant and the promote grant. */
export function findRunGrants(
  record: ReleaseRunRecord,
  projectRoot: string,
  grants: readonly HumanOriginGrant[],
): { releasePublish: string | null; promoteLatest: string | null } {
  const since = record.approveRequestedAt;
  const tree = record.releaseTree;
  if (since === null || tree === null) return { releasePublish: null, promoteLatest: null };
  const fresh = grants.filter((g) => mintedAfter(g, since));
  const publish = fresh.filter(
    (g) =>
      evaluateReleasePublishGate(record.version, projectRoot, {
        grants: [g],
        env: {},
        repo: record.repo,
        runGrant: { grantId: g.id, tree },
      }).allowed,
  );
  const promote = record.promoteLatest
    ? fresh.filter(
        (g) =>
          evaluateReleasePromoteLatestGate(record.version, projectRoot, {
            grants: [g],
            env: {},
            repo: record.repo,
          }).allowed,
      )
    : [];
  return {
    releasePublish: newest(publish)?.id ?? null,
    promoteLatest: newest(promote)?.id ?? null,
  };
}

function readPromotedSection(ctx: Ctx): string {
  const show = git(ctx, ["show", "HEAD:CHANGELOG.md"]);
  if (!show.ok) return "(CHANGELOG.md unreadable at the release commit)";
  const section = sectionForVersion(show.out, ctx.record.version).trim();
  return section.length > 0 ? section : "(no promoted section found)";
}

/**
 * Grants the run may use: active human-origin grants plus delegated release
 * grants (#7420). A delegated grant is only a candidate here; the closed-verb
 * gate admits it only for its own release verb while its delegation is live.
 */
export function defaultReleaseRunGrants(root: string): readonly HumanOriginGrant[] {
  return [...listActiveHumanGrants(root, loadAuthzState(root)), ...listDelegatedGrants(root)];
}

function listGrantsOf(ctx: Ctx): (projectRoot: string) => readonly HumanOriginGrant[] {
  return ctx.seams.listGrants ?? defaultReleaseRunGrants;
}

/** The delegated grant with this id, or null (human grants keep the unchanged path). */
function delegatedRunGrant(ctx: Ctx, grantId: string): HumanOriginGrant | null {
  const found = listGrantsOf(ctx)(ctx.projectRoot).find((g) => g.id === grantId);
  return found !== undefined && isDelegatedOrigin(found.origin) ? found : null;
}

/**
 * Draft flip: a human grant goes through the unchanged default; a delegated
 * grant is handed to the same run-bound gate as the only candidate (#7420).
 */
function runFlipOf(ctx: Ctx, release: ReleaseSeams) {
  return (c: ReleaseConfig, grantId: string): number => {
    const delegated = delegatedRunGrant(ctx, grantId);
    if (delegated === null) return defaultRunFlip(release)(c, grantId);
    const seams = { ...release, closedVerbGrants: [delegated] } as ReleaseSeams;
    return defaultRunFlip(seams)(c, grantId);
  };
}

/** Promote dispatch: same split as {@link runFlipOf} (#7420). */
function runPromoteOf(ctx: Ctx, release: ReleaseSeams) {
  return (c: ReleaseConfig, grantId: string): number => {
    const delegated = delegatedRunGrant(ctx, grantId);
    if (delegated === null) return defaultRunPromote(release, ctx.projectRoot)(c, grantId);
    return runPromoteLatest(
      { version: c.version, repo: c.repo, projectRoot: c.projectRoot, dryRun: false },
      { ...release, closedVerbGrants: [delegated] } as Parameters<typeof runPromoteLatest>[1],
    );
  };
}

function phaseApprove(ctx: Ctx): number {
  const r = ctx.record;
  if (r.releaseTree === null || r.cutBase === null) {
    line(ctx, "approve", "FAIL (the run record has no B or T; the local cut did not finish)");
    return EXIT_VIOLATION;
  }
  const target = runBoundTarget(r.version, r.releaseTree);
  const commands = [releaseRunMintArgv("release-publish", target, r.expires)];
  if (r.promoteLatest)
    commands.push(releaseRunMintArgv("release-promote-latest", r.version, r.expires));
  const listGrants = listGrantsOf(ctx);

  if (r.approveRequestedAt === null) {
    ctx.out(
      [
        `Approve release v${r.version}:`,
        `  version: ${r.version}`,
        `  B (cut base): ${r.cutBase}`,
        `  T (release tree): ${r.releaseTree}`,
        `  release-publish target: ${target}, expires ${r.expires}`,
        r.promoteLatest
          ? `  release-promote-latest target: ${r.version}`
          : "  release-promote-latest: not requested",
        "  Promoted CHANGELOG section:",
        ...readPromotedSection(ctx)
          .split(/\r?\n/)
          .map((l) => `    ${l}`),
        "",
      ].join("\n"),
    );
    save(ctx, { approveRequestedAt: ctx.now().toISOString() });
    const isTty = (ctx.seams.isTty ?? defaultIsTty)();
    if (!isTty) {
      ctx.out(
        [
          "No TTY: mint the grant(s) from your own terminal, then resume:",
          ...commands.map((argv) => `  deft ${argv.join(" ")}`),
          `  deft release:run ${r.version} --resume`,
          "",
        ].join("\n"),
      );
      line(ctx, "approve", "STOPPED (waiting for the mint; nothing was pushed)");
      return EXIT_VIOLATION;
    }
    const runVerb = ctx.seams.runVerb ?? defaultRunVerb;
    for (const argv of commands) {
      const code = runVerb(argv, { cwd: ctx.projectRoot, interactive: true });
      if (code !== 0) {
        line(
          ctx,
          "approve",
          `FAIL (deft ${argv.slice(0, 5).join(" ")} exited ${String(code)}; resume with --resume after a mint)`,
        );
        return EXIT_VIOLATION;
      }
    }
  }

  const found = findRunGrants(ctx.record, ctx.projectRoot, listGrants(ctx.projectRoot));
  const missing: string[][] = [];
  if (found.releasePublish === null) missing.push(commands[0] ?? []);
  if (r.promoteLatest && found.promoteLatest === null && commands[1] !== undefined) {
    missing.push(commands[1]);
  }
  if (missing.length > 0) {
    ctx.out(
      [
        "No matching grant minted since approve asked. Mint, then resume:",
        ...missing.map((argv) => `  deft ${argv.join(" ")}`),
        `  deft release:run ${r.version} --resume`,
        "",
      ].join("\n"),
    );
    line(ctx, "approve", "STOPPED (grant not found; nothing was pushed)");
    return EXIT_VIOLATION;
  }
  save(ctx, { grants: found });
  line(
    ctx,
    "approve",
    `OK (release-publish grant ${String(found.releasePublish)}` +
      (found.promoteLatest !== null
        ? `, release-promote-latest grant ${found.promoteLatest})`
        : ")"),
  );
  return EXIT_OK;
}

function phasePushPr(ctx: Ctx): number {
  const config = releaseConfigOf(ctx.record, ctx.projectRoot);
  const pushAndOpen =
    ctx.seams.pushAndOpenPr ??
    ((c: ReleaseConfig) => {
      const seams = ctx.seams.release ?? {};
      const [pushed, pushReason] = pushReleaseBranch(c.projectRoot, c.version, seams);
      if (!pushed) return { ok: false, reason: pushReason };
      const [opened, openReason] = openReleasePr(
        c.projectRoot,
        c.version,
        c.repo,
        c.baseBranch,
        seams,
      );
      return { ok: opened, reason: openReason };
    });
  const result = pushAndOpen(config);
  if (!result.ok) {
    line(ctx, "push-pr", `FAIL (${result.reason})`);
    return EXIT_VIOLATION;
  }
  const match = /\/pull\/(\d+)/.exec(result.reason);
  if (match === null) {
    line(ctx, "push-pr", `FAIL (no PR number in: ${result.reason})`);
    return EXIT_VIOLATION;
  }
  save(ctx, { pr: Number(match[1]) });
  line(ctx, "push-pr", `OK (${result.reason})`);
  return EXIT_OK;
}

function phaseMerge(ctx: Ctx): number {
  // #6877: enqueue reads, the in-process pr:watch wait, the queue wait and the
  // one re-run per run live in run-merge.ts.
  return runMergePhase(
    {
      projectRoot: ctx.projectRoot,
      record: () => ctx.record,
      save: (patch) => save(ctx, patch),
      line: (status) => line(ctx, "merge", status),
      now: ctx.now,
    },
    { release: ctx.seams.release, runGh: ctx.seams.runGh, ...ctx.seams.merge },
  );
}

function phaseFinish(ctx: Ctx): number {
  const { grants, cutBase } = ctx.record;
  if (grants.releasePublish === null || cutBase === null) {
    line(ctx, "finish", "FAIL (the run record has no grant id or cut base)");
    return EXIT_VIOLATION;
  }
  const config: ReleaseConfig = {
    ...releaseConfigOf(ctx.record, ctx.projectRoot),
    runBinding: { grantId: grants.releasePublish, expectedBase: cutBase },
  };
  const finish = ctx.seams.finish ?? ((c: ReleaseConfig) => runFinish(c, ctx.seams.release ?? {}));
  const code = finish(config);
  if (code !== EXIT_OK) {
    line(ctx, "finish", `FAIL (finish exited ${String(code)})`);
    return code;
  }
  const runNode = ctx.seams.runNode ?? defaultRunNode;
  const producer = join(ctx.projectRoot, "tasks", "materialize.cjs");
  const cleared = runNode([producer, "--clear-cut-context", ctx.projectRoot], ctx.projectRoot);
  if (cleared !== 0) {
    line(ctx, "finish", `FAIL (cut-context clear exited ${String(cleared)})`);
    return EXIT_VIOLATION;
  }
  line(ctx, "finish", "OK (tagged, draft release created, cut context cleared)");
  return EXIT_OK;
}

/** The mint command for a grant kind the run still needs, with an expiry placeholder. */
function mintCommandOf(record: ReleaseRunRecord, kind: keyof ReleaseRunGrantIds): string {
  const argv =
    kind === "releasePublish"
      ? releaseRunMintArgv(
          "release-publish",
          runBoundTarget(record.version, record.releaseTree ?? "<T>"),
          "<ISO>",
        )
      : releaseRunMintArgv("release-promote-latest", record.version, "<ISO>");
  return `deft ${argv.join(" ")}`;
}

function reconcileCtx(ctx: Ctx, phase: ReleaseRunPhase): ReconcileContext {
  const release = ctx.seams.release ?? {};
  return {
    projectRoot: ctx.projectRoot,
    config: releaseConfigOf(ctx.record, ctx.projectRoot),
    record: () => ctx.record,
    save: (patch) => save(ctx, patch),
    line: (status) => line(ctx, phase, status),
    out: ctx.out,
    listGrants: listGrantsOf(ctx),
    findGrants: (grants) => findRunGrants(ctx.record, ctx.projectRoot, grants),
    mintCommand: (kind) => mintCommandOf(ctx.record, kind),
    flip: ctx.seams.flip ?? runFlipOf(ctx, release),
    promote: ctx.seams.promote ?? runPromoteOf(ctx, release),
  };
}

function phasePublishWatch(ctx: Ctx): number {
  return reconcilePublishWatch(
    reconcileCtx(ctx, "publish-watch"),
    ctx.seams.reconcile,
    ctx.seams.release,
    ctx.seams.runGh,
  );
}

function phaseFlip(ctx: Ctx): number {
  return reconcileFlip(reconcileCtx(ctx, "flip"), ctx.seams.reconcile, ctx.seams.release);
}

function phasePromote(ctx: Ctx): number {
  return reconcilePromote(
    reconcileCtx(ctx, "promote"),
    ctx.seams.reconcile,
    ctx.seams.release,
    ctx.seams.runGh,
  );
}

const PHASES: Readonly<Record<Exclude<ReleaseRunPhase, "readiness">, (ctx: Ctx) => number>> = {
  setup: phaseSetup,
  cut: phaseCut,
  approve: phaseApprove,
  "push-pr": phasePushPr,
  merge: phaseMerge,
  finish: phaseFinish,
  "publish-watch": phasePublishWatch,
  flip: phaseFlip,
  promote: phasePromote,
};

export interface ReleaseRunOptions {
  readonly version: string;
  readonly repo: string;
  readonly baseBranch: string;
  readonly projectRoot: string;
  readonly expires: string | null;
  readonly promoteLatest: boolean;
  readonly resume: boolean;
  readonly summary: string | null;
}

function defaultReadiness(seams: ReleaseRunSeams, runGh: RunGhFn) {
  return (input: ReadinessInput): ReadinessResult =>
    runReleaseReadiness(
      input,
      {
        release: seams.release,
        tagFree: (v, repo, root) => checkTagAvailable(v, repo, root, seams.release ?? {}),
        dryRun: (i) =>
          runPipeline(
            {
              version: i.version,
              repo: i.repo,
              baseBranch: i.baseBranch,
              projectRoot: i.projectRoot,
              dryRun: true,
              skipTag: true,
              skipRelease: true,
              allowDirty: false,
              draft: true,
              skipCi: false,
              skipBuild: false,
              summary: i.summary,
              allowVbriefDrift: false,
              allowCoverageDebtIssue: null,
              allowSkipCiIssue: null,
            },
            seams.release ?? {},
          ),
      },
      runGh,
    );
}

/** Run (or resume) the phases. Returns the exit code of the phase that stopped, or 0. */
export function runReleaseRun(options: ReleaseRunOptions, seams: ReleaseRunSeams = {}): number {
  const out = seams.out ?? ((text: string) => process.stdout.write(text));
  const now = seams.now ?? (() => new Date());
  const { projectRoot, version } = options;
  const existing = readReleaseRunRecord(projectRoot, version);
  if (existing.kind === "invalid") {
    out(
      `release:run: error: run record ${releaseRunRecordPath(projectRoot, version)} is invalid: ${existing.reason}\n`,
    );
    return EXIT_CONFIG_ERROR;
  }
  let record: ReleaseRunRecord;
  if (options.resume) {
    if (existing.kind === "absent") {
      out(`release:run: error: no run record for ${version}; start a run without --resume\n`);
      return EXIT_CONFIG_ERROR;
    }
    record = existing.record;
    out(`release:run: resuming v${version} at phase ${String(nextReleaseRunPhase(record))}\n`);
  } else {
    if (existing.kind === "ok") {
      out(
        `release:run: error: a run record for ${version} exists (${releaseRunRecordPath(projectRoot, version)}); ` +
          "pass --resume to continue it\n",
      );
      return EXIT_CONFIG_ERROR;
    }
    const expires = options.expires;
    if (expires === null) {
      out(
        "release:run: error: --expires <ISO> is required (the operator chooses the grant expiry)\n",
      );
      return EXIT_CONFIG_ERROR;
    }
    const readiness = seams.readiness ?? defaultReadiness(seams, seams.runGh ?? defaultRunGh);
    const result = readiness({
      version,
      repo: options.repo,
      baseBranch: options.baseBranch,
      projectRoot,
      summary: options.summary,
    });
    out(formatReadiness(result));
    if (!result.ok) return EXIT_VIOLATION;
    record = markPhaseCompleted(
      newReleaseRunRecord({
        version,
        repo: options.repo,
        baseBranch: options.baseBranch,
        expires,
        promoteLatest: options.promoteLatest,
        summary: options.summary,
        ciReuseAtReadiness: result.ci.kind,
        now: now(),
      }),
      "readiness",
      now(),
    );
    writeReleaseRunRecord(projectRoot, record);
  }

  const ctx: Ctx = { record, projectRoot, seams, out, now };
  for (
    let phase = nextReleaseRunPhase(ctx.record);
    phase !== null;
    phase = nextReleaseRunPhase(ctx.record)
  ) {
    if (phase === "readiness") {
      out("release:run: error: the run record has no completed readiness; start a new run\n");
      return EXIT_CONFIG_ERROR;
    }
    const code = PHASES[phase](ctx);
    if (code !== EXIT_OK) {
      out(
        `release:run: stopped at ${phase}; run record ${releaseRunRecordPath(projectRoot, version)}\n`,
      );
      return code;
    }
    ctx.record = markPhaseCompleted(ctx.record, phase, now());
    writeReleaseRunRecord(projectRoot, ctx.record);
  }
  out(`${releaseRunFinalLines(version, ctx.record.baseBranch, projectRoot).join("\n")}\n`);
  return EXIT_OK;
}

function validExpiry(value: string, now: Date): string | null {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return `--expires ${value} is not an ISO date-time`;
  if (ms <= now.getTime()) return `--expires ${value} is not in the future`;
  return null;
}

export function cmdReleaseRun(args: readonly string[], seams: ReleaseRunSeams = {}): number {
  const flags = parseReleaseRunFlags(args);
  if (flags.help) {
    process.stdout.write(RELEASE_RUN_HELP);
    return EXIT_OK;
  }
  if (flags.unknown.length > 0) {
    process.stderr.write(
      `release:run: error: unrecognized arguments: ${flags.unknown.join(" ")}\n`,
    );
    return EXIT_CONFIG_ERROR;
  }
  if (flags.version === null) {
    process.stderr.write("release:run: error: the following arguments are required: version\n");
    return EXIT_CONFIG_ERROR;
  }
  try {
    validateReleaseChannelVersion(flags.version);
  } catch (err) {
    process.stderr.write(
      `release:run: error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return EXIT_CONFIG_ERROR;
  }
  // A stable cut only: the npm watch and promote phases accept X.Y.Z alone.
  if (isPrereleaseTag(flags.version)) {
    process.stderr.write(
      `release:run: error: ${flags.version} is a prerelease; release:run cuts stable X.Y.Z versions only (use task release for a prerelease)\n`,
    );
    return EXIT_CONFIG_ERROR;
  }
  if (!flags.resume && flags.expires !== null) {
    const problem = validExpiry(flags.expires, (seams.now ?? (() => new Date()))());
    if (problem !== null) {
      process.stderr.write(`release:run: error: ${problem}\n`);
      return EXIT_CONFIG_ERROR;
    }
  }
  const projectRoot = resolveProjectRoot(flags.projectRoot);
  const repo = resolveRepo(flags.repo, projectRoot, seams.release ?? {});
  return runReleaseRun(
    {
      version: flags.version,
      repo,
      baseBranch: flags.baseBranch,
      projectRoot,
      expires: flags.expires,
      promoteLatest: flags.promoteLatest,
      resume: flags.resume,
      summary: flags.summary,
    },
    seams,
  );
}
