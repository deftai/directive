/**
 * Delivery integrity for scope completion (#3041).
 *
 * A code-bearing scope must not acquire a delivered disposition unless the
 * merge/delivered commit is an ancestor of the refreshed remote delivery ref,
 * or an explicit auditable non-delivery disposition is recorded.
 *
 * Deploy / UAT are separate axes and MUST NOT be inferred from Git alone.
 */

import { resolveDeliveryBranch } from "../policy/delivery-branch.js";
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
  /** Session that completed the brief; used by check to target xbrief/completed (#3357). */
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

export interface DeliveryGateOptions {
  readonly projectRoot: string;
  readonly plan: Record<string, unknown>;
  readonly nowIso: string;
  readonly evidence?: DeliveryEvidenceInput | null;
  readonly nonDeliveryDisposition?: NonDeliveryDisposition | null;
  readonly runGit?: GitRunner;
  readonly verifier?: string;
  /**
   * When true, skip remote refresh + ancestry (tests only that inject pre-validated
   * evidence). Production callers leave this false.
   */
  readonly assumeEvidenceValidated?: boolean;
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
  const refs = plan.references;
  if (!Array.isArray(refs)) {
    return false;
  }
  for (const ref of refs) {
    const rec = asRecord(ref);
    if (rec === null) continue;
    const type = typeof rec.type === "string" ? rec.type : "";
    const uri = typeof rec.uri === "string" ? rec.uri : "";
    if (type.includes("github-issue") || /github\.com\/[^/]+\/[^/]+\/issues\/\d+/i.test(uri)) {
      return true;
    }
  }
  return false;
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
 * Gate delivered completion for a code-bearing scope (#3041 / #3380).
 *
 * Returns ok=true with provenance when:
 * - scope is not code-bearing (provenance may be null or non-code note), OR
 * - explicit non-delivery disposition is provided, OR
 * - merge commit is an ancestor of the refreshed remote delivery ref (prBase is
 *   provenance only; it need not equal deliveryBranch).
 */
export function evaluateDeliveryGate(options: DeliveryGateOptions): DeliveryGateResult {
  const runGit = options.runGit ?? defaultGitRunner;
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

  if (options.assumeEvidenceValidated) {
    const provenance = buildProvenance({
      evidence,
      deliveryBranch,
      disposition: "delivered",
      handoffState: "delivered",
      nowIso: options.nowIso,
      verifier,
      deliveryCommit: evidence.deliveryCommit ?? mergeCommit,
    });
    return {
      ok: true,
      message: `delivery evidence accepted (pre-validated) on '${deliveryBranch}'`,
      provenance,
      codeBearing: true,
    };
  }

  const ancestry = verifyDeliveryAncestry(options.projectRoot, mergeCommit, deliveryBranch, runGit);
  if (!ancestry.ok) {
    const integrationOnly = prBase !== null && prBase !== deliveryBranch;
    const ancestryMsg = ancestry.error ?? "delivery ancestry check failed";
    const rem = deliveryEvidenceRemediation(deliveryBranch);
    const message = integrationOnly
      ? `${ancestryMsg} PR base '${prBase}' is provenance only; ` +
        `the merge is not yet on origin/${deliveryBranch}. ${rem}`
      : `${ancestryMsg} ${rem}`;
    return {
      ok: false,
      message,
      provenance: buildProvenance({
        evidence,
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
    evidence,
    deliveryBranch,
    disposition: "delivered",
    handoffState: "delivered",
    nowIso: options.nowIso,
    verifier,
    deliveryCommit: ancestry.remoteTip,
  });
  return {
    ok: true,
    message: `merge commit ${mergeCommit} is an ancestor of origin/${deliveryBranch}`,
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
