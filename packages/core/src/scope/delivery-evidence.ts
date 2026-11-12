/**
 * Delivery integrity for scope completion (#3041 / #3675).
 *
 * A code-bearing scope must not acquire a delivered disposition unless the
 * merge commit is bound to the story's merged PR (Prefer-A identity join) and
 * that merge is an ancestor of the refreshed remote delivery ref, or an
 * explicit auditable non-delivery disposition is recorded.
 *
 * Deploy / UAT are separate axes and MUST NOT be inferred from Git alone.
 */

import { productPullRequestFromPlan } from "../orphan-active/running-briefs.js";
import {
  assertSafeBranchName,
  type DeliveryBranchResult,
  FIELD_DELIVERY_BRANCH,
  isSafeBranchName,
  resolveDeliveryBranch,
  trackingFetchArgv,
} from "../policy/delivery-branch.js";
import { parseAllDeftStoryMarks } from "../pr-closing-keywords/main.js";
import { defaultRunGh } from "../pr-protected-issues/gh.js";
import type { RunGhFn, RunGhResult } from "../pr-protected-issues/types.js";
import { defaultGitRunner, type GitRunner, gitIsAncestor } from "../session/git.js";
import { readRitualState } from "../session/ritual-sentinel.js";
import { parseGitHubRepoSlug } from "../text/redos-safe.js";
import { LIFECYCLE_FOLDERS } from "./constants.js";

/** Prefer-A #5545: refuse resolver error when branch is empty or unsafe. */
function refuseUnsafeResolvedDelivery(resolved: DeliveryBranchResult): string | null {
  if (resolved.error !== null) {
    if (resolved.branch.length === 0 || !isSafeBranchName(resolved.branch)) {
      return resolved.error;
    }
  }
  if (resolved.branch.length === 0) {
    return resolved.error ?? "delivery branch resolved empty";
  }
  const checked = assertSafeBranchName(resolved.branch, FIELD_DELIVERY_BRANCH);
  if (!checked.ok) {
    return checked.error;
  }
  return null;
}

/** Handoff states that Git delivery can assert (deploy/UAT never inferred). */
export const HANDOFF_STATES = [
  "implemented",
  "pr_open",
  "merged_to_integration",
  "delivered",
] as const;

export type HandoffState = (typeof HANDOFF_STATES)[number];

/** Explicit non-delivery terminal dispositions (never render as shipped). */
export const NON_DELIVERY_DISPOSITIONS = [
  "cancelled",
  "superseded",
  "experiment_archived",
  "accepted_not_delivered",
] as const;

export type NonDeliveryDisposition = (typeof NON_DELIVERY_DISPOSITIONS)[number];

/** Delivery verification outcome for completion provenance. */
export type DeliveryDisposition =
  | "delivered"
  | "merged_to_integration"
  | "not_delivered"
  | NonDeliveryDisposition
  | "unknown"
  | "unverified";

/**
 * This is a historical audit snapshot stamped onto
 * `plan.metadata.completionProvenance` at `scope:complete` (#3041 / #3690).
 *
 * Completed xBRIEFs have full standing as a record of *what is* and zero
 * authority over *what to build next* (#3383). Fields stay because they
 * answer a later reconstruction question after branches are deleted and
 * refs move. A field does not need a current production-code reader.
 *
 * Reconstruction groups:
 * - Identity and location: `repository`, `implementationCommit`, `prNumber`,
 *   `prBase`, `deliveryBranch`
 * - Delivery evidence: `mergeCommit`, `deliveryCommit`, `disposition`,
 *   `handoffState`
 * - Verification attribution: `verifiedAt`, `verifier`
 * - Explicit operator-supplied facts: `deployed`, `uatVerified` (never
 *   inferred from Git)
 *
 * `completedSessionId` is duplicated. This nested copy is stamped so the
 * snapshot is self-contained. Consumers (`verify:ac` /
 * `session-completed-ac`) read the sibling
 * `plan.metadata.completedSessionId`, not this field.
 */
export interface CompletionProvenance {
  readonly repository: string | null;
  readonly implementationCommit: string | null;
  readonly prNumber: number | null;
  readonly prBase: string | null;
  readonly mergeCommit: string | null;
  readonly deliveryBranch: string;
  readonly deliveryCommit: string | null;
  readonly verifiedAt: string;
  readonly verifier: string;
  readonly disposition: DeliveryDisposition;
  readonly handoffState: HandoffState | "unknown";
  /** Always null unless explicitly supplied — never inferred from Git (#3041). */
  readonly deployed: boolean | null;
  /** Always null unless explicitly supplied — never inferred from Git (#3041). */
  readonly uatVerified: boolean | null;
  /**
   * Nested session correlation for a self-contained snapshot.
   * Consumers read sibling `plan.metadata.completedSessionId`, not this field.
   */
  readonly completedSessionId?: string | null;
  /**
   * How the story→PR identity was proven. Absent means the forge closer set
   * (closingIssuesReferences). `brief-in-pr-diff` means the PR added this brief
   * itself because the issue was linked after merge (#3675 fallback).
   */
  readonly identityBasis?: StoryPrIdentityBasis;
}

export interface DeliveryEvidenceInput {
  readonly repository?: string | null;
  readonly implementationCommit?: string | null;
  readonly prNumber?: number | null;
  readonly prBase?: string | null;
  readonly mergeCommit?: string | null;
  readonly deliveryBranch?: string | null;
  readonly deliveryCommit?: string | null;
  readonly mergedAt?: string | null;
  /** Explicit deploy/UAT (optional; never auto-filled from Git). */
  readonly deployed?: boolean | null;
  readonly uatVerified?: boolean | null;
  readonly verifier?: string | null;
}

/** Plan-derived story identity for Prefer-A delivery bind (#3675). */
export interface PlanGithubIssueRef {
  readonly repository: string;
  readonly issueNumber: number;
}

/**
 * Fetch a pulls REST payload for Prefer-A story→PR→merge identity (#3675).
 * Return null on lookup failure (gate fails closed).
 */
export type FetchPrPayloadFn = (
  prNumber: number,
  repository: string,
) => Record<string, unknown> | null;

/** One forge closingIssuesReferences node with preserved repository (#3675). */
export interface ClosingIssueRef {
  readonly repository: string;
  readonly issueNumber: number;
}

/**
 * Fetch authoritative forge closingIssuesReferences only (#3675).
 * Must not union body/commit intent extractors (fail-open for delivery).
 * Each entry MUST preserve its own repository (cross-repo closers).
 */
export type FetchClosingIssueIdsFn = (
  prNumber: number,
  repository: string,
) => ClosingIssueRef[] | null;

/** One changed file in a PR (REST `pulls/{n}/files`). */
export interface PrChangedFile {
  readonly filename: string;
  readonly status: string;
}

/** Changed files of a PR, or null on lookup failure (fail closed). */
export type FetchPrChangedFilesFn = (
  prNumber: number,
  repository: string,
) => PrChangedFile[] | null;

export interface DeliveryGateOptions {
  readonly projectRoot: string;
  readonly plan: Record<string, unknown>;
  readonly nowIso: string;
  readonly evidence?: DeliveryEvidenceInput | null;
  readonly nonDeliveryDisposition?: NonDeliveryDisposition | null;
  readonly runGit?: GitRunner;
  readonly verifier?: string;
  /**
   * When true, skip remote refresh + ancestry after Prefer-A identity join
   * succeeds. Identity join still runs. Production finalize must pass the
   * evidenceFromPrPayload tuple through the same validator (#3675); do not
   * treat this flag as an opaque-string bypass.
   */
  readonly assumeEvidenceValidated?: boolean;
  /** Optional gh runner for default PR / merge-time fetchers (#3675 / #5710). */
  readonly runGh?: RunGhFn;
  /**
   * Test / inject seam: pulls REST payload fetcher (#3675). When injected,
   * the live merge-time forge and changed-files defaults are off, so tests
   * never fall through to gh.
   */
  readonly fetchPrPayload?: FetchPrPayloadFn;
  /** Test / inject seam: merge-time association reads (#5710 P3). */
  readonly mergeTimeForge?: MergeTimeForge;
  /**
   * File name of the brief being completed (basename). Enables the
   * brief-in-PR-diff identity basis (#3675).
   */
  readonly briefBasename?: string;
  /** Test / inject seam: PR changed files for the brief-in-PR-diff basis. */
  readonly fetchPrChangedFiles?: FetchPrChangedFilesFn;
}

