/**
 * Read-only stored-mint conflict (#4963).
 *
 * Clauses match the private bindingIdentityConflict predicate: plan.id against
 * the parsed x-directive/plan-id binding, then origin, REST self-check, and
 * fallback self-check. No lifecycle admission, no sibling scan, no persisted id.
 */

import { resolve } from "node:path";
import {
  mintIssuePlanId,
  PLAN_ID_MINT_VERSION,
  PLAN_ID_ORIGIN_META_KEY,
  PlanIdIdentityError,
  type PlanIdMintSource,
  parsePositiveGithubIssueId,
  resolveIngestProvenanceOwner,
} from "../intake/issue-ingest.js";
import { type IssueOrigin, issueOriginKey } from "../intake/reconcile-issues.js";
import { extractPlanId } from "../scope/parent-lineage.js";

export const ADOPT_STORED_PLAN_ID_VERB = "xbrief:adopt-stored-plan-id";

export interface ParsedStoredPlanIdBinding {
  readonly version: typeof PLAN_ID_MINT_VERSION;
  readonly source: PlanIdMintSource;
  readonly githubIssueId: number | null;
  readonly origin: string;
  readonly id: string;
}

export type StoredPlanIdBindingRead =
  | { readonly kind: "absent" }
  | { readonly kind: "malformed"; readonly detail: string }
  | { readonly kind: "ok"; readonly binding: ParsedStoredPlanIdBinding };

export interface StoredMintConflict {
  readonly detail: string;
  /** True when a present plan.id is not the stored binding id. */
  readonly disagree: boolean;
}

function asPlanRecord(data: Record<string, unknown>): Record<string, unknown> | null {
  const plan = data.plan;
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) {
    return null;
  }
  return plan as Record<string, unknown>;
}

function parseOriginKey(origin: string): IssueOrigin | null {
  const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(origin);
  if (!match?.[1] || !match[2] || !match[3]) {
    return null;
  }
  const number = Number.parseInt(match[3], 10);
  if (!Number.isSafeInteger(number) || number <= 0) {
    return null;
  }
  return { owner: match[1], repo: match[2], number };
}

/** Parse plan.metadata["x-directive/plan-id"]. Does not write. */
export function readStoredPlanIdBinding(plan: Record<string, unknown>): StoredPlanIdBindingRead {
  const meta = plan.metadata;
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
    return { kind: "absent" };
  }
  const rec = meta as Record<string, unknown>;
  if (!Object.hasOwn(rec, PLAN_ID_ORIGIN_META_KEY)) {
    return { kind: "absent" };
  }
  const raw = rec[PLAN_ID_ORIGIN_META_KEY];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { kind: "malformed", detail: "stored plan-id binding is not an object." };
  }
  const binding = raw as Record<string, unknown>;
  for (const key of ["version", "source", "github_issue_id", "origin", "id"] as const) {
    if (!Object.hasOwn(binding, key)) {
      return { kind: "malformed", detail: `stored plan-id binding is missing ${key}.` };
    }
  }
  if (binding.version !== PLAN_ID_MINT_VERSION) {
    return { kind: "malformed", detail: "stored plan-id binding version is not supported." };
  }
  const source = binding.source;
  if (source !== "github-rest-id" && source !== "github-repo-fallback") {
    return {
      kind: "malformed",
      detail: "stored plan-id binding source is not a known mint source.",
    };
  }
  const origin = binding.origin;
  if (typeof origin !== "string" || origin.trim().length === 0) {
    return { kind: "malformed", detail: "stored plan-id binding origin is malformed." };
  }
  const parsedOrigin = parseOriginKey(origin);
  if (parsedOrigin === null || issueOriginKey(parsedOrigin) !== origin) {
    return {
      kind: "malformed",
      detail: "stored plan-id binding origin is not a canonical origin key.",
    };
  }
  const id = binding.id;
  if (typeof id !== "string" || id.trim().length === 0) {
    return { kind: "malformed", detail: "stored plan-id binding id is malformed." };
  }
  if (source === "github-rest-id") {
    if (typeof binding.github_issue_id !== "number") {
      return { kind: "malformed", detail: "stored plan-id binding github_issue_id is malformed." };
    }
    const restId = parsePositiveGithubIssueId(binding.github_issue_id);
    if (restId === null) {
      return { kind: "malformed", detail: "stored plan-id binding github_issue_id is malformed." };
    }
    return {
      kind: "ok",
      binding: {
        version: PLAN_ID_MINT_VERSION,
        source,
        githubIssueId: restId,
        origin,
        id: id.trim(),
      },
    };
  }
  if (binding.github_issue_id !== null) {
    return {
      kind: "malformed",
      detail: "stored plan-id fallback binding github_issue_id must be null.",
    };
  }
  return {
    kind: "ok",
    binding: {
      version: PLAN_ID_MINT_VERSION,
      source,
      githubIssueId: null,
      origin,
      id: id.trim(),
    },
  };
}

