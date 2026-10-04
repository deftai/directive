import type { VBriefVersion } from "./constants.js";
import type { PlanPolicy } from "./policy.js";
import type { VBriefReference } from "./reference.js";
import type { Status } from "./status.js";

/** Top-level `vBRIEFInfo` block (v0.6). */
export interface VBriefInfo {
  readonly version: VBriefVersion;
  readonly author?: string;
  readonly description?: string;
  readonly metadata?: Record<string, unknown>;
  readonly created?: string;
  readonly updated?: string;
  readonly timezone?: string;
  readonly [key: `x-${string}`]: unknown;
}

/** Optional PlanItem effort estimate (#1581). Time anchors: S <2h, M 2-4h, L 1-2d, XL needs breakdown. */
export const PLAN_ITEM_EFFORTS = ["S", "M", "L", "XL"] as const;

/** S/M/L/XL effort band for scope plan items (#1581). */
export type PlanItemEffort = (typeof PLAN_ITEM_EFFORTS)[number];

/** v1 stopConditions.kind (#1613). Assumption kind deferred. */
export const PLAN_ITEM_STOP_CONDITION_KINDS = ["anchor"] as const;

/** Closed observeAt tokens for PlanItem.stopConditions (#1613). */
export const PLAN_ITEM_STOP_CONDITION_OBSERVE_AT = ["item-start", "item-resume"] as const;

export type PlanItemStopConditionKind = (typeof PLAN_ITEM_STOP_CONDITION_KINDS)[number];
export type PlanItemStopConditionObserveAt = (typeof PLAN_ITEM_STOP_CONDITION_OBSERVE_AT)[number];

/** Shared fields for PlanItem stopConditions anchors (#1613). */
interface PlanItemStopConditionAnchorBase {
  readonly id: string;
  readonly kind: PlanItemStopConditionKind;
  /** Repo-relative path (no absolute / `..` segments). */
  readonly path: string;
  readonly resolvedAtSha?: string;
  readonly rationale?: string;
  readonly observeAt?: PlanItemStopConditionObserveAt;
}

/**
 * Checkable mid-execution STOP anchor on a PlanItem (#1613).
 * At least one of excerpt|digest is required at the type level.
 */
export type PlanItemStopConditionAnchor = PlanItemStopConditionAnchorBase &
  (
    | { readonly excerpt: string; readonly digest?: string }
    | { readonly digest: string; readonly excerpt?: string }
  );

/** Nested plan item (`PlanItem` in vbrief-core.schema.json). */
export interface PlanItem {
  readonly id?: string;
  readonly uid?: string;
  readonly title: string;
  readonly status: Status;
  /** Optional effort band; omit is valid. XL must not activate until broken into S/M/L (#1581). */
  readonly effort?: PlanItemEffort;
  /** Optional mid-execution STOP anchors; omit is valid (#1613). */
  readonly stopConditions?: readonly PlanItemStopConditionAnchor[];
  readonly narrative?: Readonly<Record<string, string>>;
  readonly items?: readonly PlanItem[];
  /** @deprecated Prefer `items`. Retained for schema compatibility. */
  readonly subItems?: readonly PlanItem[];
  readonly planRef?: string;
  readonly tags?: readonly string[];
  readonly metadata?: Record<string, unknown>;
  readonly created?: string;
  readonly updated?: string;
  readonly completed?: string;
  readonly [key: `x-${string}`]: unknown;
}

/** Authored architecture metadata on `plan.architecture`. */
export interface PlanArchitecture {
  readonly codeStructure?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

/** Root `plan` object for scope and project-definition vBRIEFs. */
export interface Plan {
  readonly id?: string;
  readonly uid?: string;
  readonly title: string;
  readonly status: Status;
  readonly items: readonly PlanItem[];
  readonly policy?: PlanPolicy;
  readonly architecture?: PlanArchitecture;
  readonly narratives?: Readonly<Record<string, string>>;
  readonly references?: readonly VBriefReference[];
  readonly metadata?: Record<string, unknown>;
  readonly planRef?: string;
  readonly updated?: string;
  readonly [key: `x-${string}`]: unknown;
}

/** Canonical v0.6 vBRIEF document shape. */
export interface VBriefDocument {
  readonly vBRIEFInfo: VBriefInfo;
  readonly plan: Plan;
  readonly [key: `x-${string}`]: unknown;
}

/** Identifying metadata for a deft engine package (retained from Wave-1). */
export interface EngineInfo {
  readonly name: string;
  readonly version: string;
}