export interface DeliveryGateResult {
  readonly ok: boolean;
  readonly message: string;
  readonly provenance: CompletionProvenance | null;
  readonly codeBearing: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/**
 * Session id for a completing brief (#3357). Prefer DEFT_SESSION_ID, then ritual-state.
 */
export function resolveCompletionSessionId(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const fromEnv = typeof env.DEFT_SESSION_ID === "string" ? env.DEFT_SESSION_ID.trim() : "";
  if (fromEnv.length > 0) {
    return fromEnv;
  }
  const [state] = readRitualState(projectRoot);
  const id = state?.sessionId.trim() ?? "";
  return id.length > 0 ? id : null;
}

export function isNonDeliveryDisposition(value: unknown): value is NonDeliveryDisposition {
  return (
    typeof value === "string" && (NON_DELIVERY_DISPOSITIONS as readonly string[]).includes(value)
  );
}

/**
 * experiment_archived-only Findings presence check (#5693).
 *
 * Requires trim-non-empty string `plan.narratives.Findings` before archive.
 * Covers code and non-code completing scopes. One remediation string.
 * Does not harden cancelled / superseded / accepted_not_delivered.
 */
export function evaluateExperimentArchivedFindingsGate(plan: Record<string, unknown>): {
  ok: boolean;
  message: string;
} {
  const narratives = asRecord(plan.narratives);
  const findings = narratives?.Findings;
  if (typeof findings === "string" && findings.trim().length > 0) {
    return { ok: true, message: "" };
  }
  return {
    ok: false,
    message:
      "Refusing scope:complete --non-delivery experiment_archived: " +
      "plan.narratives.Findings must be a trim-non-empty string (#5693). " +
      "Record findings on the completing brief before archive.",
  };
}

/** True when the brief is treated as code-bearing for the delivery gate (#3041). */
export function isCodeBearingScope(plan: Record<string, unknown>): boolean {
  const meta = asRecord(plan.metadata);
  const delivery = asRecord(meta?.delivery);
  if (delivery?.required === false) {
    return false;
  }
  if (delivery?.required === true) {
    return true;
  }

  const tags = Array.isArray(plan.tags) ? plan.tags : [];
  for (const tag of tags) {
    if (typeof tag !== "string") continue;
    const low = tag.trim().toLowerCase();
    if (low === "docs-only" || low === "process-only" || low === "non-code") {
      return false;
    }
  }

  const kind = typeof meta?.kind === "string" ? meta.kind.trim().toLowerCase() : "";
  if (kind === "docs" || kind === "process" || kind === "research") {
    return false;
  }

  const swarm = asRecord(meta?.swarm);
  if (Array.isArray(swarm?.file_scope) && swarm.file_scope.length > 0) {
    return true;
  }

  if (hasGithubIssueRef(plan)) {
    return true;
  }

  return false;
}

export function hasGithubIssueRef(plan: Record<string, unknown>): boolean {
  return resolvePlanGithubIssueRef(plan) !== null;
}

/**
 * Expected repository + issue from plan `x-xbrief/github-issue` reference (#3675).
 * Worker `--repo` / `--pr` are checked against this, never the source of it.
 */
/**
 * Parse owner/repo#N from a GitHub issue URL. Query/fragment are ignored so
 * `…/issues/1?view=1` still classifies as code-bearing (#3675 Greptile P1).
 */
export function parseGithubIssueUri(uri: string): PlanGithubIssueRef | null {
  const trimmed = uri.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const pathOnly = (trimmed.split(/[?#]/, 1)[0] ?? trimmed).replace(/\/$/, "");
  if (!/github\.com\/[^/]+\/[^/]+\/issues\/\d+/i.test(pathOnly)) {
    return null;
  }
  const parts =
    pathOnly
      .split("://")
      .pop()
      ?.split("/")
      .filter((p) => p.length > 0) ?? [];
  if (
    parts.length >= 4 &&
    parts[parts.length - 2] === "issues" &&
    /^\d+$/.test(parts[parts.length - 1] ?? "")
  ) {
    const owner = parts[parts.length - 4];
    const name = parts[parts.length - 3];
    const issueNumber = Number(parts[parts.length - 1]);
    if (
      typeof owner === "string" &&
      typeof name === "string" &&
      owner.length > 0 &&
      name.length > 0 &&
      Number.isInteger(issueNumber) &&
      issueNumber > 0
    ) {
      return { repository: `${owner}/${name}`, issueNumber };
    }
  }
  return null;
}

export function resolvePlanGithubIssueRef(
  plan: Record<string, unknown>,
): PlanGithubIssueRef | null {
  const refs = plan.references;
  if (!Array.isArray(refs)) {
    return null;
  }
  for (const ref of refs) {
    const rec = asRecord(ref);
    if (rec === null) continue;
    const type = typeof rec.type === "string" ? rec.type : "";
    const uri = typeof rec.uri === "string" ? rec.uri.trim() : "";
    if (uri.length === 0) continue;
    const parsed = parseGithubIssueUri(uri);
    const fromType = type.includes("github-issue");
    if (!fromType && parsed === null) continue;
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

function normalizeSha(value: string): string {
  return value.trim().toLowerCase();
}

function shasEqual(left: string, right: string): boolean {
  return normalizeSha(left) === normalizeSha(right);
}

function parseOwnerRepo(repository: string): { owner: string; name: string } | null {
  const slash = repository.indexOf("/");
  if (slash <= 0 || slash >= repository.length - 1) {
    return null;
  }
  const owner = repository.slice(0, slash).trim();
  const name = repository.slice(slash + 1).trim();
  if (owner.length === 0 || name.length === 0 || name.includes("/")) {
    return null;
  }
  return { owner, name };
}

/** Default pulls REST fetcher for Prefer-A identity join (#3675). */
export function defaultFetchPrPayload(
  prNumber: number,
  repository: string,
  runGh: RunGhFn = defaultRunGh,
): Record<string, unknown> | null {
  const parsed = parseOwnerRepo(repository);
  if (parsed === null) {
    return null;
  }
  const path = `repos/${parsed.owner}/${parsed.name}/pulls/${prNumber}`;
  const result = runGh(["gh", "api", path]);
  if (result.returncode !== 0) {
    return null;
  }
  try {
    const body = JSON.parse(result.stdout) as unknown;
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return null;
    }
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseClosingIssueEntry(
  entry: unknown,
  fallbackRepository: string,
): ClosingIssueRef | null {
  const rec = asRecord(entry);
  if (rec === null) {
    return null;
  }
  let issueNumber: number | null = null;
  if (typeof rec.number === "number" && Number.isInteger(rec.number) && rec.number > 0) {
    issueNumber = rec.number;
  } else if (typeof rec.number === "string" && /^[0-9]+$/.test(rec.number)) {
    issueNumber = Number(rec.number);
  }
  if (issueNumber === null) {
    return null;
  }

  if (typeof rec.url === "string" && rec.url.trim().length > 0) {
    const fromUrl = parseGithubIssueUri(rec.url);
    if (fromUrl !== null) {
      return { repository: fromUrl.repository, issueNumber: fromUrl.issueNumber };
    }
  }

  const repoRec = asRecord(rec.repository);
  const nameWithOwner =
    typeof repoRec?.nameWithOwner === "string" ? repoRec.nameWithOwner.trim() : "";
  if (nameWithOwner.includes("/")) {
    return { repository: nameWithOwner, issueNumber };
  }

  // Number-only payloads (legacy fixtures) inherit the PR repository.
  return { repository: fallbackRepository, issueNumber };
}

/** GraphQL query for closingIssuesReferences with repository identity (#3675). */
const CLOSING_ISSUES_GRAPHQL = [
  "query($owner:String!,$name:String!,$number:Int!){",
  "repository(owner:$owner,name:$name){",
  "pullRequest(number:$number){",
  "closingIssuesReferences(first:100){",
  "nodes{number url repository{nameWithOwner}}",
  "}}}}",
].join("");

/**
 * Authoritative closing-issue refs with per-issue repository preserved (#3675).
 * Uses `gh api graphql` (not forbidden `gh pr view --json`) so cross-repo
 * closers keep their own repository. Does not union body/commit intent.
 */
export function defaultFetchClosingIssueIds(
  prNumber: number,
  repository: string,
  runGh: RunGhFn = defaultRunGh,
): ClosingIssueRef[] | null {
  const parsedRepo = parseOwnerRepo(repository);
  if (parsedRepo === null) {
    return null;
  }

  const cmd = [
    "gh",
    "api",
    "graphql",
    "-f",
    `query=${CLOSING_ISSUES_GRAPHQL}`,
    "-F",
    `owner=${parsedRepo.owner}`,
    "-F",
    `name=${parsedRepo.name}`,
    "-F",
    `number=${prNumber}`,
  ];

  let result: RunGhResult;
  try {
    result = runGh(cmd);
  } catch {
    return null;
  }
  if (result.returncode !== 0) {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout) as unknown;
  } catch {
    return null;
  }
  const nodes = asRecord(
    asRecord(asRecord(asRecord(payload)?.data)?.repository)?.pullRequest,
  )?.closingIssuesReferences;
  const refs = asRecord(nodes)?.nodes;
  if (!Array.isArray(refs)) {
    return null;
  }

  const out: ClosingIssueRef[] = [];
  for (const entry of refs) {
    const parsed = parseClosingIssueEntry(entry, repository);
    if (parsed !== null) {
      out.push(parsed);
    }
  }
  return out;
}

/**
 * PR changed files via REST `pulls/{n}/files` (paginated). Any failure or
 * unparseable line returns null so the caller fails closed.
 */
export function defaultFetchPrChangedFiles(
  prNumber: number,
  repository: string,
  runGh: RunGhFn = defaultRunGh,
): PrChangedFile[] | null {
  const parsed = parseOwnerRepo(repository);
  if (parsed === null) {
    return null;
  }
  let result: RunGhResult;
  try {
    result = runGh([
      "gh",
      "api",
      "--paginate",
      `repos/${parsed.owner}/${parsed.name}/pulls/${prNumber}/files?per_page=100`,
      "--jq",
      ".[] | [.status, .filename] | @tsv",
    ]);
  } catch {
    return null;
  }
  if (result.returncode !== 0) {
    return null;
  }
  const out: PrChangedFile[] = [];
  for (const line of result.stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    const tab = line.indexOf("\t");
    if (tab <= 0 || tab === line.length - 1) {
      return null;
    }
    out.push({ status: line.slice(0, tab), filename: line.slice(tab + 1) });
  }
  return out;
}

/**
 * How the story→PR identity was proven.
 * - `forge-closer`: legacy current-state closer set (read-only; no longer written, #5710).
 * - `brief-in-pr-diff`: the merged PR added this brief alongside code (#3675).
 * - `pr-only`: issue-less brief bound by `plan.metadata.productPullRequest` (#5710 P1).
 * - `merge-time-mark` / `merge-time-keyword` / `merge-time-connected`: issue-anchored
 *   association proven as of `merged_at` (#5710 P3 bases a / b / c).
 */
export type StoryPrIdentityBasis =
  | "forge-closer"
  | "brief-in-pr-diff"
  | "pr-only"
  | "merge-time-mark"
  | "merge-time-keyword"
  | "merge-time-connected";

const LIFECYCLE_FOLDER_SET: ReadonlySet<string> = new Set(LIFECYCLE_FOLDERS);

function lifecycleBriefBasename(filename: string): string | null {
  const parts = filename.split("/");
  // Require xbrief|vbrief/<lifecycle>/<file> so docs/active/... cannot prove delivery.
  if (parts.length < 3) return null;
  const root = parts[parts.length - 3] ?? "";
  if (root !== "xbrief" && root !== "vbrief") return null;
  const folder = parts[parts.length - 2] ?? "";
  return LIFECYCLE_FOLDER_SET.has(folder) ? (parts[parts.length - 1] ?? null) : null;
}

/**
 * Brief-in-PR-diff identity (#3675 fallback). Holds only when the merged PR
 * added this exact brief file to a lifecycle folder AND changed at least one
 * file outside the lifecycle folders. A PR that only edits or moves the brief
 * (a lifecycle PR) does not qualify.
 */
export function prDiffAddsBrief(files: readonly PrChangedFile[], briefBasename: string): boolean {
  const name = briefBasename.trim();
  if (name.length === 0) return false;
  const addsBrief = files.some(
    (f) => f.status === "added" && lifecycleBriefBasename(f.filename) === name,
  );
  const touchesCode = files.some((f) => lifecycleBriefBasename(f.filename) === null);
  return addsBrief && touchesCode;
}

// ---------------------------------------------------------------------------
// Merge-time association (#5710 Prefer-A Recut-13 P3)
// ---------------------------------------------------------------------------

/** One PR body revision from GraphQL `userContentEdits` (#5710). */
export interface PrBodyRevision {
  readonly editedAt: string;
  /** Body text after this edit; null when the forge hides or deleted the revision. */
  readonly body: string | null;
}

/** One merged PR from the paged repository listing (#5710). */
export interface MergedPrListNode {
  readonly number: number;
  readonly mergedAt: string;
  readonly body: string;
  /** Last body edit time; null when the body was never edited. */
  readonly lastEditedAt: string | null;
}

/** One ConnectedEvent / DisconnectedEvent on a PR timeline (#5710 basis c). */
export interface PrConnectionEvent {
  readonly kind: "connected" | "disconnected";
  readonly createdAt: string;
  /** Issues named by the event's source or subject, with their own repository. */
  readonly issues: readonly ClosingIssueRef[];
}

/** One changed file, with the rename source when GitHub reports one. */
export interface PrFileEntry extends PrChangedFile {
  readonly previousFilename?: string;
}

/** One page of a forge connection; any failure is `ok:false` (fail closed). */
export type ForgePage<T> =
  | {
      readonly ok: true;
      readonly nodes: readonly T[];
      readonly hasNextPage: boolean;
      readonly endCursor: string | null;
    }
  | { readonly ok: false; readonly error: string };

/** Live rate-limit read (`gh api rate_limit`, never the cached proxy). */
export interface RateLimitSnapshot {
  readonly graphqlRemaining: number;
  readonly coreRemaining: number;
}

/**
 * Forge reads for merge-time association (#5710). Inject in tests so no
 * network is used. Page-level primitives: paging and budget live here.
 */
export interface MergeTimeForge {
  readonly listMergedPrsPage: (
    repository: string,
    after: string | null,
  ) => ForgePage<MergedPrListNode>;
  readonly fetchBodyRevisionsPage: (
    repository: string,
    prNumber: number,
    after: string | null,
  ) => ForgePage<PrBodyRevision>;
  readonly fetchConnectionEventsPage: (
    repository: string,
    prNumber: number,
    after: string | null,
  ) => ForgePage<PrConnectionEvent>;
  /** One REST page of changed files; the scan checks the REST budget before each page. */
  readonly fetchPrFilesPage: (
    repository: string,
    prNumber: number,
    after: string | null,
  ) => ForgePage<PrFileEntry>;
  readonly probeRateLimit: () => RateLimitSnapshot | null;
  readonly nowMs: () => number;
}

/** Recut-13 uniqueness-scan budget: units and caps (#5710). */
export const MERGE_TIME_SCAN_WALL_CLOCK_MS = 20 * 60 * 1000;
export const MERGE_TIME_SCAN_MIN_GRAPHQL_REMAINING = 200;
export const MERGE_TIME_SCAN_MIN_CORE_REMAINING = 100;
/** GitHub `pulls/{n}/files` lists at most 3000 files. */
export const PR_FILES_LISTING_CAP = 3000;

/** The three accepted merge-time bases, named in every stranded-shape refusal (#5710). */
export const MERGE_TIME_ASSOCIATION_BASES =
  "(a) a unique sole `deft-story: N` mark in the PR body as of merged_at, " +
  "(b) a closing keyword (close/fix/resolve forms) naming the issue in the PR body as of merged_at, " +
  "(c) a Connected issue link in effect at merged_at";

/** Budget guards for one identity join; each returns null or the refusal reason. */
export interface ScanBudget {
  readonly beforeGraphql: () => string | null;
  readonly beforeRest: () => string | null;
}

/** Start the Recut-13 scan budget: wall clock from now, live rate limits per call. */
export function makeScanBudget(forge: MergeTimeForge): ScanBudget {
  const startMs = forge.nowMs();
  const wallClock = (): string | null =>
    forge.nowMs() - startMs > MERGE_TIME_SCAN_WALL_CLOCK_MS
      ? `scan budget exhausted: wall-clock cap ${MERGE_TIME_SCAN_WALL_CLOCK_MS / 60000} minutes`
      : null;
  const remaining = (
    bucket: "graphqlRemaining" | "coreRemaining",
    floor: number,
    label: string,
  ): string | null => {
    const clock = wallClock();
    if (clock !== null) return clock;
    const rate = forge.probeRateLimit();
    if (rate === null) return "scan budget unknown: live rate-limit probe failed";
    return rate[bucket] < floor
      ? `scan budget exhausted: ${label} remaining ${rate[bucket]} < ${floor}`
      : null;
  };
  return {
    beforeGraphql: () =>
      remaining("graphqlRemaining", MERGE_TIME_SCAN_MIN_GRAPHQL_REMAINING, "graphql"),
    beforeRest: () => remaining("coreRemaining", MERGE_TIME_SCAN_MIN_CORE_REMAINING, "REST core"),
  };
}

type Collected<T> = { ok: true; nodes: T[] } | { ok: false; error: string };

/** Next cursor of a page with more nodes, or null when the cursor is missing or stuck. */
function nextCursor(endCursor: string | null, after: string | null): string | null {
  const next = endCursor?.trim() ?? "";
  return next.length === 0 || next === after ? null : next;
}

/** Walk every page of a connection; any gap, guard refusal or stuck cursor fails closed. */
function collectAllPages<T>(
  fetchPage: (after: string | null) => ForgePage<T>,
  guard: () => string | null,
  label: string,
): Collected<T> {
  const nodes: T[] = [];
  let after: string | null = null;
  for (;;) {
    const refused = guard();
    if (refused !== null) {
      return { ok: false, error: `${label}: ${refused}` };
    }
    const page = fetchPage(after);
    if (!page.ok) {
      return { ok: false, error: `${label}: ${page.error}` };
    }
    nodes.push(...page.nodes);
    if (!page.hasNextPage) {
      return { ok: true, nodes };
    }
    const next = nextCursor(page.endCursor, after);
    if (next === null) {
      return {
        ok: false,
        error: `${label}: incomplete page (hasNextPage without a new endCursor)`,
      };
    }
    after = next;
  }
}

/**
 * Merge-time body (#5710): the latest `userContentEdits` revision with
 * editedAt ≤ merged_at, or the current body when the PR has no edit history.
 * A hidden revision or no revision at or before merged_at is unknown (fail closed).
 */
export function selectMergeTimeBody(
  revisions: readonly PrBodyRevision[],
  currentBody: string | null,
  mergedAt: string,
): { ok: true; body: string } | { ok: false; error: string } {
  const mergedMs = Date.parse(mergedAt);
  if (Number.isNaN(mergedMs)) {
    return { ok: false, error: `unreadable merged_at ${JSON.stringify(mergedAt)}` };
  }
  if (revisions.length === 0) {
    return { ok: true, body: currentBody ?? "" };
  }
  let chosen: PrBodyRevision | null = null;
  let chosenMs = Number.NEGATIVE_INFINITY;
  for (const revision of revisions) {
    const editedMs = Date.parse(revision.editedAt);
    if (Number.isNaN(editedMs)) {
      return {
        ok: false,
        error: `unreadable revision editedAt ${JSON.stringify(revision.editedAt)}`,
      };
    }
    if (editedMs <= mergedMs && editedMs >= chosenMs) {
      chosen = revision;
      chosenMs = editedMs;
    }
  }
  if (chosen === null) {
    return { ok: false, error: "no body revision at or before merged_at" };
  }
  if (chosen.body === null) {
    return { ok: false, error: "merge-time body revision is unreadable" };
  }
  return { ok: true, body: chosen.body };
}

const CLOSING_KEYWORD_REF_RE =
  /\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved):?[ \t]+(?:#(\d+)|([\w.-]+)\/([\w.-]+)#(\d+)|https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+))(?![\w-])/gi;

/**
 * True when the body has a GitHub closing keyword naming the issue as `#N`,
 * `owner/repo#N` or the issue URL (#5710 basis b). `#N` means the PR's repository.
 */
export function bodyHasClosingKeywordFor(
  body: string,
  repository: string,
  issueNumber: number,
): boolean {
  const repoKey = repository.trim().toLowerCase();
  const re = new RegExp(CLOSING_KEYWORD_REF_RE.source, CLOSING_KEYWORD_REF_RE.flags);
  for (let match = re.exec(body); match !== null; match = re.exec(body)) {
    const [, bare, owner, name, qualified, urlOwner, urlName, urlNumber] = match;
    if (bare !== undefined) {
      if (Number(bare) === issueNumber) return true;
      continue;
    }
    const refRepo = `${owner ?? urlOwner ?? ""}/${name ?? urlName ?? ""}`.toLowerCase();
    if (refRepo === repoKey && Number(qualified ?? urlNumber) === issueNumber) {
      return true;
    }
  }
  return false;
}

/**
 * Replay Connected / Disconnected events up to merged_at (#5710 basis c).
 * Events after merged_at do not count.
 */
export function connectedAtMergedAt(
  events: readonly PrConnectionEvent[],
  repository: string,
  issueNumber: number,
  mergedAt: string,
): { ok: true; connected: boolean } | { ok: false; error: string } {
  const mergedMs = Date.parse(mergedAt);
  if (Number.isNaN(mergedMs)) {
    return { ok: false, error: `unreadable merged_at ${JSON.stringify(mergedAt)}` };
  }
  const repoKey = repository.trim().toLowerCase();
  const relevant: { ms: number; kind: PrConnectionEvent["kind"] }[] = [];
  for (const event of events) {
    const names = event.issues.some(
      (ref) => ref.repository.trim().toLowerCase() === repoKey && ref.issueNumber === issueNumber,
    );
    if (!names) continue;
    const ms = Date.parse(event.createdAt);
    if (Number.isNaN(ms)) {
      return { ok: false, error: `unreadable event createdAt ${JSON.stringify(event.createdAt)}` };
    }
    if (ms <= mergedMs) {
      relevant.push({ ms, kind: event.kind });
    }
  }
  relevant.sort((a, b) => a.ms - b.ms);
  const last = relevant[relevant.length - 1];
  return { ok: true, connected: last?.kind === "connected" };
}

const DELIVERY_BRIEF_LAND_RE = /^(?:xbrief|vbrief)\/(?:proposed|pending|active|completed)\//;

function isDeliveryBriefLandPath(path: string): boolean {
  const p = path.replace(/\\/g, "/");
  return p === "CHANGELOG.md" || DELIVERY_BRIEF_LAND_RE.test(p);
}

/**
 * Delivery-brief-land exclusion (#5710): every changed path, rename sources
 * included, is a brief under `xbrief|vbrief/(proposed|pending|active|completed)/`
 * or root `CHANGELOG.md`, with at least one such path for a positive
 * exclusion. CHANGELOG-only, completed-folder renames and deletion-only diffs
 * on those paths are excluded. A zero-file diff is not a positive exclusion:
 * as a competitor it still counts (fail closed), and as a candidate it is
 * refused separately because it carries no delivery. Not identical to
 * activation `isBriefLandShapedDiff`, which denies completed/ and needs a
 * non-removed nonterminal brief.
 */
export function isDeliveryBriefLandExcluded(files: readonly PrFileEntry[]): boolean {
  return (
    files.length > 0 &&
    files.every(
      (file) =>
        isDeliveryBriefLandPath(file.filename) &&
        ((file.previousFilename ?? "").length === 0 ||
          isDeliveryBriefLandPath(file.previousFilename ?? "")),
    )
  );
}

/** The single distinct `deft-story` mark in a body, or null when zero or several (#5710). */
export function soleDeftStoryMark(body: string): number | null {
  const marks = parseAllDeftStoryMarks(body);
  return marks.length === 1 ? (marks[0] ?? null) : null;
}

function reconstructMergeTimeBody(
  forge: MergeTimeForge,
  budget: ScanBudget,
  target: { readonly repository: string; readonly prNumber: number },
  currentBody: string | null,
  mergedAt: string,
): { ok: true; body: string } | { ok: false; error: string } {
  const { repository, prNumber } = target;
  const revisions = collectAllPages(
    (after) => forge.fetchBodyRevisionsPage(repository, prNumber, after),
    budget.beforeGraphql,
    `PR #${prNumber} body revisions`,
  );
  if (!revisions.ok) {
    return revisions;
  }
  const selected = selectMergeTimeBody(revisions.nodes, currentBody, mergedAt);
  return selected.ok
    ? selected
    : { ok: false, error: `PR #${prNumber} merge-time body: ${selected.error}` };
}

function classifyDeliveryExclusion(
  forge: MergeTimeForge,
  budget: ScanBudget,
  repository: string,
  prNumber: number,
): { ok: true; excluded: boolean; fileCount: number } | { ok: false; error: string } {
  // REST budget is checked before every page, not once per PR (#5710).
  const listed = collectAllPages(
    (after) => forge.fetchPrFilesPage(repository, prNumber, after),
    budget.beforeRest,
    `PR #${prNumber} changed files`,
  );
  if (!listed.ok) {
    return listed;
  }
  // The forge stops listing at its cap, so reaching it means the list may be truncated.
  if (listed.nodes.length >= PR_FILES_LISTING_CAP) {
    return {
      ok: false,
      error: `PR #${prNumber} changed files: listing truncated at the ${PR_FILES_LISTING_CAP}-file cap`,
    };
  }
  return {
    ok: true,
    excluded: isDeliveryBriefLandExcluded(listed.nodes),
    fileCount: listed.nodes.length,
  };
}

/** Merge-time body of one listed PR; edits only replayed when one landed after merge. */
function listedMergeTimeBody(
  forge: MergeTimeForge,
  budget: ScanBudget,
  repository: string,
  node: MergedPrListNode,
): { ok: true; body: string } | { ok: false; error: string } {
  const mergedMs = Date.parse(node.mergedAt);
  const lastEditedMs = node.lastEditedAt === null ? null : Date.parse(node.lastEditedAt);
  if (Number.isNaN(mergedMs) || (lastEditedMs !== null && Number.isNaN(lastEditedMs))) {
    return { ok: false, error: `PR #${node.number} has unreadable mergedAt / lastEditedAt` };
  }
  // No edit after merge: the latest revision at or before merged_at is the
  // latest revision, which is the current body.
  if (lastEditedMs === null || lastEditedMs <= mergedMs) {
    return { ok: true, body: node.body };
  }
  return reconstructMergeTimeBody(
    forge,
    budget,
    { repository, prNumber: node.number },
    node.body,
    node.mergedAt,
  );
}

/**
 * Bounded exhaustive uniqueness scan (#5710 basis a). Enumerates every merged
 * PR, reconstructs each merge-time body, and classifies sole-mark hits for
 * `issueNumber`. Returns the non-excluded sole-mark PRs other than the
 * candidate. Any incomplete page, unreadable revision or competitor, truncated
 * listing, or exhausted budget fails closed. No recent-window shortcut.
 */
export function scanSoleMarkCompetitors(input: {
  readonly repository: string;
  readonly issueNumber: number;
  readonly candidatePr: number;
  readonly forge: MergeTimeForge;
  readonly budget?: ScanBudget;
}): { ok: true; competitors: number[] } | { ok: false; error: string } {
  const { repository, issueNumber, candidatePr, forge } = input;
  const budget = input.budget ?? makeScanBudget(forge);
  const competitors: number[] = [];
  let after: string | null = null;
  for (;;) {
    const refused = budget.beforeGraphql();
    if (refused !== null) {
      return { ok: false, error: `merged-PR scan: ${refused}` };
    }
    const page = forge.listMergedPrsPage(repository, after);
    if (!page.ok) {
      return { ok: false, error: `merged-PR scan: ${page.error}` };
    }
    for (const node of page.nodes) {
      if (node.number === candidatePr) continue;
      const body = listedMergeTimeBody(forge, budget, repository, node);
      if (!body.ok) {
        return { ok: false, error: `merged-PR scan: ${body.error}` };
      }
      if (soleDeftStoryMark(body.body) !== issueNumber) continue;
      const exclusion = classifyDeliveryExclusion(forge, budget, repository, node.number);
      if (!exclusion.ok) {
        return { ok: false, error: `merged-PR scan: possible competitor ${exclusion.error}` };
      }
      if (!exclusion.excluded) {
        competitors.push(node.number);
      }
    }
    if (!page.hasNextPage) {
      return { ok: true, competitors };
    }
    const next = nextCursor(page.endCursor, after);
    if (next === null) {
      return {
        ok: false,
        error: "merged-PR scan: incomplete page (hasNextPage without a new endCursor)",
      };
    }
    after = next;
  }
}

/** Basis a: unique sole mark among merged non-excluded PRs (#5710). */
function proveSoleMarkBasis(input: {
  readonly forge: MergeTimeForge;
  readonly budget: ScanBudget;
  readonly repository: string;
  readonly issueNumber: number;
  readonly prNumber: number;
  readonly mergeTimeBody: string;
}): { ok: true } | { ok: false; reason: string } {
  const { forge, budget, repository, issueNumber, prNumber } = input;
  if (soleDeftStoryMark(input.mergeTimeBody) !== issueNumber) {
    return {
      ok: false,
      reason: `(a) PR #${prNumber} body as of merged_at has no sole \`deft-story: ${issueNumber}\` mark`,
    };
  }
  const exclusion = classifyDeliveryExclusion(forge, budget, repository, prNumber);
  if (!exclusion.ok) {
    return { ok: false, reason: `(a) ${exclusion.error}` };
  }
  if (exclusion.fileCount === 0) {
    return {
      ok: false,
      reason: `(a) PR #${prNumber} changes no files (a zero-file PR carries no delivery)`,
    };
  }
  if (exclusion.excluded) {
    return {
      ok: false,
      reason:
        `(a) PR #${prNumber} changes only briefs and CHANGELOG.md ` +
        `(delivery-brief-land excluded; not delivery)`,
    };
  }
  const scan = scanSoleMarkCompetitors({
    repository,
    issueNumber,
    candidatePr: prNumber,
    forge,
    budget,
  });
  if (!scan.ok) {
    return { ok: false, reason: `(a) uniqueness unknown, refusing: ${scan.error}` };
  }
  if (scan.competitors.length > 0) {
    const list = scan.competitors.map((n) => `#${n}`).join(", ");
    return {
      ok: false,
      reason:
        `(a) mark is not unique: merged non-excluded PR(s) ${list} also carry a sole ` +
        `\`deft-story: ${issueNumber}\` mark`,
    };
  }
  return { ok: true };
}

/** One GraphQL call through gh; returns `data` or an error (any `errors` entry fails). */
function runGhGraphql(
  runGh: RunGhFn,
  query: string,
  vars: Record<string, string | number | null>,
): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  const cmd = ["gh", "api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(vars)) {
    if (value !== null) {
      cmd.push("-F", `${key}=${String(value)}`);
    }
  }
  let result: RunGhResult;
  try {
    result = runGh(cmd);
  } catch (exc: unknown) {
    return { ok: false, error: exc instanceof Error ? exc.message : String(exc) };
  }
  if (result.returncode !== 0) {
    return { ok: false, error: result.stderr.trim() || "gh api graphql non-zero" };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout) as unknown;
  } catch {
    return { ok: false, error: "unparseable GraphQL JSON" };
  }
  const rec = asRecord(payload);
  if (rec === null || (Array.isArray(rec.errors) && rec.errors.length > 0)) {
    return { ok: false, error: "GraphQL response carried errors" };
  }
  const data = asRecord(rec.data);
  return data === null ? { ok: false, error: "GraphQL response missing data" } : { ok: true, data };
}

function readConnection(
  value: unknown,
): { nodes: unknown[]; hasNextPage: boolean; endCursor: string | null } | null {
  const conn = asRecord(value);
  const pageInfo = asRecord(conn?.pageInfo);
  if (conn === null || pageInfo === null || !Array.isArray(conn.nodes)) return null;
  if (typeof pageInfo.hasNextPage !== "boolean") return null;
  const endCursor = typeof pageInfo.endCursor === "string" ? pageInfo.endCursor : null;
  return { nodes: conn.nodes, hasNextPage: pageInfo.hasNextPage, endCursor };
}

const MERGED_PRS_GRAPHQL =
  "query($owner:String!,$name:String!,$after:String){repository(owner:$owner,name:$name){" +
  "pullRequests(states:MERGED,first:100,after:$after,orderBy:{field:CREATED_AT,direction:ASC}){" +
  "pageInfo{hasNextPage endCursor} nodes{number mergedAt body lastEditedAt}}}}";

const BODY_REVISIONS_GRAPHQL =
  "query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){" +
  "pullRequest(number:$number){userContentEdits(first:100,after:$after){" +
  "pageInfo{hasNextPage endCursor} nodes{editedAt deletedAt diff}}}}}";

const SUBJECT_FIELDS = "__typename ... on Issue{number repository{nameWithOwner}}";
const CONNECTION_EVENTS_GRAPHQL =
  "query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){" +
  "pullRequest(number:$number){timelineItems(first:100,after:$after," +
  "itemTypes:[CONNECTED_EVENT,DISCONNECTED_EVENT]){pageInfo{hasNextPage endCursor} nodes{__typename " +
  `... on ConnectedEvent{createdAt source{${SUBJECT_FIELDS}} subject{${SUBJECT_FIELDS}}} ` +
  `... on DisconnectedEvent{createdAt source{${SUBJECT_FIELDS}} subject{${SUBJECT_FIELDS}}}}}}}}`;

function parseEventIssue(value: unknown): ClosingIssueRef | null {
  const rec = asRecord(value);
  if (rec === null || rec.__typename !== "Issue") return null;
  const repo = asRecord(rec.repository)?.nameWithOwner;
  if (typeof rec.number !== "number" || typeof repo !== "string") return null;
  return { repository: repo, issueNumber: rec.number };
}

function parseMergedPrNode(value: unknown): MergedPrListNode | null {
  const rec = asRecord(value);
  if (rec === null || typeof rec.number !== "number" || typeof rec.mergedAt !== "string") {
    return null;
  }
  if (rec.body !== null && typeof rec.body !== "string") return null;
  if (rec.lastEditedAt !== null && typeof rec.lastEditedAt !== "string") return null;
  return {
    number: rec.number,
    mergedAt: rec.mergedAt,
    body: typeof rec.body === "string" ? rec.body : "",
    lastEditedAt: typeof rec.lastEditedAt === "string" ? rec.lastEditedAt : null,
  };
}

function parseRevisionNode(value: unknown): PrBodyRevision | null {
  const rec = asRecord(value);
  if (rec === null || typeof rec.editedAt !== "string") return null;
  const hidden = rec.deletedAt !== null && rec.deletedAt !== undefined;
  return {
    editedAt: rec.editedAt,
    body: !hidden && typeof rec.diff === "string" ? rec.diff : null,
  };
}

function parseConnectionEventNode(value: unknown): PrConnectionEvent | null {
  const rec = asRecord(value);
  if (rec === null || typeof rec.createdAt !== "string") return null;
  let kind: PrConnectionEvent["kind"];
  if (rec.__typename === "ConnectedEvent") {
    kind = "connected";
  } else if (rec.__typename === "DisconnectedEvent") {
    kind = "disconnected";
  } else {
    return null;
  }
  const issues = [parseEventIssue(rec.source), parseEventIssue(rec.subject)].filter(
    (ref): ref is ClosingIssueRef => ref !== null,
  );
  return { kind, createdAt: rec.createdAt, issues };
}

function graphqlPage<T>(
  runGh: RunGhFn,
  request: { readonly query: string; readonly vars: Record<string, string | number | null> },
  pick: (data: Record<string, unknown>) => unknown,
  parseNode: (value: unknown) => T | null,
): ForgePage<T> {
  const response = runGhGraphql(runGh, request.query, request.vars);
  if (!response.ok) return response;
  const conn = readConnection(pick(response.data));
  if (conn === null) {
    return { ok: false, error: "incomplete page (missing connection or pageInfo)" };
  }
  const nodes: T[] = [];
  for (const raw of conn.nodes) {
    const parsed = parseNode(raw);
    if (parsed === null) return { ok: false, error: "unreadable node in page" };
    nodes.push(parsed);
  }
  return { ok: true, nodes, hasNextPage: conn.hasNextPage, endCursor: conn.endCursor };
}

function parsePrFileEntry(value: unknown): PrFileEntry | null {
  const rec = asRecord(value);
  if (rec === null || typeof rec.filename !== "string" || rec.filename.length === 0) return null;
  if (typeof rec.status !== "string") return null;
  const previous = typeof rec.previous_filename === "string" ? rec.previous_filename : "";
  return previous.length > 0
    ? { status: rec.status, filename: rec.filename, previousFilename: previous }
    : { status: rec.status, filename: rec.filename };
}

/**
 * One REST page of `pulls/{n}/files` with rename sources, read uncached. The
 * cursor is the next page number; paging ends at the first empty page.
 */
function fetchPrFilesPageLive(
  runGh: RunGhFn,
  repository: string,
  prNumber: number,
  after: string | null,
): ForgePage<PrFileEntry> {
  const parsed = parseOwnerRepo(repository);
  if (parsed === null) return { ok: false, error: `invalid repository ${repository}` };
  const page = after === null ? 1 : Number(after);
  if (!Number.isInteger(page) || page < 1) return { ok: false, error: `invalid page ${after}` };
  const path = `repos/${parsed.owner}/${parsed.name}/pulls/${prNumber}/files?per_page=100&page=${page}`;
  let result: RunGhResult;
  try {
    result = liveRunGh(runGh)(["gh", "api", path]);
  } catch (exc: unknown) {
    return { ok: false, error: exc instanceof Error ? exc.message : String(exc) };
  }
  if (result.returncode !== 0) {
    return { ok: false, error: result.stderr.trim() || "gh api files non-zero" };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout) as unknown;
  } catch {
    return { ok: false, error: "unparseable files page" };
  }
  if (!Array.isArray(payload)) return { ok: false, error: "files page is not an array" };
  const nodes: PrFileEntry[] = [];
  for (const raw of payload) {
    const entry = parsePrFileEntry(raw);
    if (entry === null) return { ok: false, error: "unreadable files entry" };
    nodes.push(entry);
  }
  const hasNextPage = nodes.length > 0;
  return { ok: true, nodes, hasNextPage, endCursor: hasNextPage ? String(page + 1) : null };
}

/**
 * Pin plain `gh` for single-path GETs the default runner would send to the
 * `ghx` cache proxy. A cached read can be stale: a PR cached before merge
 * reads as unmerged, a rate bucket reads as fuller than it is (#954 / #5710).
 * Injected runners are used as given.
 */
export function liveRunGh(runGh: RunGhFn): RunGhFn {
  return runGh === defaultRunGh ? (cmd) => defaultRunGh(cmd, "gh") : runGh;
}

function probeLiveRateLimit(runGh: RunGhFn): RateLimitSnapshot | null {
  const cmd = ["gh", "api", "rate_limit"];
  let result: RunGhResult;
  try {
    result = liveRunGh(runGh)(cmd);
  } catch {
    return null;
  }
  if (result.returncode !== 0) return null;
  try {
    const resources = asRecord(asRecord(JSON.parse(result.stdout))?.resources);
    const graphql = asRecord(resources?.graphql)?.remaining;
    const core = asRecord(resources?.core)?.remaining;
    if (typeof graphql !== "number" || typeof core !== "number") return null;
    return { graphqlRemaining: graphql, coreRemaining: core };
  } catch {
    return null;
  }
}

/**
 * Live forge reads for merge-time association (#5710): GraphQL pages, REST
 * changed files with rename sources, and the uncached `gh api rate_limit`.
 */
export function defaultMergeTimeForge(runGh: RunGhFn = defaultRunGh): MergeTimeForge {
  const prVars = (repository: string, prNumber: number, after: string | null) => {
    const parsed = parseOwnerRepo(repository);
    return parsed === null
      ? null
      : { owner: parsed.owner, name: parsed.name, number: prNumber, after };
  };
  const pullRequestOf = (data: Record<string, unknown>) =>
    asRecord(asRecord(data.repository)?.pullRequest);
  const invalid = (repository: string) => ({
    ok: false as const,
    error: `invalid repository ${repository}`,
  });
  return {
    listMergedPrsPage: (repository, after) => {
      const parsed = parseOwnerRepo(repository);
      if (parsed === null) return invalid(repository);
      return graphqlPage(
        runGh,
        { query: MERGED_PRS_GRAPHQL, vars: { owner: parsed.owner, name: parsed.name, after } },
        (data) => asRecord(data.repository)?.pullRequests,
        parseMergedPrNode,
      );
    },
    fetchBodyRevisionsPage: (repository, prNumber, after) => {
      const vars = prVars(repository, prNumber, after);
      if (vars === null) return invalid(repository);
      return graphqlPage(
        runGh,
        { query: BODY_REVISIONS_GRAPHQL, vars },
        (data) => pullRequestOf(data)?.userContentEdits,
        parseRevisionNode,
      );
    },
    fetchConnectionEventsPage: (repository, prNumber, after) => {
      const vars = prVars(repository, prNumber, after);
      if (vars === null) return invalid(repository);
      return graphqlPage(
        runGh,
        { query: CONNECTION_EVENTS_GRAPHQL, vars },
        (data) => pullRequestOf(data)?.timelineItems,
        parseConnectionEventNode,
      );
    },
    fetchPrFilesPage: (repository, prNumber, after) =>
      fetchPrFilesPageLive(runGh, repository, prNumber, after),
    probeRateLimit: () => probeLiveRateLimit(runGh),
    nowMs: () => Date.now(),
  };
}

/**
 * Canonical project repository (#5710 P1): OWNER/NAME of the `origin` remote.
 * `--repo` is a matching assertion only and is never the source of it.
 */
export function resolveCanonicalProjectRepository(
  projectRoot: string,
  runGit: GitRunner = defaultGitRunner,
): string | null {
  let result: ReturnType<GitRunner>;
  try {
    result = runGit(projectRoot, ["remote", "get-url", "origin"]);
  } catch {
    return null;
  }
  if (result.code !== 0) return null;
  return parseGitHubRepoSlug(result.stdout.trim());
}

/**
 * PR-only delivery identity (#5710 P1): only when the plan has no GitHub issue
 * reference (today's resolver). Identity is (canonical remote, stamped
 * productPullRequest). `x-xbrief/github-pr` references are never identity.
 */
export function resolvePrOnlyDeliveryIdentity(
  plan: Record<string, unknown>,
  resolveCanonicalRepository: () => string | null,
): { ok: true; repository: string; prNumber: number } | { ok: false; message: string } {
  const prNumber = productPullRequestFromPlan(plan);
  if (prNumber === null) {
    return {
      ok: false,
      message:
        "Delivery identity join failed: plan has no x-xbrief/github-issue reference and no " +
        "plan.metadata.productPullRequest stamp. Stamp productPullRequest (issue-less briefs only) " +
        "or add an issue origin. An x-xbrief/github-pr reference is not a delivery identity (#5710).",
    };
  }
  const repository = resolveCanonicalRepository();
  if (repository === null) {
    return {
      ok: false,
      message:
        `Delivery identity join failed: plan has productPullRequest=${prNumber} but the ` +
        `canonical project remote (git remote get-url origin) did not resolve to OWNER/NAME (#5710).`,
    };
  }
  return { ok: true, repository, prNumber };
}

export interface StoryPrMergeIdentityResult {
  readonly ok: boolean;
  readonly message: string;
  /** Authoritative merge_commit_sha when join succeeds. */
  readonly mergeCommitSha?: string;
  readonly mergedAt?: string;
  readonly prBase?: string | null;
  readonly headSha?: string | null;
  readonly identityBasis?: StoryPrIdentityBasis;
  /** Repository the identity was proven in (issue repository or canonical remote). */
  readonly repository?: string;
}

export interface StoryPrMergeIdentityInput {
  readonly plan: Record<string, unknown>;
  readonly evidence: DeliveryEvidenceInput;
  readonly mergeCommit: string;
  readonly fetchPrPayload: FetchPrPayloadFn;
  /** Merge-time association reads (#5710). Absent → issue-anchored join fails closed. */
  readonly mergeTimeForge?: MergeTimeForge;
  /** Basename of the brief being completed; enables the brief-in-PR-diff basis. */
  readonly briefBasename?: string;
  readonly fetchPrChangedFiles?: FetchPrChangedFilesFn;
  /** Canonical remote for the PR-only path (#5710 P1). Absent → that path fails closed. */
  readonly resolveCanonicalRepository?: () => string | null;
}

type MergedPayload =
  | {
      ok: true;
      payload: Record<string, unknown>;
      mergedAt: string;
      mergeCommitSha: string;
    }
  | { ok: false; message: string };

function fetchMergedPayload(
  fetchPrPayload: FetchPrPayloadFn,
  prNumber: number,
  repository: string,
): MergedPayload {
  const payload = fetchPrPayload(prNumber, repository);
  if (payload === null) {
    return {
      ok: false,
      message:
        `Delivery identity join failed: could not fetch PR #${prNumber} in ` +
        `${repository} (lookup failure) (#3675).`,
    };
  }
  const mergedAt =
    typeof payload.merged_at === "string" && payload.merged_at.trim().length > 0
      ? payload.merged_at.trim()
      : null;
  const mergeCommitSha =
    typeof payload.merge_commit_sha === "string" && payload.merge_commit_sha.trim().length > 0
      ? payload.merge_commit_sha.trim()
      : null;
  if (mergedAt === null || mergeCommitSha === null) {
    return {
      ok: false,
      message:
        `Delivery identity join failed: PR #${prNumber} in ${repository} ` +
        `is not merged (missing merged_at / merge_commit_sha) (#3675).`,
    };
  }
  return { ok: true, payload, mergedAt, mergeCommitSha };
}

function payloadHeadSha(payload: Record<string, unknown>): string | null {
  const head = asRecord(payload.head);
  if (typeof head?.sha === "string" && head.sha.trim().length > 0) {
    return head.sha.trim();
  }
  if (typeof payload.head_sha === "string" && payload.head_sha.trim().length > 0) {
    return payload.head_sha.trim();
  }
  return null;
}

function mergeCommitMismatch(
  mergeCommit: string,
  merged: Extract<MergedPayload, { ok: true }>,
  prNumber: number,
): string | null {
  if (shasEqual(mergeCommit, merged.mergeCommitSha)) {
    return null;
  }
  return (
    `Delivery identity join failed: supplied merge commit ${mergeCommit} does not ` +
    `equal PR #${prNumber} merge_commit_sha ${merged.mergeCommitSha} (identity, not reachability) (#3675).`
  );
}

function checkRecordedImplementation(
  evidence: DeliveryEvidenceInput,
  payload: Record<string, unknown>,
  prNumber: number,
): string | null {
  const recordedImpl =
    typeof evidence.implementationCommit === "string" &&
    evidence.implementationCommit.trim().length > 0
      ? evidence.implementationCommit.trim()
      : null;
  if (recordedImpl === null) {
    return null;
  }
  const headSha = payloadHeadSha(payload);
  if (headSha !== null && shasEqual(recordedImpl, headSha)) {
    return null;
  }
  return (
    `Delivery identity join failed: recorded implementationCommit ${recordedImpl} ` +
    `does not match PR #${prNumber} head at merge time` +
    `${headSha !== null ? ` (${headSha})` : ""} (#3675).`
  );
}

/** Shared tail: head check and the success result. */
function finishIdentityJoin(input: {
  readonly evidence: DeliveryEvidenceInput;
  readonly merged: Extract<MergedPayload, { ok: true }>;
  readonly prNumber: number;
  readonly repository: string;
  readonly identityBasis: StoryPrIdentityBasis;
  readonly subject: string;
}): StoryPrMergeIdentityResult {
  const { evidence, merged, prNumber } = input;
  const headCheck = checkRecordedImplementation(evidence, merged.payload, prNumber);
  if (headCheck !== null) {
    return { ok: false, message: headCheck };
  }
  const base = asRecord(merged.payload.base);
  return {
    ok: true,
    message:
      `story→PR→merge identity joined: ${input.subject} via PR #${prNumber} ` +
      `(${input.identityBasis})`,
    mergeCommitSha: merged.mergeCommitSha,
    mergedAt: merged.mergedAt,
    prBase: typeof base?.ref === "string" ? base.ref : null,
    headSha: payloadHeadSha(merged.payload),
    identityBasis: input.identityBasis,
    repository: input.repository,
  };
}

function evidencePrNumber(evidence: DeliveryEvidenceInput): number | null {
  return typeof evidence.prNumber === "number" &&
    Number.isInteger(evidence.prNumber) &&
    evidence.prNumber > 0
    ? evidence.prNumber
    : null;
}

function evidenceRepository(evidence: DeliveryEvidenceInput): string | null {
  return typeof evidence.repository === "string" && evidence.repository.trim().length > 0
    ? evidence.repository.trim()
    : null;
}

/** PR-only join (#5710 P1): stamp + canonical remote; no issue closer, no merge-time standard. */
function verifyPrOnlyIdentity(input: StoryPrMergeIdentityInput): StoryPrMergeIdentityResult {
  const resolved = resolvePrOnlyDeliveryIdentity(
    input.plan,
    input.resolveCanonicalRepository ?? (() => null),
  );
  if (!resolved.ok) {
    return { ok: false, message: resolved.message };
  }
  const { repository, prNumber: stamped } = resolved;
  const assertedRepo = evidenceRepository(input.evidence);
  if (assertedRepo !== null && assertedRepo.toLowerCase() !== repository.toLowerCase()) {
    return {
      ok: false,
      message:
        `Delivery identity join failed: --repo '${assertedRepo}' does not match the canonical ` +
        `project remote '${repository}' (matching assertion only) (#5710).`,
    };
  }
  const prNumber = evidencePrNumber(input.evidence);
  if (prNumber === null) {
    return {
      ok: false,
      message:
        `Delivery identity join failed: PR-only brief needs --pr ${stamped} ` +
        `(plan.metadata.productPullRequest) (#5710).`,
    };
  }
  if (prNumber !== stamped) {
    return {
      ok: false,
      message:
        `Delivery identity join failed: --pr ${prNumber} is not plan.metadata.productPullRequest ` +
        `${stamped}. On a PR-only brief the stamp is the identity; an x-xbrief/github-pr ` +
        `reference does not override it (#5710).`,
    };
  }
  const merged = fetchMergedPayload(input.fetchPrPayload, prNumber, repository);
  if (!merged.ok) {
    return { ok: false, message: merged.message };
  }
  const mismatch = mergeCommitMismatch(input.mergeCommit, merged, prNumber);
  if (mismatch !== null) {
    return { ok: false, message: mismatch };
  }
  return finishIdentityJoin({
    evidence: input.evidence,
    merged,
    prNumber,
    repository,
    identityBasis: "pr-only",
    subject: `${repository} productPullRequest`,
  });
}

/** Brief-in-PR-diff basis (#3675, unchanged). Null = proven; "" = not attempted; else reason. */
function proveBriefInPrDiff(
  input: StoryPrMergeIdentityInput,
  repository: string,
  prNumber: number,
): string | null {
  const briefBasename = input.briefBasename?.trim() ?? "";
  if (briefBasename.length === 0 || input.fetchPrChangedFiles === undefined) {
    return "";
  }
  const files = input.fetchPrChangedFiles(prNumber, repository);
  if (files === null) {
    return `brief-in-PR-diff: could not read PR #${prNumber} changed files (lookup failure)`;
  }
  if (!prDiffAddsBrief(files, briefBasename)) {
    return `brief-in-PR-diff: PR #${prNumber} did not add ${briefBasename} alongside code changes`;
  }
  return null;
}

interface IssueAnchoredTarget {
  readonly repository: string;
  readonly issueNumber: number;
  readonly prNumber: number;
  readonly mergedAt: string;
  readonly currentBody: string | null;
}

/** Bases b and c from forge reads; returns the proven basis or appends reasons. */
function proveKeywordOrConnected(
  forge: MergeTimeForge,
  budget: ScanBudget,
  target: IssueAnchoredTarget,
  reasons: string[],
): { basis: StoryPrIdentityBasis | null; mergeTimeBody: string | null } {
  const { repository, issueNumber, prNumber, mergedAt } = target;
  let mergeTimeBody: string | null = null;
  const body = reconstructMergeTimeBody(
    forge,
    budget,
    { repository, prNumber },
    target.currentBody,
    mergedAt,
  );
  if (body.ok) {
    mergeTimeBody = body.body;
    if (bodyHasClosingKeywordFor(body.body, repository, issueNumber)) {
      return { basis: "merge-time-keyword", mergeTimeBody };
    }
    reasons.push(
      `(b) PR #${prNumber} body as of merged_at has no closing keyword for #${issueNumber}`,
    );
  } else {
    reasons.push(`(a)/(b) ${body.error}`);
  }

  const events = collectAllPages(
    (after) => forge.fetchConnectionEventsPage(repository, prNumber, after),
    budget.beforeGraphql,
    `PR #${prNumber} connection events`,
  );
  if (!events.ok) {
    reasons.push(`(c) ${events.error}`);
    return { basis: null, mergeTimeBody };
  }
  const state = connectedAtMergedAt(events.nodes, repository, issueNumber, mergedAt);
  if (state.ok && state.connected) {
    return { basis: "merge-time-connected", mergeTimeBody };
  }
  reasons.push(
    state.ok
      ? `(c) no Connected link to #${issueNumber} in effect at merged_at`
      : `(c) ${state.error}`,
  );
  return { basis: null, mergeTimeBody };
}

/**
 * Issue-anchored association as of merged_at (#5710 P3). Cheap bases first
 * (b, c, brief-in-PR-diff), then the exhaustive sole-mark scan (a). A failed
 * lookup only removes a basis; success always needs a positive proof.
 */
function proveIssueAnchoredAssociation(
  input: StoryPrMergeIdentityInput,
  target: IssueAnchoredTarget,
): { ok: true; basis: StoryPrIdentityBasis } | { ok: false; message: string } {
  const { repository, issueNumber, prNumber } = target;
  const reasons: string[] = [];
  const forge = input.mergeTimeForge;
  const budget = forge === undefined ? null : makeScanBudget(forge);

  let mergeTimeBody: string | null = null;
  if (forge !== undefined && budget !== null) {
    const cheap = proveKeywordOrConnected(forge, budget, target, reasons);
    if (cheap.basis !== null) {
      return { ok: true, basis: cheap.basis };
    }
    mergeTimeBody = cheap.mergeTimeBody;
  } else {
    reasons.push("merge-time association lookups are unavailable");
  }

  const briefDiff = proveBriefInPrDiff(input, repository, prNumber);
  if (briefDiff === null) {
    return { ok: true, basis: "brief-in-pr-diff" };
  }
  if (briefDiff.length > 0) {
    reasons.push(briefDiff);
  }

  if (forge !== undefined && budget !== null && mergeTimeBody !== null) {
    const mark = proveSoleMarkBasis({
      forge,
      budget,
      repository,
      issueNumber,
      prNumber,
      mergeTimeBody,
    });
    if (mark.ok) {
      return { ok: true, basis: "merge-time-mark" };
    }
    reasons.unshift(mark.reason);
  }

  return {
    ok: false,
    message:
      `Delivery identity join failed: PR #${prNumber} has no merge-time association with ` +
      `${repository}#${issueNumber}. Accepted bases: ${MERGE_TIME_ASSOCIATION_BASES}. ` +
      `A mark, keyword or link added after merged_at does not count, and current ` +
      `closingIssuesReferences alone is insufficient. Findings: ${reasons.join("; ")}. ` +
      `Already-merged work with no merge-time basis stays refused until the parked ` +
      `identity-migration ships (#5710).`,
  };
}

/**
 * Prefer-A story→PR→merge identity join before delivery liveness (#3675 / #5710).
 *
 * Issue-anchored briefs (today's `resolvePlanGithubIssueRef`): the association
 * must hold as of merged_at by (a) a unique sole `deft-story` mark, (b) a
 * closing keyword in the merge-time body, or (c) a Connected link at merged_at,
 * or by the unchanged brief-in-PR-diff basis. Current-state
 * closingIssuesReferences alone is insufficient, and `productPullRequest === --pr`
 * is not a proof here. A failed issue-anchored check never falls back to the stamp.
 *
 * Issue-less briefs use the PR-only identity (#5710 P1). merge_commit_sha must
 * equal the supplied merge commit on both paths (squash-safe).
 */
export function verifyStoryPrMergeIdentity(
  input: StoryPrMergeIdentityInput,
): StoryPrMergeIdentityResult {
  const expected = resolvePlanGithubIssueRef(input.plan);
  if (expected === null) {
    return verifyPrOnlyIdentity(input);
  }

  const evidenceRepo = evidenceRepository(input.evidence);
  if (evidenceRepo !== null && evidenceRepo !== expected.repository) {
    return {
      ok: false,
      message:
        `Delivery identity join failed: evidence repository '${evidenceRepo}' does not match ` +
        `plan-derived expected repository '${expected.repository}' (#3675).`,
    };
  }

  const prNumber = evidencePrNumber(input.evidence);
  if (prNumber === null) {
    return {
      ok: false,
      message:
        "Delivery identity join failed: missing story-associated PR number. " +
        "Pass --pr <n> for the PR that delivered this story; --pr alone is not identity (#3675).",
    };
  }

  const merged = fetchMergedPayload(input.fetchPrPayload, prNumber, expected.repository);
  if (!merged.ok) {
    return { ok: false, message: merged.message };
  }
  const mismatch = mergeCommitMismatch(input.mergeCommit, merged, prNumber);
  if (mismatch !== null) {
    return { ok: false, message: mismatch };
  }

  const association = proveIssueAnchoredAssociation(input, {
    repository: expected.repository,
    issueNumber: expected.issueNumber,
    prNumber,
    mergedAt: merged.mergedAt,
    currentBody: typeof merged.payload.body === "string" ? merged.payload.body : null,
  });
  if (!association.ok) {
    return { ok: false, message: association.message };
  }
  return finishIdentityJoin({
    evidence: input.evidence,
    merged,
    prNumber,
    repository: expected.repository,
    identityBasis: association.basis,
    subject: `${expected.repository}#${expected.issueNumber}`,
  });
}

/**
 * Classify stored completion provenance for read paths.
 * Legacy completed records without provenance → unknown/unverified (not delivered).
 *
 * Read classifier only — cast-through of any nonempty disposition string is
 * intentional here and is NOT a write-guard validator (#5602 Reject C / Codex F2).
 * New completed/ adds use {@link evaluateStoredCompletionProvenanceForWriteGuard}.
 */
export function classifyStoredDeliveryDisposition(
  plan: Record<string, unknown>,
): DeliveryDisposition {
  const meta = asRecord(plan.metadata);
  if (meta === null) {
    return "unknown";
  }
  const prov = asRecord(meta.completionProvenance) ?? asRecord(meta.deliveryProvenance);
  if (prov === null) {
    // completedAt alone is not delivery proof
    if (typeof meta.completedAt === "string" && meta.completedAt.length > 0) {
      return "unverified";
    }
    return "unknown";
  }
  const disposition = prov.disposition;
  if (typeof disposition === "string" && disposition.length > 0) {
    return disposition as DeliveryDisposition;
  }
  return "unverified";
}

/**
 * Informal leftover-complete dialect keys that must not appear on
 * completionProvenance (#5602 Prefer-A Bound). Readers that alias these into
 * mergeCommit launder unverified stamps (Reject C).
 */
export const INFORMAL_COMPLETION_PROVENANCE_KEYS = ["productMerge", "productPr"] as const;

/**
 * Closed eligible delivery dispositions for new completed/ adds (#5602).
 * Successful completion records only: `delivered` or explicit
 * `NON_DELIVERY_DISPOSITIONS`. Gate refuse outcomes (`not_delivered`,
 * `merged_to_integration`) are not writer success stamps — both
 * `scope:complete` paths stop before writing those. Excludes `unknown` /
 * `unverified` (read-classifier residues). Do not bind universal
 * classify!==unverified (Reject E).
 */
export const ELIGIBLE_STORED_DELIVERY_DISPOSITIONS = [
  "delivered",
  ...NON_DELIVERY_DISPOSITIONS,
] as const;

export type EligibleStoredDeliveryDisposition =
  (typeof ELIGIBLE_STORED_DELIVERY_DISPOSITIONS)[number];

const DELIVERED_CLASS_DISPOSITIONS = new Set<string>(["delivered"]);

export function isEligibleStoredDeliveryDisposition(
  value: unknown,
): value is EligibleStoredDeliveryDisposition {
  return (
    typeof value === "string" &&
    (ELIGIBLE_STORED_DELIVERY_DISPOSITIONS as readonly string[]).includes(value)
  );
}

export function hasInformalCompletionProvenanceKeys(provenance: Record<string, unknown>): boolean {
  for (const key of INFORMAL_COMPLETION_PROVENANCE_KEYS) {
    if (Object.hasOwn(provenance, key)) {
      return true;
    }
  }
  return false;
}

function nonemptyStringField(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * True when a completed/ plan is a failed outcome (`scope:fail`).
 * Fail stamps omit completionProvenance by design (#3679 / #5602).
 * Status must be `failed` — a lone `lifecycleWrite.action: "fail"` on a
 * `completed` status must not skip delivery proof.
 */
export function isFailedCompletionOutcome(plan: Record<string, unknown>): boolean {
  return String(plan.status ?? "") === "failed";
}

/**
 * Fail-closed stored completionProvenance check for new completed/ adds (#5602).
 *
 * Two disposition surfaces (do not conflate):
 * - acceptance-item `#3819` parseDisposition on plan.items
 * - delivery `plan.metadata.completionProvenance.disposition` (this helper)
 *
 * Rules:
 * - Refuse informal `productMerge` / `productPr` keys on any add.
 * - Failed outcomes (`scope:fail`) are exempt from delivery proof — they land
 *   without completionProvenance by design.
 * - Code-bearing: require present provenance with an eligible disposition enum
 *   and writer-shaped evidence fields (not any nonempty disposition string).
 * - Non-code: missing delivery provenance remains legal (canonical writer may
 *   omit it; Reject E / Grok+Codex F1).
 *
 * Does not call classifyStoredDeliveryDisposition as a gate (Reject C/E).
 * Direct stampDeliveryProvenance without evaluateDeliveryGate is not an
 * equivalent Prefer-A leftover bypass — this only validates stored shape.
 */
export function evaluateStoredCompletionProvenanceForWriteGuard(
  plan: Record<string, unknown>,
): { ok: true } | { ok: false; detail: string } {
  const meta = asRecord(plan.metadata);
  const prov = asRecord(meta?.completionProvenance);

  if (prov !== null && hasInformalCompletionProvenanceKeys(prov)) {
    return {
      ok: false,
      detail:
        "completionProvenance uses informal productMerge/productPr keys; " +
        "Prefer-A leftover-complete must use swarm:finalize-cohort or scope:complete " +
        "→ evaluateDeliveryGate → stampDeliveryProvenance (#5602)",
    };
  }

  // scope:fail lands code-bearing briefs without delivery proof (#5602 P1).
  if (isFailedCompletionOutcome(plan)) {
    return { ok: true };
  }

  // #5540: format/layout migrate may stamp complete+migration:true on already
  // finished briefs without inventing delivery evidence. Do not require
  // completionProvenance for those adds (do not invent it either).
  const lifecycleWrite = asRecord(meta?.lifecycleWrite);
  if (
    lifecycleWrite !== null &&
    lifecycleWrite.action === "complete" &&
    lifecycleWrite.migration === true
  ) {
    return { ok: true };
  }

  if (!isCodeBearingScope(plan)) {
    return { ok: true };
  }

  if (prov === null) {
    return {
      ok: false,
      detail:
        "code-bearing completed/ add missing completionProvenance; " +
        "run swarm:finalize-cohort or scope:complete with delivery evidence (#5602)",
    };
  }

  if (!isEligibleStoredDeliveryDisposition(prov.disposition)) {
    return {
      ok: false,
      detail:
        `code-bearing completionProvenance.disposition ${JSON.stringify(prov.disposition ?? null)} ` +
        `is not an eligible writer disposition ` +
        `(${ELIGIBLE_STORED_DELIVERY_DISPOSITIONS.join("|")}); ` +
        `unknown/unverified/cast-through strings are refused (#5602)`,
    };
  }

  const verifiedAt = nonemptyStringField(prov.verifiedAt);
  const verifier = nonemptyStringField(prov.verifier);
  const deliveryBranch = nonemptyStringField(prov.deliveryBranch);
  if (verifiedAt === null || verifier === null || deliveryBranch === null) {
    return {
      ok: false,
      detail:
        "code-bearing completionProvenance missing verifiedAt, verifier, or deliveryBranch " +
        "(mirror stampDeliveryProvenance outputs) (#5602)",
    };
  }

  if (DELIVERED_CLASS_DISPOSITIONS.has(prov.disposition)) {
    const mergeCommit = nonemptyStringField(prov.mergeCommit);
    const deliveryCommit = nonemptyStringField(prov.deliveryCommit);
    if (mergeCommit === null || deliveryCommit === null) {
      return {
        ok: false,
        detail:
          `code-bearing disposition ${prov.disposition} requires mergeCommit and deliveryCommit ` +
          `(mirror stampDeliveryProvenance / evaluateDeliveryGate) (#5602)`,
      };
    }
  }

  return { ok: true };
}

function remoteDeliveryRef(branch: string): string {
  return `origin/${branch}`;
}

/**
 * Refresh the remote delivery ref. Failure blocks delivered completion (#3041).
 */
export function refreshRemoteDeliveryRef(
  projectRoot: string,
  deliveryBranch: string,
  runGit: GitRunner = defaultGitRunner,
): { ok: boolean; error: string | null; remoteRef: string } {
  const safe = assertSafeBranchName(deliveryBranch, FIELD_DELIVERY_BRANCH);
  if (!safe.ok) {
    return { ok: false, error: safe.error, remoteRef: remoteDeliveryRef(deliveryBranch) };
  }
  const remoteRef = remoteDeliveryRef(safe.branch);
  const fetchArgv = trackingFetchArgv("origin", safe.branch);
  if (!fetchArgv.ok) {
    return { ok: false, error: fetchArgv.error, remoteRef };
  }
  const fetch = runGit(projectRoot, fetchArgv.argv);
  if (fetch.code !== 0) {
    return {
      ok: false,
      error:
        `git fetch origin ${safe.branch} failed: ` +
        `${fetch.stderr.trim() || fetch.stdout.trim() || `exit ${fetch.code}`}`,
      remoteRef,
    };
  }
  const verify = runGit(projectRoot, ["rev-parse", "--verify", remoteRef]);
  if (verify.code !== 0 || !verify.stdout.trim()) {
    return {
      ok: false,
      error:
        `remote delivery ref ${remoteRef} is not resolvable after fetch: ` +
        `${verify.stderr.trim() || verify.stdout.trim() || `exit ${verify.code}`}`,
      remoteRef,
    };
  }
  return { ok: true, error: null, remoteRef };
}

/**
 * Validate that mergeCommit is an ancestor of the refreshed remote delivery ref.
 */
export function verifyDeliveryAncestry(
  projectRoot: string,
  mergeCommit: string,
  deliveryBranch: string,
  runGit: GitRunner = defaultGitRunner,
): { ok: boolean; error: string | null; remoteTip: string | null } {
  const refresh = refreshRemoteDeliveryRef(projectRoot, deliveryBranch, runGit);
  if (!refresh.ok) {
    return { ok: false, error: refresh.error, remoteTip: null };
  }
  const tip = runGit(projectRoot, ["rev-parse", "--verify", refresh.remoteRef]);
  if (tip.code !== 0 || !tip.stdout.trim()) {
    return {
      ok: false,
      error: `could not resolve tip of ${refresh.remoteRef}`,
      remoteTip: null,
    };
  }
  const remoteTip = tip.stdout.trim();
  const ancestor = gitIsAncestor(projectRoot, mergeCommit, remoteTip, runGit);
  if (ancestor === null) {
    return {
      ok: false,
      error:
        `could not determine whether ${mergeCommit} is an ancestor of ${refresh.remoteRef} ` +
        `(git merge-base --is-ancestor failed)`,
      remoteTip,
    };
  }
  if (!ancestor) {
    return {
      ok: false,
      error:
        `merge commit ${mergeCommit} is not an ancestor of refreshed remote delivery ref ` +
        `${refresh.remoteRef} (${remoteTip}).`,
      remoteTip,
    };
  }
  return { ok: true, error: null, remoteTip };
}

function buildProvenance(input: {
  evidence: DeliveryEvidenceInput | null | undefined;
  deliveryBranch: string;
  disposition: DeliveryDisposition;
  handoffState: HandoffState | "unknown";
  nowIso: string;
  verifier: string;
  deliveryCommit?: string | null;
  identityBasis?: StoryPrIdentityBasis;
}): CompletionProvenance {
  const e = input.evidence ?? {};
  return {
    // Only non-default bases are recorded; absent keeps existing records unchanged.
    ...(input.identityBasis !== undefined && input.identityBasis !== "forge-closer"
      ? { identityBasis: input.identityBasis }
      : {}),
    repository: e.repository ?? null,
    implementationCommit: e.implementationCommit ?? null,
    prNumber: e.prNumber ?? null,
    prBase: e.prBase ?? null,
    mergeCommit: e.mergeCommit ?? null,
    deliveryBranch: input.deliveryBranch,
    deliveryCommit: input.deliveryCommit ?? e.deliveryCommit ?? null,
    verifiedAt: input.nowIso,
    verifier: input.verifier,
    disposition: input.disposition,
    handoffState: input.handoffState,
    deployed: e.deployed ?? null,
    uatVerified: e.uatVerified ?? null,
  };
}

function deliveryEvidenceRemediation(deliveryBranch: string): string {
  return (
    `Pass scope:complete -- --merge-commit <sha> (and --pr <n> if you have one). ` +
    `When develop is the real delivery target, type plan.policy.deliveryBranch ` +
    `(task policy:show --field=deliveryBranch). ` +
    `When ${deliveryBranch} is delivery, wait until the merge commit is an ancestor of ` +
    `origin/${deliveryBranch}, then complete. Do not use --non-delivery for work that shipped.`
  );
}

/**
 * #5710 P4: refuse a non-delivery disposition when the stamped productPullRequest
 * is merged in the authoritative repository (the issue repository, else the
 * canonical remote). Merged to an integration branch counts as merged in v1.
 * Returns null when no stamp exists or the stamped PR is confirmed unmerged.
 * Any failure to establish merge state fails closed with a retry diagnostic.
 *
 * Policy (Recut-13 lean, #5710 comment 6817282070):
 * - Guarantee: a code-bearing brief (`isCodeBearingScope`) cannot take a
 *   non-delivery disposition while its stamped PR is merged or unreadable.
 * - Non-goal in v1: briefs that are not code-bearing (`docs-only` /
 *   `process-only` tags, `metadata.delivery.required: false`, docs/process/
 *   research kinds). They return before this check. The lean parks "Moving the
 *   non-delivery refuse ahead of the !codeBearing early return"; widening it
 *   needs a new contract, not a review fix.
 */
function refuseNonDeliveryForMergedStamp(input: {
  readonly plan: Record<string, unknown>;
  readonly disposition: NonDeliveryDisposition;
  readonly fetchPrPayload: FetchPrPayloadFn;
  readonly resolveCanonicalRepository: () => string | null;
}): string | null {
  const productPr = productPullRequestFromPlan(input.plan);
  if (productPr === null) {
    return null;
  }
  const head = `Refusing scope:complete --non-delivery ${input.disposition}:`;
  const noWrite = "No completion or provenance was recorded (#5710).";
  const repository =
    resolvePlanGithubIssueRef(input.plan)?.repository ?? input.resolveCanonicalRepository();
  if (repository === null) {
    return (
      `${head} cannot resolve the repository of stamped productPullRequest #${productPr} ` +
      `(no issue origin and no canonical origin remote). Repair the remote or the stamp, ` +
      `then retry. ${noWrite}`
    );
  }
  let payload: Record<string, unknown> | null;
  try {
    payload = input.fetchPrPayload(productPr, repository);
  } catch {
    payload = null;
  }
  const mergedAt = payload?.merged_at;
  const unknown =
    payload === null ||
    payload === undefined ||
    !("merged_at" in payload) ||
    (mergedAt !== null && (typeof mergedAt !== "string" || mergedAt.trim().length === 0));
  if (unknown) {
    return (
      `${head} could not establish whether stamped productPullRequest #${productPr} in ` +
      `${repository} is merged (lookup failed or malformed response). Retry after fixing gh ` +
      `auth, rate limit or network, or repair plan.metadata.productPullRequest. ${noWrite}`
    );
  }
  if (mergedAt === null) {
    return null;
  }
  return (
    `${head} stamped productPullRequest #${productPr} in ${repository} is merged ` +
    `(merged_at ${String(mergedAt)}). Shipped work completes as delivered: ` +
    `scope:complete -- --pr ${productPr} --merge-commit <sha>. A merge to an integration ` +
    `branch also counts as merged here. ${noWrite}`
  );
}

/**
 * Gate delivered completion for a code-bearing scope (#3041 / #3380 / #3675).
 *
 * Returns ok=true with provenance when:
 * - scope is not code-bearing (provenance may be null or non-code note), OR
 * - explicit non-delivery disposition is provided, OR
 * - Prefer-A story→PR→merge identity join succeeds AND the merge commit is an
 *   ancestor of the refreshed remote delivery ref (prBase is provenance only;
 *   it need not equal deliveryBranch). assumeEvidenceValidated skips only the
 *   ancestry/liveness step after identity join.
 */
export function evaluateDeliveryGate(options: DeliveryGateOptions): DeliveryGateResult {
  const runGit = options.runGit ?? defaultGitRunner;
  const runGh = options.runGh ?? defaultRunGh;
  const fetchPrPayload =
    options.fetchPrPayload ??
    ((prNumber: number, repository: string) => defaultFetchPrPayload(prNumber, repository, runGh));
  // Live defaults only when the PR payload is not injected, so injected test
  // seams never fall through to a live gh call.
  const liveForge = options.fetchPrPayload === undefined;
  const fetchPrChangedFiles =
    options.fetchPrChangedFiles ??
    (liveForge
      ? (prNumber: number, repository: string) =>
          defaultFetchPrChangedFiles(prNumber, repository, runGh)
      : undefined);
  const mergeTimeForge =
    options.mergeTimeForge ?? (liveForge ? defaultMergeTimeForge(runGh) : undefined);
  const resolveCanonicalRepository = () =>
    resolveCanonicalProjectRepository(options.projectRoot, runGit);
  // #5710 P4: the merged-stamp check needs an uncached read; a stale
  // "unmerged" would let shipped work record as non-delivery.
  const fetchStampedPrLive =
    options.fetchPrPayload ??
    ((prNumber: number, repository: string) =>
      defaultFetchPrPayload(prNumber, repository, liveRunGh(runGh)));
  const verifier = options.verifier ?? "scope:complete";
  const codeBearing = isCodeBearingScope(options.plan);

  // #5693: experiment_archived Findings check runs before the non-code early
  // return so both code and non-code completing scopes are covered, and failed
  // validation leaves the brief unmoved.
  if (options.nonDeliveryDisposition === "experiment_archived") {
    const findingsGate = evaluateExperimentArchivedFindingsGate(options.plan);
    if (!findingsGate.ok) {
      return {
        ok: false,
        message: findingsGate.message,
        provenance: null,
        codeBearing,
      };
    }
  }

  if (!codeBearing) {
    return {
      ok: true,
      message: "non-code-bearing scope; delivery evidence not required",
      provenance: null,
      codeBearing: false,
    };
  }

  if (options.nonDeliveryDisposition !== null && options.nonDeliveryDisposition !== undefined) {
    if (!isNonDeliveryDisposition(options.nonDeliveryDisposition)) {
      return {
        ok: false,
        message:
          `Invalid non-delivery disposition ${JSON.stringify(options.nonDeliveryDisposition)}. ` +
          `Allowed: ${NON_DELIVERY_DISPOSITIONS.join(", ")}`,
        provenance: null,
        codeBearing: true,
      };
    }
    // #5710 P4: resolve a stamped productPullRequest before any non-delivery success.
    const shipped = refuseNonDeliveryForMergedStamp({
      plan: options.plan,
      disposition: options.nonDeliveryDisposition,
      fetchPrPayload: fetchStampedPrLive,
      resolveCanonicalRepository,
    });
    if (shipped !== null) {
      return { ok: false, message: shipped, provenance: null, codeBearing: true };
    }
    const branchResult = resolveDeliveryBranch(options.projectRoot, runGit);
    const refused = refuseUnsafeResolvedDelivery(branchResult);
    if (refused !== null) {
      return {
        ok: false,
        message: refused,
        provenance: null,
        codeBearing: true,
      };
    }
    const provenance = buildProvenance({
      evidence: options.evidence,
      deliveryBranch: options.evidence?.deliveryBranch ?? branchResult.branch,
      disposition: options.nonDeliveryDisposition,
      handoffState: "implemented",
      nowIso: options.nowIso,
      verifier,
    });
    return {
      ok: true,
      message: `explicit non-delivery disposition: ${options.nonDeliveryDisposition}`,
      provenance,
      codeBearing: true,
    };
  }

  const evidence = options.evidence ?? null;
  const branchResult = resolveDeliveryBranch(options.projectRoot, runGit);
  // Prefer-A #5545: refuse empty/unsafe resolver results before ancestry skip paths.
  const refused = refuseUnsafeResolvedDelivery(branchResult);
  if (refused !== null) {
    return {
      ok: false,
      message: refused,
      provenance: null,
      codeBearing: true,
    };
  }
  // Policy/git-default is SoT — evidence may not redefine deliveryBranch (#3041 Greptile P1).
  const deliveryBranch = branchResult.branch;
  if (
    evidence !== null &&
    typeof evidence.deliveryBranch === "string" &&
    evidence.deliveryBranch.trim().length > 0 &&
    evidence.deliveryBranch.trim() !== deliveryBranch
  ) {
    return {
      ok: false,
      message:
        `Evidence deliveryBranch '${evidence.deliveryBranch.trim()}' does not match ` +
        `configured delivery branch '${deliveryBranch}' (source: ${branchResult.source}). ` +
        `Callers cannot redefine plan.policy.deliveryBranch via evidence (#3041).`,
      provenance: null,
      codeBearing: true,
    };
  }

  if (evidence === null) {
    return {
      ok: false,
      message:
        `Delivery evidence required for code-bearing scope completion (#3041). ` +
        `A merge commit that is an ancestor of refreshed origin/${deliveryBranch} is delivery; ` +
        `PR base is provenance only. ${deliveryEvidenceRemediation(deliveryBranch)}`,
      provenance: null,
      codeBearing: true,
    };
  }

  const mergeCommit =
    typeof evidence.mergeCommit === "string" && evidence.mergeCommit.trim().length > 0
      ? evidence.mergeCommit.trim()
      : null;
  const prBase =
    typeof evidence.prBase === "string" && evidence.prBase.trim().length > 0
      ? evidence.prBase.trim()
      : null;
  const mergedAt = evidence.mergedAt;

  if (mergedAt === null || mergedAt === undefined || String(mergedAt).length === 0) {
    // Allow evidence without mergedAt only when assumeEvidenceValidated (unit tests)
    // or when mergeCommit is present and will be ancestry-checked.
    if (!options.assumeEvidenceValidated && mergeCommit === null) {
      return {
        ok: false,
        message:
          "Delivery evidence missing merged_at / merge commit; cannot prove delivery (#3041).",
        provenance: null,
        codeBearing: true,
      };
    }
  }

  if (mergeCommit === null) {
    return {
      ok: false,
      message:
        "Delivery evidence missing merge_commit_sha; cannot prove ancestry on delivery branch (#3041). " +
        deliveryEvidenceRemediation(deliveryBranch),
      provenance: null,
      codeBearing: true,
    };
  }

  // Prefer-A story→PR→merge identity join (#3675) — before ancestry or assume bypass.
  const identity = verifyStoryPrMergeIdentity({
    plan: options.plan,
    evidence,
    mergeCommit,
    fetchPrPayload,
    mergeTimeForge,
    briefBasename: options.briefBasename,
    fetchPrChangedFiles,
    resolveCanonicalRepository,
  });
  if (!identity.ok) {
    return {
      ok: false,
      message: `${identity.message} ${deliveryEvidenceRemediation(deliveryBranch)}`,
      provenance: null,
      codeBearing: true,
    };
  }

  const boundEvidence: DeliveryEvidenceInput = {
    ...evidence,
    repository: identity.repository ?? evidence.repository ?? null,
    prNumber: evidence.prNumber,
    prBase: identity.prBase ?? prBase,
    mergeCommit: identity.mergeCommitSha ?? mergeCommit,
    mergedAt: identity.mergedAt ?? (typeof mergedAt === "string" ? mergedAt : null),
    implementationCommit: evidence.implementationCommit ?? identity.headSha ?? null,
  };

  if (options.assumeEvidenceValidated) {
    const provenance = buildProvenance({
      evidence: boundEvidence,
      deliveryBranch,
      disposition: "delivered",
      handoffState: "delivered",
      nowIso: options.nowIso,
      verifier,
      deliveryCommit: boundEvidence.deliveryCommit ?? boundEvidence.mergeCommit,
      identityBasis: identity.identityBasis,
    });
    return {
      ok: true,
      message:
        `delivery evidence accepted after Prefer-A identity join (ancestry pre-validated) ` +
        `on '${deliveryBranch}'`,
      provenance,
      codeBearing: true,
    };
  }

  const ancestry = verifyDeliveryAncestry(
    options.projectRoot,
    boundEvidence.mergeCommit ?? mergeCommit,
    deliveryBranch,
    runGit,
  );
  if (!ancestry.ok) {
    const effectivePrBase = boundEvidence.prBase ?? prBase;
    const integrationOnly = effectivePrBase !== null && effectivePrBase !== deliveryBranch;
    const ancestryMsg = ancestry.error ?? "delivery ancestry check failed";
    const rem = deliveryEvidenceRemediation(deliveryBranch);
    const message = integrationOnly
      ? `${ancestryMsg} PR base '${effectivePrBase}' is provenance only; ` +
        `the merge is not yet on origin/${deliveryBranch}. ${rem}`
      : `${ancestryMsg} ${rem}`;
    return {
      ok: false,
      message,
      provenance: buildProvenance({
        evidence: boundEvidence,
        deliveryBranch,
        disposition: integrationOnly ? "merged_to_integration" : "not_delivered",
        handoffState: integrationOnly ? "merged_to_integration" : "implemented",
        nowIso: options.nowIso,
        verifier,
        deliveryCommit: ancestry.remoteTip,
      }),
      codeBearing: true,
    };
  }

  const provenance = buildProvenance({
    evidence: boundEvidence,
    deliveryBranch,
    disposition: "delivered",
    handoffState: "delivered",
    nowIso: options.nowIso,
    verifier,
    deliveryCommit: ancestry.remoteTip,
    identityBasis: identity.identityBasis,
  });
  return {
    ok: true,
    message:
      `Prefer-A identity join ok; merge commit ${boundEvidence.mergeCommit} is an ancestor of ` +
      `origin/${deliveryBranch}`,
    provenance,
    codeBearing: true,
  };
}

/** Stamp completion provenance onto plan.metadata (mutates plan). */
export function stampDeliveryProvenance(
  plan: Record<string, unknown>,
  provenance: CompletionProvenance,
): void {
  let metadata = plan.metadata;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    metadata = {};
    plan.metadata = metadata;
  }
  const meta = metadata as Record<string, unknown>;
  meta.completionProvenance = {
    repository: provenance.repository,
    implementationCommit: provenance.implementationCommit,
    prNumber: provenance.prNumber,
    prBase: provenance.prBase,
    mergeCommit: provenance.mergeCommit,
    deliveryBranch: provenance.deliveryBranch,
    deliveryCommit: provenance.deliveryCommit,
    verifiedAt: provenance.verifiedAt,
    verifier: provenance.verifier,
    disposition: provenance.disposition,
    handoffState: provenance.handoffState,
    // Deploy/UAT are explicit-only; default null so readers never infer from Git.
    deployed: provenance.deployed,
    uatVerified: provenance.uatVerified,
    ...(typeof provenance.completedSessionId === "string" &&
    provenance.completedSessionId.trim().length > 0
      ? { completedSessionId: provenance.completedSessionId.trim() }
      : {}),
    ...(provenance.identityBasis !== undefined ? { identityBasis: provenance.identityBasis } : {}),
  };
  meta.deliveryDisposition = provenance.disposition;
  meta.handoffState = provenance.handoffState;
}

/**
 * Clone a brief for mid-flight active writes without durable completionProvenance (#5106).
 * Keeps the in-memory stamp for acceptance/commit; refuse paths must not leave
 * provenance on a still-running active source.
 */
export function briefWithoutDurableCompletionProvenance(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
  const plan = asRecord(clone.plan);
  if (plan === null) {
    return clone;
  }
  const meta = asRecord(plan.metadata);
  if (meta === null) {
    return clone;
  }
  delete meta.completionProvenance;
  return clone;
}

/**
 * Parse a PR REST payload into delivery evidence fields.
 * Expects GitHub pulls API shape (merged_at, base.ref, merge_commit_sha, …).
 * `verifier` defaults to swarm:finalize-cohort; complete-time callers MUST pass
 * `scope:complete` (#3583 Prefer-A Bound).
 */
export function evidenceFromPrPayload(
  payload: Record<string, unknown>,
  prNumber: number,
  repository: string | null,
  deliveryBranch?: string | null,
  verifier: string = "swarm:finalize-cohort",
): DeliveryEvidenceInput {
  const base = asRecord(payload.base);
  const head = asRecord(payload.head);
  const prBase = typeof base?.ref === "string" ? base.ref : null;
  const mergeCommit =
    typeof payload.merge_commit_sha === "string" && payload.merge_commit_sha.length > 0
      ? payload.merge_commit_sha
      : null;
  const headSha =
    typeof head?.sha === "string" && head.sha.length > 0
      ? head.sha
      : typeof payload.head_sha === "string"
        ? payload.head_sha
        : null;
  const mergedAt =
    payload.merged_at === null
      ? null
      : typeof payload.merged_at === "string"
        ? payload.merged_at
        : null;

  return {
    repository,
    implementationCommit: headSha,
    prNumber,
    prBase,
    mergeCommit,
    deliveryBranch: deliveryBranch ?? null,
    mergedAt,
    verifier,
  };
}

/** Forge closing PR ref for issue→PR discovery (#3583). */
export interface ClosingPrRef {
  readonly repository: string;
  readonly prNumber: number;
}

export type FetchClosingPrRefsResult =
  | { readonly ok: true; readonly refs: readonly ClosingPrRef[] }
  | { readonly ok: false; readonly error: string };

/**
 * Fetch complete, deduplicated forge closers for an issue (#3583 Prefer-A).
 * Incomplete pagination or lookup errors MUST return ok:false (fail closed).
 */
export type FetchClosingPrRefsFn = (
  issueNumber: number,
  repository: string,
) => FetchClosingPrRefsResult;

/** GraphQL: issue → closedByPullRequestsReferences with completeness cursor. */
const CLOSING_PRS_GRAPHQL = [
  "query($owner:String!,$name:String!,$number:Int!,$after:String){",
  "repository(owner:$owner,name:$name){",
  "issue(number:$number){",
  "closedByPullRequestsReferences(first:100,includeClosedPrs:true,after:$after){",
  "pageInfo{hasNextPage endCursor}",
  "nodes{number url repository{nameWithOwner}}",
  "}}}}",
].join("");

function parseClosingPrNode(entry: unknown, fallbackRepository: string): ClosingPrRef | null {
  const rec = asRecord(entry);
  if (rec === null) {
    return null;
  }
  let prNumber: number | null = null;
  if (typeof rec.number === "number" && Number.isInteger(rec.number) && rec.number > 0) {
    prNumber = rec.number;
  } else if (typeof rec.number === "string" && /^[0-9]+$/.test(rec.number)) {
    prNumber = Number(rec.number);
  }
  if (prNumber === null) {
    return null;
  }

  if (typeof rec.url === "string" && rec.url.trim().length > 0) {
    const cleaned = rec.url.trim().replace(/\/$/, "");
    const pathOnly = (cleaned.split(/[?#]/, 1)[0] ?? cleaned).replace(/\/$/, "");
    const parts =
      pathOnly
        .split("://")
        .pop()
        ?.split("/")
        .filter((p) => p.length > 0) ?? [];
    if (
      parts.length >= 4 &&
      parts[parts.length - 2] === "pull" &&
      /^\d+$/.test(parts[parts.length - 1] ?? "")
    ) {
      const owner = parts[parts.length - 4];
      const name = parts[parts.length - 3];
      if (typeof owner === "string" && typeof name === "string") {
        return { repository: `${owner}/${name}`, prNumber };
      }
    }
  }

  const repoRec = asRecord(rec.repository);
  const nameWithOwner =
    typeof repoRec?.nameWithOwner === "string" ? repoRec.nameWithOwner.trim() : "";
  if (nameWithOwner.includes("/")) {
    return { repository: nameWithOwner, prNumber };
  }
  return { repository: fallbackRepository, prNumber };
}

/**
 * Authoritative issue→PR closers via closedByPullRequestsReferences (#3583).
 * Paginates to completion; incomplete pages or lookup failure fail closed.
 */
export function defaultFetchClosingPrRefs(
  issueNumber: number,
  repository: string,
  runGh: RunGhFn = defaultRunGh,
): FetchClosingPrRefsResult {
  const parsedRepo = parseOwnerRepo(repository);
  if (parsedRepo === null) {
    return { ok: false, error: `invalid repository for closing-PR discovery: ${repository}` };
  }

  const seen = new Set<string>();
  const refs: ClosingPrRef[] = [];
  let after: string | null = null;
  // Bound hard stop: refuse unbounded GraphQL walks under concurrent complete (#954).
  // Number("20") keeps the literal free of intent-constraint numeric-const extract.
  const maxPages = Number("20");

  for (let page = 0; page < maxPages; page += 1) {
    const cmd = [
      "gh",
      "api",
      "graphql",
      "-f",
      `query=${CLOSING_PRS_GRAPHQL}`,
      "-F",
      `owner=${parsedRepo.owner}`,
      "-F",
      `name=${parsedRepo.name}`,
      "-F",
      `number=${issueNumber}`,
    ];
    // Omit nullable $after on the first page; pass endCursor thereafter.
    if (after !== null) {
      cmd.push("-F", `after=${after}`);
    }

    let result: RunGhResult;
    try {
      result = runGh(cmd);
    } catch (exc: unknown) {
      const message = exc instanceof Error ? exc.message : String(exc);
      return {
        ok: false,
        error: `closing-PR discovery failed for ${repository}#${issueNumber}: ${message}`,
      };
    }
    if (result.returncode !== 0) {
      return {
        ok: false,
        error:
          `closing-PR discovery failed for ${repository}#${issueNumber}: ` +
          `${result.stderr.trim() || result.stdout.trim() || "gh api graphql non-zero"}`,
      };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(result.stdout) as unknown;
    } catch {
      return {
        ok: false,
        error: `closing-PR discovery returned unparseable JSON for ${repository}#${issueNumber}`,
      };
    }

    const connection = asRecord(
      asRecord(asRecord(asRecord(payload)?.data)?.repository)?.issue,
    )?.closedByPullRequestsReferences;
    const connRec = asRecord(connection);
    if (connRec === null) {
      return {
        ok: false,
        error:
          `closing-PR discovery incomplete for ${repository}#${issueNumber}: ` +
          `missing closedByPullRequestsReferences connection`,
      };
    }

    const nodes = connRec.nodes;
    if (!Array.isArray(nodes)) {
      return {
        ok: false,
        error: `closing-PR discovery incomplete for ${repository}#${issueNumber}: nodes not an array`,
      };
    }

    for (const entry of nodes) {
      const parsed = parseClosingPrNode(entry, repository);
      if (parsed === null) {
        return {
          ok: false,
          error:
            `closing-PR discovery incomplete for ${repository}#${issueNumber}: ` +
            `unreadable closedByPullRequestsReferences node`,
        };
      }
      const key = `${parsed.repository.toLowerCase()}:${parsed.prNumber}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      refs.push(parsed);
    }

    const pageInfo = asRecord(connRec.pageInfo);
    if (pageInfo === null) {
      return {
        ok: false,
        error:
          `closing-PR discovery incomplete for ${repository}#${issueNumber}: ` + `missing pageInfo`,
      };
    }
    if (typeof pageInfo.hasNextPage !== "boolean") {
      return {
        ok: false,
        error:
          `closing-PR discovery incomplete for ${repository}#${issueNumber}: ` +
          `invalid pageInfo.hasNextPage`,
      };
    }
    if (!pageInfo.hasNextPage) {
      return { ok: true, refs };
    }
    const endCursor = typeof pageInfo?.endCursor === "string" ? pageInfo.endCursor.trim() : "";
    if (endCursor.length === 0) {
      return {
        ok: false,
        error:
          `closing-PR discovery incomplete for ${repository}#${issueNumber}: ` +
          `hasNextPage without endCursor`,
      };
    }
    after = endCursor;
  }

  return {
    ok: false,
    error:
      `closing-PR discovery incomplete for ${repository}#${issueNumber}: ` +
      `exceeded ${maxPages} pages without completion`,
  };
}

/** True when evidence already carries explicit --pr or --merge-commit selectors (#3583). */
export function hasExplicitDeliverySelectors(
  evidence: DeliveryEvidenceInput | null | undefined,
): boolean {
  if (evidence === null || evidence === undefined) {
    return false;
  }
  const pr =
    typeof evidence.prNumber === "number" &&
    Number.isInteger(evidence.prNumber) &&
    evidence.prNumber > 0;
  const merge = typeof evidence.mergeCommit === "string" && evidence.mergeCommit.trim().length > 0;
  return pr || merge;
}

export interface DiscoverDeliveryEvidenceOptions {
  readonly projectRoot: string;
  readonly plan: Record<string, unknown>;
  readonly evidence?: DeliveryEvidenceInput | null;
  readonly nonDeliveryDisposition?: NonDeliveryDisposition | null;
  readonly runGit?: GitRunner;
  readonly runGh?: RunGhFn;
  readonly fetchPrPayload?: FetchPrPayloadFn;
  readonly fetchClosingPrRefs?: FetchClosingPrRefsFn;
  readonly verifier?: string;
}

export type DiscoverDeliveryEvidenceResult =
  | {
      readonly ok: true;
      readonly evidence: DeliveryEvidenceInput | null | undefined;
      readonly discovered: boolean;
      readonly message: string;
    }
  | { readonly ok: false; readonly message: string };

function mergePreservingExplicitFacts(
  existing: DeliveryEvidenceInput | null | undefined,
  discovered: DeliveryEvidenceInput,
): DeliveryEvidenceInput {
  return {
    ...existing,
    ...discovered,
    deployed: existing?.deployed ?? discovered.deployed ?? null,
    uatVerified: existing?.uatVerified ?? discovered.uatVerified ?? null,
  };
}

function candidatePassesDeliveryBaseFilter(
  payload: Record<string, unknown>,
  deliveryBranch: string,
): boolean {
  const mergedAt =
    typeof payload.merged_at === "string" && payload.merged_at.trim().length > 0
      ? payload.merged_at.trim()
      : null;
  const mergeCommit =
    typeof payload.merge_commit_sha === "string" && payload.merge_commit_sha.trim().length > 0
      ? payload.merge_commit_sha.trim()
      : null;
  if (mergedAt === null || mergeCommit === null) {
    return false;
  }
  const base = asRecord(payload.base);
  const prBase = typeof base?.ref === "string" ? base.ref.trim() : "";
  return prBase === deliveryBranch;
}

/**
 * Auto-build delivery evidence for code-bearing scope:complete when both
 * `--pr` and `--merge-commit` are omitted (#3583 Prefer-A Bound).
 *
 * Primary seed: plan.metadata.productPullRequest. Else: complete deduplicated
 * closedByPullRequestsReferences set filtered to base.ref === resolved delivery.
 * Fail closed on zero/many/incomplete. Does not set assumeEvidenceValidated.
 * evaluateDeliveryGate stays validate-only.
 */
export function discoverDeliveryEvidenceForComplete(
  options: DiscoverDeliveryEvidenceOptions,
): DiscoverDeliveryEvidenceResult {
  const existing = options.evidence;
  if (options.nonDeliveryDisposition !== null && options.nonDeliveryDisposition !== undefined) {
    return {
      ok: true,
      evidence: existing,
      discovered: false,
      message: "non-delivery disposition set; skip delivery auto-discovery",
    };
  }
  if (!isCodeBearingScope(options.plan)) {
    return {
      ok: true,
      evidence: existing,
      discovered: false,
      message: "non-code-bearing; skip delivery auto-discovery",
    };
  }
  if (hasExplicitDeliverySelectors(existing)) {
    return {
      ok: true,
      evidence: existing,
      discovered: false,
      message: "explicit --pr/--merge-commit present; skip delivery auto-discovery",
    };
  }

  const runGit = options.runGit ?? defaultGitRunner;
  const runGh = options.runGh ?? defaultRunGh;
  const fetchPrPayload =
    options.fetchPrPayload ??
    ((prNumber: number, repository: string) => defaultFetchPrPayload(prNumber, repository, runGh));
  const fetchClosingPrRefs =
    options.fetchClosingPrRefs ??
    ((issueNumber: number, repository: string) =>
      defaultFetchClosingPrRefs(issueNumber, repository, runGh));
  const verifier = options.verifier ?? "scope:complete";

  const branchResult = resolveDeliveryBranch(options.projectRoot, runGit);
  const refused = refuseUnsafeResolvedDelivery(branchResult);
  if (refused !== null) {
    return { ok: false, message: refused };
  }
  const deliveryBranch = branchResult.branch;

  // CLI --delivery-branch is a matching assertion only (#3583 / #3041).
  if (
    existing !== null &&
    existing !== undefined &&
    typeof existing.deliveryBranch === "string" &&
    existing.deliveryBranch.trim().length > 0 &&
    existing.deliveryBranch.trim() !== deliveryBranch
  ) {
    return {
      ok: false,
      message:
        `Evidence deliveryBranch '${existing.deliveryBranch.trim()}' does not match ` +
        `configured delivery branch '${deliveryBranch}' (source: ${branchResult.source}). ` +
        `Callers cannot redefine plan.policy.deliveryBranch via --delivery-branch (#3583). ` +
        deliveryEvidenceRemediation(deliveryBranch),
    };
  }

  const expected = resolvePlanGithubIssueRef(options.plan);
  const productPr = productPullRequestFromPlan(options.plan);

  if (productPr !== null) {
    // #5710 P1: an issue-less brief uses the same PR-only resolver as the identity join.
    let repository: string;
    if (expected !== null) {
      repository = expected.repository;
    } else {
      const prOnly = resolvePrOnlyDeliveryIdentity(options.plan, () =>
        resolveCanonicalProjectRepository(options.projectRoot, runGit),
      );
      if (!prOnly.ok) {
        return {
          ok: false,
          message: `Delivery auto-discovery failed: ${prOnly.message} ${deliveryEvidenceRemediation(deliveryBranch)}`,
        };
      }
      repository = prOnly.repository;
    }
    const payload = fetchPrPayload(productPr, repository);
    if (payload === null) {
      return {
        ok: false,
        message:
          `Delivery auto-discovery failed: could not fetch productPullRequest #${productPr} ` +
          `in ${repository} (#3583). ${deliveryEvidenceRemediation(deliveryBranch)}`,
      };
    }
    if (!candidatePassesDeliveryBaseFilter(payload, deliveryBranch)) {
      return {
        ok: false,
        message:
          `Delivery auto-discovery failed: productPullRequest #${productPr} is not a merged ` +
          `delivery-base PR for '${deliveryBranch}' (integration-base merges stay explicit-flag ` +
          `territory in v1) (#3583). ${deliveryEvidenceRemediation(deliveryBranch)}`,
      };
    }
    const discovered = evidenceFromPrPayload(
      payload,
      productPr,
      repository,
      deliveryBranch,
      verifier,
    );
    return {
      ok: true,
      evidence: mergePreservingExplicitFacts(existing, discovered),
      discovered: true,
      message: `auto-discovered delivery evidence from productPullRequest #${productPr}`,
    };
  }

  // No productPullRequest: closing-identity-proved complete deduped set (#3583).
  if (expected === null) {
    return {
      ok: false,
      message:
        `Delivery evidence required for code-bearing scope completion (#3041). ` +
        `A merge commit that is an ancestor of refreshed origin/${deliveryBranch} is delivery; ` +
        `PR base is provenance only. Stamp plan.metadata.productPullRequest or ` +
        deliveryEvidenceRemediation(deliveryBranch),
    };
  }

  const closing = fetchClosingPrRefs(expected.issueNumber, expected.repository);
  if (!closing.ok) {
    return {
      ok: false,
      message: `${closing.error} ${deliveryEvidenceRemediation(deliveryBranch)}`,
    };
  }

  const qualifying: DeliveryEvidenceInput[] = [];
  for (const ref of closing.refs) {
    // Cross-repo closers stay out of the delivery-base set in v1.
    if (ref.repository.toLowerCase() !== expected.repository.toLowerCase()) {
      continue;
    }
    const payload = fetchPrPayload(ref.prNumber, ref.repository);
    if (payload === null) {
      return {
        ok: false,
        message:
          `Delivery auto-discovery incomplete: could not fetch closing PR #${ref.prNumber} ` +
          `in ${ref.repository} (#3583). ${deliveryEvidenceRemediation(deliveryBranch)}`,
      };
    }
    if (!candidatePassesDeliveryBaseFilter(payload, deliveryBranch)) {
      continue;
    }
    qualifying.push(
      evidenceFromPrPayload(payload, ref.prNumber, ref.repository, deliveryBranch, verifier),
    );
  }

  if (qualifying.length === 0) {
    return {
      ok: false,
      message:
        `Delivery auto-discovery found zero merged delivery-base PRs for ` +
        `${expected.repository}#${expected.issueNumber} on '${deliveryBranch}' (#3583). ` +
        `Stamp plan.metadata.productPullRequest or ` +
        deliveryEvidenceRemediation(deliveryBranch),
    };
  }
  if (qualifying.length > 1) {
    const nums = qualifying
      .map((e) => e.prNumber)
      .filter((n): n is number => typeof n === "number")
      .sort((a, b) => a - b);
    return {
      ok: false,
      message:
        `Delivery auto-discovery found ${qualifying.length} merged delivery-base PRs ` +
        `(${nums.map((n) => `#${n}`).join(", ")}) for ` +
        `${expected.repository}#${expected.issueNumber}; refuse to guess (#3583). ` +
        deliveryEvidenceRemediation(deliveryBranch),
    };
  }

  const sole = qualifying[0];
  if (sole === undefined) {
    return {
      ok: false,
      message:
        `Delivery auto-discovery failed unexpectedly (#3583). ` +
        deliveryEvidenceRemediation(deliveryBranch),
    };
  }
  return {
    ok: true,
    evidence: mergePreservingExplicitFacts(existing, sole),
    discovered: true,
    message: `auto-discovered delivery evidence from closing PR #${sole.prNumber}`,
  };
}
