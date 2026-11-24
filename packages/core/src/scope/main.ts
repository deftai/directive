import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { closerSetFromIssueIds } from "../one-pr-unit/closer-set.js";
import { evaluateOnePrUnit } from "../one-pr-unit/evaluate.js";
import { exactOriginSetEquals } from "../one-pr-unit/origin-set.js";
import { listOnePrUnitGrants } from "../one-pr-unit/store.js";
import {
  listActiveRunningBriefs,
  productPullRequestFromPlan,
} from "../orphan-active/running-briefs.js";
import { storyIssueOfBrief } from "../pr-closing-keywords/story-issue.js";
import { defaultRunGh, fetchClosingIssuesReferences } from "../pr-protected-issues/gh.js";
import { githubOwnerRepoFromRemoteUrl } from "../release/closed-verb-gate.js";
import { runGit } from "../release/git.js";
import { releaseWorkClaimForBrief } from "../scm/work-claim.js";
import { maybeRunStalenessTickler } from "../staleness-tickler/run.js";
import { interceptHelp } from "../triage/help/index.js";
import { reconcileUmbrellas, renderUmbrellasReport } from "../vbrief-reconcile/umbrellas.js";
import { type StrictAxisAdvisoryVerb, strictAxisAdvisoryLines } from "./acceptance-evidence.js";
import { canonicalLogPath, readAll } from "./audit-log.js";
import { batchPromote } from "./batch-promote.js";
import { BIND_CLAUSE_ACTION, bindClauseOnBrief } from "./bind-clause.js";
import { checkoutHygieneWarningLines } from "./checkout-hygiene-warning.js";
import { CONFESS_ACTION, confessOnBrief } from "./confess.js";
import { TRANSITIONS } from "./constants.js";
import {
  type DeliveryEvidenceInput,
  defaultFetchPrPayload,
  discoverDeliveryEvidenceForComplete,
  type FetchClosingPrRefsFn,
  type FetchPrPayloadFn,
  isNonDeliveryDisposition,
  liveRunGh,
  type NonDeliveryDisposition,
  resolvePlanGithubIssueRef,
} from "./delivery-evidence.js";
import {
  batchDemote,
  DEFAULT_OLDER_THAN_DAYS,
  demoteOne,
  resolveDemoteFilePath,
  resolveFilePath,
  resolveProjectRootStrict,
} from "./demote.js";
import {
  completedPathForScopeMove,
  findOpenUmbrellaReferences,
  renderOpenUmbrellaWarning,
} from "./open-umbrella-warning.js";
import { resolveProjectRoot } from "./project-context.js";
import { promoteFromIssue } from "./promote-from-issue.js";
import { promotePath } from "./promote-path.js";
import { STAMP_EVIDENCE_ACTION, stampEvidenceOnBrief } from "./stamp-evidence.js";
import { runTransition, type TransitionOptions } from "./transition.js";
import {
  findByDecisionId,
  isAlreadyUndone,
  REVERSIBLE_ACTIONS,
  undoBatch,
  undoOne,
} from "./undo.js";

/** One active brief whose stamped product PR is already merged (#7252). */
export interface MergedActiveStory {
  readonly prNumber: number;
  readonly cohortId: string;
  readonly repository: string;
}

/** Result of the one-story complete slow-path gate (#7252). */
export type SlowPathCompleteGate =
  | { readonly refuse: false }
  | {
      readonly refuse: true;
      readonly message: string;
      readonly merged: readonly MergedActiveStory[];
    };

function resolveRepoForSlowPath(projectRoot: string): string | null {
  const fromEnv = (process.env.GH_REPO ?? process.env.GITHUB_REPOSITORY ?? "").trim();
  if (fromEnv.length > 0 && fromEnv.includes("/")) {
    return fromEnv;
  }
  const remote = runGit(projectRoot, ["remote", "get-url", "origin"]);
  if (remote.status !== 0) {
    return null;
  }
  return githubOwnerRepoFromRemoteUrl(remote.stdout.trim());
}

