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

import { closerSetFromIssueIds } from "../one-pr-unit/closer-set.js";
import { resolveDeliveryBranch } from "../policy/delivery-branch.js";
import { defaultRunGh } from "../pr-protected-issues/gh.js";
import type { RunGhFn, RunGhResult } from "../pr-protected-issues/types.js";
import { defaultGitRunner, type GitRunner, gitIsAncestor } from "../session/git.js";
import { readRitualState } from "../session/ritual-sentinel.js";

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
  /** Optional gh runner for default PR / closing-ref fetchers (#3675). */
  readonly runGh?: RunGhFn;
  /** Test / inject seam: pulls REST payload fetcher (#3675). */
  readonly fetchPrPayload?: FetchPrPayloadFn;
  /** Test / inject seam: authoritative closing issue ids only (#3675). */
  readonly fetchClosingIssueIds?: FetchClosingIssueIdsFn;
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

export interface StoryPrMergeIdentityResult {
  readonly ok: boolean;
  readonly message: string;
  /** Authoritative merge_commit_sha when join succeeds. */
  readonly mergeCommitSha?: string;
  readonly mergedAt?: string;
  readonly prBase?: string | null;
  readonly headSha?: string | null;
}

/**
 * Prefer-A story→PR→merge identity join before delivery liveness (#3675).
 *
 * Uses plan-derived expected repo/issue, authoritative closingIssuesReferences
 * with per-issue repository preserved (not reassigned to the plan repo), and
 * merge_commit_sha identity equality. Does not require implementationCommit
 * ancestry (squash-safe).
 */
export function verifyStoryPrMergeIdentity(input: {
  readonly plan: Record<string, unknown>;
  readonly evidence: DeliveryEvidenceInput;
  readonly mergeCommit: string;
  readonly fetchPrPayload: FetchPrPayloadFn;
  readonly fetchClosingIssueIds: FetchClosingIssueIdsFn;
}): StoryPrMergeIdentityResult {
  const expected = resolvePlanGithubIssueRef(input.plan);
  if (expected === null) {
    return {
      ok: false,
      message:
        "Delivery identity join failed: plan has no x-xbrief/github-issue reference " +
        "to derive expected repository/issue (#3675).",
    };
  }

  const evidenceRepo =
    typeof input.evidence.repository === "string" && input.evidence.repository.trim().length > 0
      ? input.evidence.repository.trim()
      : null;
  if (evidenceRepo !== null && evidenceRepo !== expected.repository) {
    return {
      ok: false,
      message:
        `Delivery identity join failed: evidence repository '${evidenceRepo}' does not match ` +
        `plan-derived expected repository '${expected.repository}' (#3675).`,
    };
  }

  const prNumber =
    typeof input.evidence.prNumber === "number" &&
    Number.isInteger(input.evidence.prNumber) &&
    input.evidence.prNumber > 0
      ? input.evidence.prNumber
      : null;
  if (prNumber === null) {
    return {
      ok: false,
      message:
        "Delivery identity join failed: missing story-associated PR number. " +
        "Pass --pr <n> for the PR that forge-closes this story; --pr alone is not identity (#3675).",
    };
  }

  const payload = input.fetchPrPayload(prNumber, expected.repository);
  if (payload === null) {
    return {
      ok: false,
      message:
        `Delivery identity join failed: could not fetch PR #${prNumber} in ` +
        `${expected.repository} (lookup failure) (#3675).`,
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
        `Delivery identity join failed: PR #${prNumber} in ${expected.repository} ` +
        `is not merged (missing merged_at / merge_commit_sha) (#3675).`,
    };
  }

  const linked = input.fetchClosingIssueIds(prNumber, expected.repository);
  if (linked === null) {
    return {
      ok: false,
      message:
        `Delivery identity join failed: could not fetch closingIssuesReferences for ` +
        `PR #${prNumber} in ${expected.repository} (#3675).`,
    };
  }
  const closerSet = linked.flatMap((ref) =>
    closerSetFromIssueIds(ref.repository, [ref.issueNumber]),
  );
  const expectedRepoKey = expected.repository.trim().toLowerCase();
  const closesStory = closerSet.some(
    (origin) => origin.repo === expectedRepoKey && origin.issueId === expected.issueNumber,
  );
  if (!closesStory) {
    return {
      ok: false,
      message:
        `Delivery identity join failed: PR #${prNumber} forge closer set does not include ` +
        `${expected.repository}#${expected.issueNumber} (wrong story / absent association) (#3675).`,
    };
  }

  if (!shasEqual(input.mergeCommit, mergeCommitSha)) {
    return {
      ok: false,
      message:
        `Delivery identity join failed: supplied merge commit ${input.mergeCommit} does not ` +
        `equal PR #${prNumber} merge_commit_sha ${mergeCommitSha} (identity, not reachability) (#3675).`,
    };
  }

  const base = asRecord(payload.base);
  const head = asRecord(payload.head);
  const prBase = typeof base?.ref === "string" ? base.ref : null;
  const headSha =
    typeof head?.sha === "string" && head.sha.trim().length > 0
      ? head.sha.trim()
      : typeof payload.head_sha === "string" && payload.head_sha.trim().length > 0
        ? payload.head_sha.trim()
        : null;

  const recordedImpl =
    typeof input.evidence.implementationCommit === "string" &&
    input.evidence.implementationCommit.trim().length > 0
      ? input.evidence.implementationCommit.trim()
      : null;
  if (recordedImpl !== null) {
    if (headSha === null || !shasEqual(recordedImpl, headSha)) {
      return {
        ok: false,
        message:
          `Delivery identity join failed: recorded implementationCommit ${recordedImpl} ` +
          `does not match PR #${prNumber} head at merge time` +
          `${headSha !== null ? ` (${headSha})` : ""} (#3675).`,
      };
    }
  }

  return {
    ok: true,
    message: `story→PR→merge identity joined: ${expected.repository}#${expected.issueNumber} via PR #${prNumber}`,
    mergeCommitSha,
    mergedAt,
    prBase,
    headSha,
  };
}

/**
 * Classify stored completion provenance for read paths.
 * Legacy completed records without provenance → unknown/unverified (not delivered).
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
  const remoteRef = remoteDeliveryRef(deliveryBranch);
  const fetch = runGit(projectRoot, ["fetch", "origin", deliveryBranch]);
  if (fetch.code !== 0) {
    return {
      ok: false,
      error:
        `git fetch origin ${deliveryBranch} failed: ` +
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
}): CompletionProvenance {
  const e = input.evidence ?? {};
  return {
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
  const fetchClosingIssueIds =
    options.fetchClosingIssueIds ??
    ((prNumber: number, repository: string) =>
      defaultFetchClosingIssueIds(prNumber, repository, runGh));
  const verifier = options.verifier ?? "scope:complete";
  const codeBearing = isCodeBearingScope(options.plan);

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
    const branchResult = resolveDeliveryBranch(options.projectRoot, runGit);
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
    fetchClosingIssueIds,
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
    repository: resolvePlanGithubIssueRef(options.plan)?.repository ?? evidence.repository ?? null,
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
 */
export function evidenceFromPrPayload(
  payload: Record<string, unknown>,
  prNumber: number,
  repository: string | null,
  deliveryBranch?: string | null,
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
    verifier: "swarm:finalize-cohort",
  };
}