function bindingConflictDetail(
  binding: ParsedStoredPlanIdBinding,
  planId: string | null,
  data: Record<string, unknown>,
): string | null {
  if (planId !== null && planId !== binding.id) {
    return `plan.id ${planId} disagrees with stored mint ${binding.id}.`;
  }
  const provenance = resolveIngestProvenanceOwner(data);
  if (provenance.kind === "owner") {
    const expected = issueOriginKey(provenance.origin);
    if (binding.origin !== expected) {
      return `stored plan-id origin ${binding.origin} disagrees with ingest origin ${expected}.`;
    }
  }
  if (binding.source === "github-rest-id") {
    const expectedId = `github.issue.${binding.githubIssueId}`;
    if (binding.id !== expectedId) {
      return `stored plan-id ${binding.id} disagrees with github_issue_id ${binding.githubIssueId}.`;
    }
    return null;
  }
  const origin = parseOriginKey(binding.origin);
  if (origin === null) {
    return "stored plan-id origin is not a canonical origin key.";
  }
  let expectedId: string;
  try {
    // Expected-id comparison only. This value is not written onto the brief.
    expectedId = mintIssuePlanId({
      owner: origin.owner,
      repo: origin.repo,
      number: origin.number,
    }).id;
  } catch (err) {
    if (err instanceof PlanIdIdentityError) {
      return `stored plan-id ${binding.id} disagrees with fallback mint for ${binding.origin}.`;
    }
    const msg = err instanceof Error ? err.message : String(err);
    return `stored plan-id check failed: ${msg}.`;
  }
  if (binding.id !== expectedId) {
    return `stored plan-id ${binding.id} disagrees with fallback mint for ${binding.origin}.`;
  }
  return null;
}

/**
 * Stored-mint conflict for one artifact. Null when there is no parsed binding
 * or the binding agrees. Does not scan sibling briefs.
 */
export function storedMintIdentityConflict(
  data: Record<string, unknown>,
): StoredMintConflict | null {
  const plan = asPlanRecord(data);
  if (plan === null) return null;
  const parsed = readStoredPlanIdBinding(plan);
  if (parsed.kind !== "ok") return null;
  const planId = extractPlanId(data);
  const detail = bindingConflictDetail(parsed.binding, planId, data);
  if (detail === null) return null;
  return {
    detail,
    disagree: planId !== null && planId !== parsed.binding.id,
  };
}

function quoteArg(value: string): string {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

/** Copy-paste invocation named by the disagree refusal. */
export function adoptStoredPlanIdInvocation(out: string, projectRoot?: string): string {
  let command = `Run deft ${ADOPT_STORED_PLAN_ID_VERB} -- --out ${quoteArg(out)}`;
  if (projectRoot !== undefined && resolve(projectRoot) !== resolve(process.cwd())) {
    command += ` --project-root ${quoteArg(projectRoot)}`;
  }
  return command;
}