function cohortIdForPlan(
  plan: Record<string, unknown>,
  repo: string | null,
  briefPath?: string,
): string {
  if (repo !== null) {
    const issue = storyIssueOfBrief(plan, repo);
    if (issue !== null) {
      return String(issue);
    }
  }
  // Numeric plan.id is not a finalize --cohort issue selector; prefer brief path.
  const rel = (briefPath ?? "").replace(/\\/g, "/").replace(/^\.\//, "").trim();
  if (rel.length > 0) {
    return rel;
  }
  const planId = String(plan.id ?? "").trim();
  if (planId.length > 0 && !/^\d+$/.test(planId)) {
    return planId;
  }
  return "unknown";
}

function isMergedPrPayload(payload: Record<string, unknown>): boolean {
  const mergedAt = payload.merged_at;
  return typeof mergedAt === "string" && mergedAt.trim().length > 0;
}

/** Keep --repo with each PR so mixed-repository finalize commands stay valid. */
function formatSlowPathFinalizeMessage(merged: readonly MergedActiveStory[]): string {
  const byRepo = new Map<string, MergedActiveStory[]>();
  for (const row of merged) {
    const list = byRepo.get(row.repository) ?? [];
    list.push(row);
    byRepo.set(row.repository, list);
  }
  const commands: string[] = [];
  for (const [repo, rows] of [...byRepo.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const prList = [...new Set(rows.map((r) => r.prNumber))].sort((a, b) => a - b).join(",");
    const cohortList = [...new Set(rows.map((r) => r.cohortId))].sort().join(",");
    commands.push(
      `deft swarm:finalize-cohort -- --pr ${prList} --cohort ${cohortList} --repo ${repo}`,
    );
  }
  if (commands.length === 1) {
    return `slow-path: ${commands[0] ?? ""}`;
  }
  return `slow-path: mixed repositories — run separately:\n${commands
    .map((cmd) => `  ${cmd}`)
    .join("\n")}`;
}

/** Fetch/auth failures must fail closed; missing sole product PR does not. */
function isSlowPathDeliveryLookupIndeterminate(message: string): boolean {
  return /could not fetch|incomplete|could not finish|rate limit|network|gh auth|invalid repository/i.test(
    message,
  );
}

/**
 * Refuse one-story scope:complete when ≥2 active briefs already have a merged
 * product PR. Finalize-cohort and --in-pr stay allowed (#7252).
 * Unstamped briefs use delivery lookup, not related github-pr refs (#7258).
 */
export function evaluateSlowPathCompleteGate(args: {
  readonly projectRoot: string;
  readonly inPr?: boolean;
  readonly repository?: string | null;
  readonly fetchPrPayload?: FetchPrPayloadFn;
  readonly fetchClosingPrRefs?: FetchClosingPrRefsFn;
  readonly discoverDelivery?: typeof discoverDeliveryEvidenceForComplete;
  readonly listBriefs?: () => ReturnType<typeof listActiveRunningBriefs>;
}): SlowPathCompleteGate {
  if (args.inPr === true) {
    return { refuse: false };
  }
  const briefs = (args.listBriefs ?? (() => listActiveRunningBriefs(args.projectRoot)))();
  const fallbackRepo = (args.repository ?? resolveRepoForSlowPath(args.projectRoot) ?? "").trim();
  // liveRunGh: ghx can cache a PR as open after merge and under-count here.
  const fetchPr =
    args.fetchPrPayload ??
    ((prNumber, repository) =>
      defaultFetchPrPayload(prNumber, repository, liveRunGh(defaultRunGh)));
  const discover = args.discoverDelivery ?? discoverDeliveryEvidenceForComplete;
  const merged: MergedActiveStory[] = [];
  for (const brief of briefs) {
    const issueRef = resolvePlanGithubIssueRef(brief.plan);
    const repo = (issueRef?.repository ?? fallbackRepo).trim();
    if (repo.length === 0) {
      continue;
    }
    let prNumber = productPullRequestFromPlan(brief.plan);
    let prRepo = repo;
    // Unstamped: only a delivery lookup product PR counts — not related github-pr refs (#7258).
    if (prNumber === null) {
      const found = discover({
        projectRoot: args.projectRoot,
        plan: brief.plan,
        fetchPrPayload: fetchPr,
        fetchClosingPrRefs: args.fetchClosingPrRefs,
        verifier: "scope:complete",
      });
      if (!found.ok) {
        if (isSlowPathDeliveryLookupIndeterminate(found.message)) {
          return {
            refuse: true,
            merged: [],
            message: `slow-path: ${found.message}`,
          };
        }
        continue;
      }
      if (!found.discovered) {
        continue;
      }
      const evidence = found.evidence;
      const discoveredPr =
        evidence !== null &&
        evidence !== undefined &&
        typeof evidence.prNumber === "number" &&
        Number.isInteger(evidence.prNumber) &&
        evidence.prNumber > 0
          ? evidence.prNumber
          : null;
      if (discoveredPr === null) {
        continue;
      }
      const evidenceRepo =
        evidence !== null && evidence !== undefined && typeof evidence.repository === "string"
          ? evidence.repository.trim()
          : "";
      prNumber = discoveredPr;
      prRepo = evidenceRepo.length > 0 ? evidenceRepo : repo;
      // discover already proved merged delivery-base.
      merged.push({
        prNumber,
        cohortId: cohortIdForPlan(brief.plan, prRepo, brief.path),
        repository: prRepo,
      });
      continue;
    }
    const payload = fetchPr(prNumber, prRepo);
    if (payload === null) {
      return {
        refuse: true,
        merged: [],
        message:
          `slow-path: could not read merge state for product PR #${String(prNumber)} in ${prRepo}; ` +
          "retry after fixing gh auth, rate limit, or network",
      };
    }
    if (!isMergedPrPayload(payload)) {
      continue;
    }
    merged.push({
      prNumber,
      cohortId: cohortIdForPlan(brief.plan, prRepo, brief.path),
      repository: prRepo,
    });
  }
  if (merged.length < 2) {
    return { refuse: false };
  }
  return {
    refuse: true,
    merged,
    message: formatSlowPathFinalizeMessage(merged),
  };
}

/** Test seam so lifecycleMain can stub the #7252 gate without module-cycle spies. */
export const slowPathCompleteGateSeam = {
  evaluate: evaluateSlowPathCompleteGate,
};

export interface LifecycleArgs {
  action: string;
  file: string;
  projectRoot?: string;
  force?: boolean;
  batch?: boolean;
  batchFiles?: string[];
  /** Promote from triage-cache issue number (#1136). */
  fromIssue?: number;
  /** Repo slug for --from-issue (#1136). */
  repo?: string;
  /** Missing decision hard-fails (#1136). */
  strict?: boolean;
  /** Skip triage reciprocity gate (#1136). */
  forceNoCache?: boolean;
  /** Disambiguate multiple proposed artifacts for --from-issue (#1136). */
  pathFlag?: string;
  /** Explicit non-delivery disposition for code-bearing complete (#3041). */
  nonDeliveryDisposition?: NonDeliveryDisposition;
  /** Optional delivery evidence flags for complete (#3041). */
  deliveryEvidence?: DeliveryEvidenceInput;
  /** Clause ids for scope:bind-clause (#4986). */
  clauseIds?: number[];
  /** In-PR completion for scope:complete (#6277). */
  inPr?: boolean;
  /** Sentences for scope:confess --sentence (#6644). */
  sentences?: string[];
  /** scope:confess --all-unmapped (#6644). */
  allUnmapped?: boolean;
}

export interface DemoteArgs {
  file?: string;
  batch?: boolean;
  olderThanDays?: number;
  reason?: string;
  projectRoot?: string;
  actor?: string;
}

export interface UndoArgs {
  decisionId?: string;
  decisionIdPositional?: string;
  batchId?: string;
  latest?: boolean;
  dryRun?: boolean;
  actor?: string;
  projectRoot?: string;
}

/**
 * Strict-axis advisory for a brief on disk (#6272). Best-effort: an unreadable
 * or malformed brief yields no lines. Never changes an exit code. The verb
 * picks the last line (#6591).
 */
function briefStrictAxisAdvisory(
  path: string,
  verb: Exclude<StrictAxisAdvisoryVerb, "xbrief:preflight">,
): string[] {
  try {
    return strictAxisAdvisoryLines(JSON.parse(readFileSync(path, "utf8")) as unknown, verb);
  } catch {
    return [];
  }
}

function writeLines(lines: readonly string[]): void {
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
}

const LIFECYCLE_USAGE_STDERR =
  "usage: deft scope:<action> [file] [--batch] [--from-issue N] [--repo OWNER/NAME]\n" +
  "                          [--force] [--project-root PATH] [--strict] [--force-no-cache]\n" +
  "                          [--path PATH]\n" +
  "  complete also accepts: --merge-commit SHA --pr N [--pr-base BRANCH] [--delivery-branch BRANCH]\n" +
  "  complete --in-pr completes the story inside its last product PR (lands-with-product; #6277)\n" +
  "  stamp-evidence is evidence-only: no --pr / --merge-commit / disposition argv (#4840)\n" +
  "  bind-clause binds selected --clause ids onto --path under file_scope (#4986)\n" +
  '  confess writes --sentence "<text>" (repeatable) or --all-unmapped to acceptance.confessions (#6644)\n' +
  "  actions: activate, bind-clause, block, cancel, complete, confess, fail, promote, restore, stamp-evidence, unblock\n" +
  "The verb already encodes the action (e.g. deft scope:promote <file>). Do not pass the action again.\n" +
  "(promote --batch may omit file and promotes all proposed/ scopes; #3011)\n" +
  "(promote --from-issue=N may omit file; #1136)\n" +
  "(complete auto-discovers delivery evidence from productPullRequest or a singleton closing PR when --pr/--merge-commit are omitted; #3041 / #3583)\n";

function parseLifecycleArgv(argv: string[]): { args: LifecycleArgs | null; error?: string } {
  if (argv.length < 1) {
    return { args: null, error: "usage" };
  }
  const action = argv[0] ?? "";
  if (
    !(action in TRANSITIONS) &&
    action !== STAMP_EVIDENCE_ACTION &&
    action !== BIND_CLAUSE_ACTION &&
    action !== CONFESS_ACTION
  ) {
    return { args: null, error: "usage" };
  }
  let file = "";
  let projectRoot: string | undefined;
  let force = false;
  let batch = false;
  const batchFiles: string[] = [];
  let fromIssue: number | undefined;
  let strict = false;
  let forceNoCache = false;
  let pathFlag: string | undefined;
  const clauseIds: number[] = [];
  const sentences: string[] = [];
  let allUnmapped = false;
  let nonDeliveryDisposition: NonDeliveryDisposition | undefined;
  let prNumber: number | undefined;
  let mergeCommit: string | undefined;
  let prBase: string | undefined;
  let deliveryBranch: string | undefined;
  let repo: string | undefined;
  let mergedAt: string | undefined;
  let inPr = false;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) {
      return { args: null, error: "usage" };
    }
    if (arg === "--") continue;
    if (arg === "--in-pr") {
      inPr = true;
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--batch") {
      batch = true;
    } else if (arg === "--strict") {
      strict = true;
    } else if (arg === "--force-no-cache") {
      forceNoCache = true;
    } else if (arg === "--all-unmapped") {
      allUnmapped = true;
    } else if (arg === "--sentence") {
      const raw = argv[i + 1];
      i += 1;
      if (raw === undefined || raw.trim().length === 0) {
        return { args: null, error: "usage" };
      }
      sentences.push(raw);
    } else if (arg?.startsWith("--sentence=")) {
      const raw = arg.slice("--sentence=".length);
      if (raw.trim().length === 0) {
        return { args: null, error: "usage" };
      }
      sentences.push(raw);
    } else if (arg === "--clause") {
      const raw = argv[i + 1];
      i += 1;
      if (raw === undefined || !/^[1-9]\d*(?:,[1-9]\d*)*$/.test(raw)) {
        return { args: null, error: "usage" };
      }
      for (const part of raw.split(",")) {
        clauseIds.push(Number.parseInt(part, 10));
      }
    } else if (arg?.startsWith("--clause=")) {
      const raw = arg.slice("--clause=".length);
      if (!/^[1-9]\d*(?:,[1-9]\d*)*$/.test(raw)) {
        return { args: null, error: "usage" };
      }
      for (const part of raw.split(",")) {
        clauseIds.push(Number.parseInt(part, 10));
      }
    } else if (arg === "--from-issue") {
      const raw = argv[i + 1];
      i += 1;
      if (raw === undefined || !/^[1-9]\d*$/.test(raw)) {
        return { args: null, error: "usage" };
      }
      fromIssue = Number.parseInt(raw, 10);
    } else if (arg?.startsWith("--from-issue=")) {
      const raw = arg.slice("--from-issue=".length);
      if (!/^[1-9]\d*$/.test(raw)) {
        return { args: null, error: "usage" };
      }
      fromIssue = Number.parseInt(raw, 10);
    } else if (arg === "--path") {
      pathFlag = argv[i + 1];
      i += 1;
      if (pathFlag === undefined) {
        return { args: null, error: "usage" };
      }
    } else if (arg?.startsWith("--path=")) {
      pathFlag = arg.slice("--path=".length);
    } else if (arg === "--project-root") {
      projectRoot = argv[i + 1];
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--non-delivery" || arg === "--non-delivery-disposition") {
      const raw = argv[i + 1];
      i += 1;
      if (raw === undefined || !isNonDeliveryDisposition(raw)) {
        return { args: null, error: "usage" };
      }
      nonDeliveryDisposition = raw;
    } else if (arg?.startsWith("--non-delivery=")) {
      const raw = arg.slice("--non-delivery=".length);
      if (!isNonDeliveryDisposition(raw)) {
        return { args: null, error: "usage" };
      }
      nonDeliveryDisposition = raw;
    } else if (arg === "--pr" && argv[i + 1] !== undefined) {
      prNumber = Number.parseInt(argv[i + 1] ?? "", 10);
      i += 1;
    } else if (arg?.startsWith("--pr=")) {
      prNumber = Number.parseInt(arg.slice("--pr=".length), 10);
    } else if (arg === "--merge-commit" && argv[i + 1] !== undefined) {
      mergeCommit = argv[i + 1];
      i += 1;
    } else if (arg?.startsWith("--merge-commit=")) {
      mergeCommit = arg.slice("--merge-commit=".length);
    } else if (arg === "--pr-base" && argv[i + 1] !== undefined) {
      prBase = argv[i + 1];
      i += 1;
    } else if (arg?.startsWith("--pr-base=")) {
      prBase = arg.slice("--pr-base=".length);
    } else if (arg === "--delivery-branch" && argv[i + 1] !== undefined) {
      deliveryBranch = argv[i + 1];
      i += 1;
    } else if (arg?.startsWith("--delivery-branch=")) {
      deliveryBranch = arg.slice("--delivery-branch=".length);
    } else if (arg === "--repo" && argv[i + 1] !== undefined) {
      repo = argv[i + 1];
      i += 1;
    } else if (arg?.startsWith("--repo=")) {
      repo = arg.slice("--repo=".length);
    } else if (arg === "--merged-at" && argv[i + 1] !== undefined) {
      mergedAt = argv[i + 1];
      i += 1;
    } else if (arg?.startsWith("--merged-at=")) {
      mergedAt = arg.slice("--merged-at=".length);
    } else if (!arg.startsWith("-")) {
      if (batch) {
        batchFiles.push(arg);
      } else if (file.length === 0) {
        file = arg;
      } else {
        return { args: null, error: "usage" };
      }
    } else {
      return { args: null, error: "usage" };
    }
  }
  // Delivery evidence uses --repo as repository; --from-issue also uses --repo as triage slug.
  // Prefer treating --repo as triage slug when --from-issue is set (#1136).
  const deliveryEvidence: DeliveryEvidenceInput | undefined =
    prNumber !== undefined ||
    mergeCommit !== undefined ||
    prBase !== undefined ||
    deliveryBranch !== undefined ||
    (repo !== undefined && fromIssue === undefined) ||
    mergedAt !== undefined
      ? {
          prNumber: prNumber !== undefined && Number.isFinite(prNumber) ? prNumber : null,
          mergeCommit: mergeCommit ?? null,
          prBase: prBase ?? null,
          deliveryBranch: deliveryBranch ?? null,
          repository: fromIssue === undefined ? (repo ?? null) : null,
          mergedAt: mergedAt ?? (mergeCommit !== undefined ? "supplied" : null),
          verifier: "scope:complete",
        }
      : undefined;
  // #6277: --in-pr is a scope:complete mode with no merge evidence or disposition.
  if (
    inPr &&
    (action !== "complete" ||
      batch ||
      fromIssue !== undefined ||
      deliveryEvidence !== undefined ||
      nonDeliveryDisposition !== undefined)
  ) {
    return { args: null, error: "usage" };
  }
  if (batch) {
    if (action !== "promote") {
      return { args: null, error: "usage" };
    }
    return {
      args: {
        action,
        file: file.length > 0 ? file : "",
        projectRoot,
        force,
        batch: true,
        batchFiles: batchFiles.length > 0 ? batchFiles : file.length > 0 ? [file] : [],
      },
    };
  }
  if (fromIssue !== undefined) {
    if (action !== "promote") {
      return { args: null, error: "usage" };
    }
    if (Number.isNaN(fromIssue) || fromIssue < 1) {
      return { args: null, error: "usage" };
    }
    return {
      args: {
        action,
        file: file.length > 0 ? file : (pathFlag ?? ""),
        projectRoot,
        force,
        fromIssue,
        repo,
        strict,
        forceNoCache,
        pathFlag: pathFlag ?? (file.length > 0 ? file : undefined),
      },
    };
  }
  if (file.length === 0) {
    return { args: null, error: "usage" };
  }
  if (action === CONFESS_ACTION) {
    if (
      deliveryEvidence !== undefined ||
      nonDeliveryDisposition !== undefined ||
      clauseIds.length > 0 ||
      pathFlag !== undefined ||
      (sentences.length === 0 && !allUnmapped)
    ) {
      return { args: null, error: "usage" };
    }
    return { args: { action, file, projectRoot, force, sentences, allUnmapped } };
  }
  if (sentences.length > 0 || allUnmapped) {
    return { args: null, error: "usage" };
  }
  if (action === STAMP_EVIDENCE_ACTION) {
    if (
      deliveryEvidence !== undefined ||
      nonDeliveryDisposition !== undefined ||
      clauseIds.length > 0 ||
      pathFlag !== undefined
    ) {
      return { args: null, error: "usage" };
    }
    return {
      args: {
        action,
        file,
        projectRoot,
        force,
      },
    };
  }
  if (action === BIND_CLAUSE_ACTION) {
    if (
      deliveryEvidence !== undefined ||
      nonDeliveryDisposition !== undefined ||
      pathFlag === undefined ||
      clauseIds.length === 0
    ) {
      return { args: null, error: "usage" };
    }
    return {
      args: {
        action,
        file,
        projectRoot,
        force,
        pathFlag,
        clauseIds,
      },
    };
  }
  if (clauseIds.length > 0) {
    return { args: null, error: "usage" };
  }
  return {
    args: {
      action,
      file,
      projectRoot,
      force,
      nonDeliveryDisposition,
      deliveryEvidence,
      ...(inPr ? { inPr: true } : {}),
    },
  };
}

/** Main entry for scope_lifecycle.py parity. */
export function lifecycleMain(argv: string[]): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    const helpRc = interceptHelp("scope_lifecycle", argv);
    if (helpRc !== null) {
      return helpRc;
    }
    process.stdout.write(LIFECYCLE_USAGE_STDERR);
    return 0;
  }
  const parsed = parseLifecycleArgv(argv);
  if (parsed.args === null) {
    if (parsed.error === "usage") {
      process.stderr.write(LIFECYCLE_USAGE_STDERR);
    }
    return 2;
  }
  const {
    action,
    file,
    projectRoot,
    force,
    batch,
    batchFiles,
    fromIssue,
    repo,
    strict,
    forceNoCache,
    pathFlag,
    clauseIds,
    nonDeliveryDisposition,
    deliveryEvidence,
    inPr,
    sentences,
    allUnmapped,
  } = parsed.args;

  if (batch === true && action === "promote") {
    const result = batchPromote({
      files: batchFiles && batchFiles.length > 0 ? batchFiles : undefined,
      force: force === true,
      projectRoot,
    });
    for (const line of result.messages) {
      process.stdout.write(`${line}\n`);
    }
    for (const line of result.skipped) {
      process.stdout.write(`  skipped: ${line}\n`);
    }
    if (!result.ok && result.exitCode !== 0) {
      for (const line of result.messages) {
        if (line.startsWith("ERROR:") || line.includes("WIP cap")) {
          process.stderr.write(`${line}\n`);
        }
      }
    }
    return result.exitCode;
  }

  if (fromIssue !== undefined && action === "promote") {
    const result = promoteFromIssue({
      issueNumber: fromIssue,
      repo: repo ?? null,
      projectRoot,
      force: force === true,
      forceNoCache: forceNoCache === true,
      strict: strict === true,
      explicitPath: pathFlag,
    });
    for (const line of result.warnings) {
      process.stderr.write(`${line}\n`);
    }
    if (result.ok) {
      process.stdout.write(`${result.message}\n`);
      if (result.wipCapOverride) {
        process.stderr.write(
          "\u26a0  WIP cap exceeded; promote allowed via --force. " +
            "audit: scope-lifecycle.jsonl entry tagged wip_cap_override (#1124).\n",
        );
      }
      return 0;
    }
    process.stderr.write(`Error: ${result.message}\n`);
    return result.exitCode;
  }

  const [filePath, error] = resolveFilePath(file, projectRoot);
  if (error !== null || filePath === null) {
    process.stderr.write(`Error: ${error}\n`);
    return 2;
  }

  if (action === STAMP_EVIDENCE_ACTION) {
    const stamped = stampEvidenceOnBrief(filePath, { projectRoot });
    if (stamped.ok) {
      process.stdout.write(`${stamped.message}\n`);
      return 0;
    }
    process.stderr.write(`Error: ${stamped.message}\n`);
    return 1;
  }

  if (action === BIND_CLAUSE_ACTION) {
    const bound = bindClauseOnBrief(filePath, {
      projectRoot,
      path: pathFlag ?? "",
      clauseIds: clauseIds ?? [],
    });
    if (bound.ok) {
      process.stdout.write(`${bound.message}\n`);
      return 0;
    }
    process.stderr.write(`Error: ${bound.message}\n`);
    return 1;
  }

  if (action === CONFESS_ACTION) {
    const confessed = confessOnBrief(filePath, {
      projectRoot,
      sentences: sentences ?? [],
      allUnmapped: allUnmapped === true,
    });
    if (confessed.ok) {
      process.stdout.write(`${confessed.message}\n`);
      return 0;
    }
    process.stderr.write(`Error: ${confessed.message}\n`);
    return 1;
  }

  // Path-based promote uses shared promotePath for WIP + optional audit consistency (#1136).
  if (action === "promote") {
    const promoteResult = promotePath(filePath, {
      projectRoot,
      force: force === true,
    });
    if (promoteResult.ok) {
      process.stdout.write(`${promoteResult.message}\n`);
      if (promoteResult.wipCapOverride) {
        process.stderr.write(
          "\u26a0  WIP cap exceeded " +
            `(promote allowed via --force). ` +
            "audit: scope-lifecycle.jsonl entry tagged wip_cap_override (#1124).\n",
        );
      }
      // #6272: advisory only; read the promoted brief (promote may stamp clauses).
      writeLines(briefStrictAxisAdvisory(promoteResult.destPath ?? filePath, "scope:promote"));
      return 0;
    }
    process.stderr.write(
      promoteResult.exitCode === 1 && promoteResult.message.includes("WIP")
        ? `${promoteResult.message}\n`
        : `Error: ${promoteResult.message}\n`,
    );
    return promoteResult.exitCode;
  }

  if (action === "complete" && deliveryEvidence?.prNumber) {
    const rootForUnit = resolveProjectRoot(projectRoot) ?? dirname(dirname(dirname(filePath)));
    const repo = deliveryEvidence.repository;
    if (repo !== null && repo !== undefined && repo.length > 0) {
      try {
        const linked = fetchClosingIssuesReferences(deliveryEvidence.prNumber, repo, defaultRunGh);
        if (linked === null) {
          process.stderr.write(
            "Error: could not read closing-issue references for one-PR-unit recheck. " +
              "Retry after fixing gh auth, rate limit, or network.\n",
          );
          return 1;
        }
        const closerSet = closerSetFromIssueIds(repo, linked);
        const grant =
          listOnePrUnitGrants(rootForUnit).find((g) =>
            exactOriginSetEquals(g.origins, closerSet),
          ) ?? null;
        const unit = evaluateOnePrUnit({
          closerSet,
          grant,
          binding: { repo },
        });
        if (!unit.ok) {
          process.stderr.write(`Error: ${unit.message}\n`);
          return 1;
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: one-PR-unit recheck failed: ${message}\n`);
        return 1;
      }
    }
  }
  if (action === "complete" && inPr !== true) {
    const rootForSlowPath = resolveProjectRoot(projectRoot) ?? dirname(dirname(dirname(filePath)));
    const slowPath = slowPathCompleteGateSeam.evaluate({
      projectRoot: rootForSlowPath,
      inPr: false,
    });
    if (slowPath.refuse) {
      process.stderr.write(`${slowPath.message}\n`);
      return 1;
    }
  }
  const transitionOptions: TransitionOptions = {
    nonDeliveryDisposition,
    deliveryEvidence,
    verifier: "scope:complete",
    ...(inPr === true ? { inPr: true } : {}),
    // #6645: only this command entry opens the part-line route: a merged
    // `deft-story-part: N` PR that is the story's only product part may
    // complete through an operator attestation after the sibling check.
    // Finalize, completeCohort and the in-PR tip proof leave it off.
    ...(action === "complete" ? { partLineAttestation: true } : {}),
  };
  // #6272: read before the move; activate does not change item text.
  const activateAdvisory =
    action === "activate" ? briefStrictAxisAdvisory(filePath, "scope:activate") : [];
  const result = runTransition(action, filePath, new Date(), transitionOptions);
  if (result.ok) {
    process.stdout.write(`${result.message}\n`);
    writeLines(activateAdvisory);
    if (action === "complete") {
      try {
        const completedPath = completedPathForScopeMove(filePath);
        const rootForWarning =
          resolveProjectRoot(projectRoot) ?? dirname(dirname(dirname(completedPath)));
        const refs = findOpenUmbrellaReferences(rootForWarning, completedPath);
        const warning = renderOpenUmbrellaWarning(refs);
        if (warning.length > 0) {
          process.stderr.write(`${warning}\n`);
          const [, outcome] = reconcileUmbrellas(rootForWarning);
          // Only surface a report when reconcile actually changed something or
          // recorded per-epic errors — skip vacuous setup failures (exit 2 with
          // empty buckets) so a missing lifecycle root does not spam stderr.
          if (outcome.changed.length > 0 || outcome.errors.length > 0) {
            process.stderr.write(`${renderUmbrellasReport(outcome)}\n`);
          }
        }
      } catch {
        /* best-effort drift warning + reconcile; lifecycle success remains authoritative */
      }
      try {
        const rootForTickler =
          resolveProjectRoot(projectRoot) ??
          dirname(dirname(dirname(completedPathForScopeMove(filePath))));
        const tickler = maybeRunStalenessTickler(rootForTickler);
        for (const line of tickler.lines) {
          process.stdout.write(`${line}\n`);
        }
      } catch {
        /* best-effort staleness tickler; lifecycle success remains authoritative */
      }
      try {
        const completedPath = completedPathForScopeMove(filePath);
        const rootForClaim =
          resolveProjectRoot(projectRoot) ?? dirname(dirname(dirname(completedPath)));
        const released = releaseWorkClaimForBrief(completedPath, {
          cwd: rootForClaim,
          occupancyLive: () => true,
        });
        if (released.message.length > 0) {
          process.stdout.write(`${released.message}\n`);
        }
      } catch {
        /* best-effort work-claim release; lifecycle success remains authoritative */
      }
      try {
        // #5988: warn-only checkout hygiene lines (linked worktrees, local branches).
        const rootForHygiene =
          resolveProjectRoot(projectRoot) ??
          dirname(dirname(dirname(completedPathForScopeMove(filePath))));
        for (const line of checkoutHygieneWarningLines(rootForHygiene)) {
          process.stderr.write(`${line}\n`);
        }
      } catch {
        /* best-effort hygiene warning; lifecycle success remains authoritative */
      }
    }
    return 0;
  }
  process.stderr.write(`Error: ${result.message}\n`);
  return 1;
}

function parseDemoteArgv(argv: string[]): { args: DemoteArgs | null; error?: string } {
  const args: DemoteArgs = { reason: "operator-requested" };
  let positional = "";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) {
      return { args: null, error: "usage" };
    }
    if (arg === "--batch") {
      args.batch = true;
    } else if (arg === "--older-than-days") {
      args.olderThanDays = Number(argv[i + 1]);
      i += 1;
    } else if (arg?.startsWith("--older-than-days=")) {
      args.olderThanDays = Number(arg.slice("--older-than-days=".length));
    } else if (arg === "--reason") {
      args.reason = argv[i + 1];
      i += 1;
    } else if (arg?.startsWith("--reason=")) {
      args.reason = arg.slice("--reason=".length);
    } else if (arg === "--project-root") {
      args.projectRoot = argv[i + 1];
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      args.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--actor") {
      args.actor = argv[i + 1];
      i += 1;
    } else if (!arg.startsWith("-") && positional.length === 0) {
      positional = arg;
    } else {
      return { args: null, error: "usage" };
    }
  }
  if (args.batch === true) {
    return { args };
  }
  if (positional.length === 0) {
    return { args: null, error: "usage" };
  }
  args.file = positional;
  return { args };
}

/** Main entry for scope_demote.py parity (included in lifecycle family). */
export function demoteMain(argv: string[]): number {
  const parsed = parseDemoteArgv(argv);
  if (parsed.args === null) {
    process.stderr.write("usage: scope_demote.py <file> [--reason TEXT] [--project-root PATH]\n");
    return 2;
  }
  const args = parsed.args;
  if (args.batch === true) {
    const [root, err] = resolveProjectRootStrict(args.projectRoot);
    if (err !== null || root === null) {
      process.stderr.write(`Error: ${err}\n`);
      return 2;
    }
    const olderThan = args.olderThanDays ?? DEFAULT_OLDER_THAN_DAYS;
    const [demoted, _entries, skipped] = batchDemote(root, olderThan, { actor: args.actor });
    process.stdout.write(
      `Batch demote: ${demoted} demoted, ${skipped.length} skipped (older-than-days=${olderThan}).\n`,
    );
    for (const line of skipped) {
      process.stdout.write(`  skipped: ${line}\n`);
    }
    return 0;
  }
  const [filePath, error] = resolveDemoteFilePath(args.file ?? "", args.projectRoot);
  if (error !== null || filePath === null) {
    process.stderr.write(`Error: ${error}\n`);
    return 2;
  }
  const [root, rootErr] = resolveProjectRootStrict(args.projectRoot);
  if (rootErr !== null || root === null) {
    process.stderr.write(`Error: ${rootErr}\n`);
    return 2;
  }
  const result = demoteOne(filePath, root, args.reason ?? "operator-requested", {
    actor: args.actor,
  });
  if (result.ok) {
    process.stdout.write(`${result.message}\n`);
    return 0;
  }
  process.stderr.write(`Error: ${result.message}\n`);
  return 1;
}

function parseUndoArgv(argv: string[]): { args: UndoArgs | null; error?: string; mutex?: string } {
  const args: UndoArgs = { actor: "operator" };
  let positional = "";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) {
      return { args: null, error: "usage" };
    }
    if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--latest") {
      args.latest = true;
    } else if (arg === "--decision-id") {
      args.decisionId = argv[i + 1];
      i += 1;
    } else if (arg?.startsWith("--decision-id=")) {
      args.decisionId = arg.slice("--decision-id=".length);
    } else if (arg === "--batch-id") {
      args.batchId = argv[i + 1];
      i += 1;
    } else if (arg?.startsWith("--batch-id=")) {
      args.batchId = arg.slice("--batch-id=".length);
    } else if (arg === "--project-root") {
      args.projectRoot = argv[i + 1];
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      args.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--actor") {
      args.actor = argv[i + 1];
      i += 1;
    } else if (!arg.startsWith("-") && positional.length === 0) {
      positional = arg;
    } else {
      return { args: null, error: "usage" };
    }
  }
  if (positional.length > 0) {
    args.decisionIdPositional = positional;
  }
  const decisionId = args.decisionId ?? args.decisionIdPositional;
  if (decisionId !== undefined && args.batchId !== undefined) {
    return {
      args: null,
      mutex:
        "Error: --decision-id (or positional <decision_id>) is mutually exclusive with --batch-id.",
    };
  }
  if (
    args.decisionIdPositional !== undefined &&
    args.decisionId !== undefined &&
    args.decisionIdPositional !== args.decisionId
  ) {
    return {
      args: null,
      mutex:
        `Error: positional <decision_id> conflicts with --decision-id ` +
        `('${args.decisionIdPositional}' vs '${args.decisionId}').`,
    };
  }
  if (args.latest === true && (decisionId !== undefined || args.batchId !== undefined)) {
    return {
      args: null,
      mutex:
        "Error: --latest is mutually exclusive with --decision-id, --batch-id, and the positional <decision_id>.",
    };
  }
  if (decisionId === undefined && args.batchId === undefined && args.latest !== true) {
    return {
      args: null,
      mutex:
        "Error: provide a <decision_id> (positional or --decision-id), --batch-id, or --latest.",
    };
  }
  if (decisionId !== undefined) {
    args.decisionId = decisionId;
  }
  return { args };
}

/** Main entry for scope_undo.py parity. */
export function undoMain(argv: string[]): number {
  const parsed = parseUndoArgv(argv);
  if (parsed.mutex !== undefined) {
    process.stderr.write(`${parsed.mutex}\n`);
    return 2;
  }
  if (parsed.args === null) {
    process.stderr.write("usage: scope_undo.py <decision_id> [--dry-run] [--project-root PATH]\n");
    return 2;
  }
  const args = parsed.args;
  const [root, err] = resolveProjectRootStrict(args.projectRoot);
  if (err !== null || root === null) {
    process.stderr.write(`Error: ${err}\n`);
    return 2;
  }
  const logPath = canonicalLogPath(root);
  if (!existsSync(logPath)) {
    process.stderr.write(`Error: audit log not found at ${logPath}. Nothing to undo.\n`);
    return 1;
  }

  if (args.batchId !== undefined) {
    const [undone, _entries, skipped, previews] = undoBatch(args.batchId, root, {
      actor: args.actor,
      logPath,
      dryRun: args.dryRun,
    });
    if (undone === 0 && skipped.length > 0 && skipped[0]?.startsWith("No audit entries")) {
      process.stderr.write(`${skipped[0]}\n`);
      return 1;
    }
    const prefix = args.dryRun === true ? "DRY-RUN: " : "";
    process.stdout.write(
      `${prefix}Batch undo: ${undone} reversed, ${skipped.length} skipped (batch_id=${args.batchId}).\n`,
    );
    for (const line of previews) {
      process.stdout.write(`  preview: ${line}\n`);
    }
    for (const line of skipped) {
      process.stdout.write(`  skipped: ${line}\n`);
    }
    return 0;
  }

  const logEntries = readAll(logPath);
  let decisionId = args.decisionId;
  if (args.latest === true) {
    let candidate: Record<string, unknown> | null = null;
    for (let i = logEntries.length - 1; i >= 0; i -= 1) {
      const entry = logEntries[i];
      if (entry === undefined) {
        continue;
      }
      const action = entry.action;
      if (typeof action !== "string" || !REVERSIBLE_ACTIONS.has(action)) {
        continue;
      }
      const entryId = entry.decision_id;
      if (typeof entryId !== "string") {
        continue;
      }
      if (isAlreadyUndone(entryId, logEntries)) {
        continue;
      }
      candidate = entry;
      break;
    }
    if (candidate === null) {
      process.stderr.write(
        "Error: --latest found no reversible audit entry (demote / cancel / restore / undo) that has not already been undone.\n",
      );
      return 1;
    }
    decisionId = String(candidate.decision_id);
    if (decisionId.length === 0) {
      process.stderr.write("Error: --latest candidate is missing a decision_id.\n");
      return 1;
    }
  }

  const entry = findByDecisionId(decisionId ?? "", logEntries);
  if (entry === null) {
    process.stderr.write(`Error: no audit entry found with decision_id=${decisionId}.\n`);
    return 1;
  }
  const result = undoOne(entry, root, {
    actor: args.actor,
    logPath,
    dryRun: args.dryRun,
    logEntries,
  });
  if (result.ok) {
    process.stdout.write(`${result.message}\n`);
    return 0;
  }
  process.stderr.write(`Error: ${result.message}\n`);
  return 1;
}
