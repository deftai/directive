/**
 * Merge-base story continuity for scope membership (#5192).
 *
 * Census is merge-base lifecycle briefs (pending/active/completed/cancelled),
 * not working-tree findParentsByPlanId. Path-first when the head path exists on
 * base; unique planId move only when head has a plan.id and base/head path
 * exclusivity holds. Same-path plan.id rewrite is a relabel refuse.
 */

import { basename } from "node:path";
import { extractPlanId } from "./digest.js";

export const LIFECYCLE_FOLDERS = ["pending", "active", "completed", "cancelled"] as const;
export type LifecycleFolder = (typeof LIFECYCLE_FOLDERS)[number];

const LIFECYCLE_XBRIEF_RE =
  /^xbrief\/(pending|active|completed|cancelled)\/[^/]+\.(?:xbrief|vbrief)\.json$/;

export function isLifecycleXbriefPath(relPath: string): boolean {
  const n = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  return LIFECYCLE_XBRIEF_RE.test(n);
}

export function xbriefBasename(relPath: string): string {
  const n = relPath.replace(/\\/g, "/");
  return basename(n);
}

export function sameBasenameLifecyclePaths(relPath: string): string[] {
  const leaf = xbriefBasename(relPath);
  if (!leaf.endsWith(".xbrief.json") && !leaf.endsWith(".vbrief.json")) return [];
  return LIFECYCLE_FOLDERS.map((folder) => `xbrief/${folder}/${leaf}`);
}

/**
 * Same-basename lifecycle paths in pre-move preference order (#5192).
 * Prefer active over pending so a stale pending brief cannot supply the
 * production fence or membership precommitment for a completed move.
 */
export function preMoveSameBasenameLifecyclePaths(relPath: string): string[] {
  const leaf = xbriefBasename(relPath);
  if (!leaf.endsWith(".xbrief.json") && !leaf.endsWith(".vbrief.json")) return [];
  const self = normalizeRel(relPath);
  const folders = ["active", "pending", "completed", "cancelled"] as const;
  return folders.map((folder) => `xbrief/${folder}/${leaf}`).filter((p) => p !== self);
}

export interface CensusBrief {
  readonly rel: string;
  readonly planId: string | null;
  readonly raw: string;
  readonly payload: unknown;
}

export type ContinuityResolution =
  | {
      readonly kind: "resolved";
      readonly baseRel: string;
      readonly basePlanId: string | null;
      readonly basePayload: unknown;
      readonly baseRaw: string;
      readonly move: boolean;
    }
  | { readonly kind: "relabel-refuse"; readonly detail: string }
  | { readonly kind: "duplicate-refuse"; readonly detail: string }
  | { readonly kind: "ambiguous-refuse"; readonly detail: string }
  | { readonly kind: "missing" };

function normalizeRel(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/");
}

/**
 * Build a merge-base census from an injected baseXbriefs map (test seam) or
 * any rel→raw map of lifecycle briefs.
 */
export function censusFromBaseMap(baseXbriefs: ReadonlyMap<string, string>): CensusBrief[] {
  const out: CensusBrief[] = [];
  for (const [relRaw, raw] of baseXbriefs.entries()) {
    const rel = normalizeRel(relRaw);
    if (!isLifecycleXbriefPath(rel)) continue;
    try {
      const payload = JSON.parse(raw) as unknown;
      out.push({
        rel,
        planId: extractPlanId(payload),
        raw,
        payload,
      });
    } catch {
      // Unreadable census entries stay out of identity resolution; callers that
      // need the bound path still fail closed via readAtBase.
    }
  }
  return out;
}

/**
 * Resolve the continuity-bound merge-base story for membership (#5192 item 3).
 *
 * @param headRel - head bound path (usually active/; may be completed/ after move)
 * @param headPlanId - plan.id on the head brief (null when absent)
 * @param headLifecycleRels - all head lifecycle brief paths (for move exclusivity)
 * @param census - merge-base lifecycle briefs
 */
export function resolveStoryContinuity(input: {
  readonly headRel: string;
  readonly headPlanId: string | null;
  readonly headLifecycleRels: readonly string[];
  readonly census: readonly CensusBrief[];
  /** Optional HEAD rel→planId map so move resolution can refuse duplicate claimants. */
  readonly headPlanIds?: ReadonlyMap<string, string | null>;
}): ContinuityResolution {
  const headRel = normalizeRel(input.headRel);
  const headPlanId = input.headPlanId;
  const headSet = new Set(input.headLifecycleRels.map(normalizeRel));
  const byRel = new Map(input.census.map((b) => [normalizeRel(b.rel), b]));

  const samePath = byRel.get(headRel);
  if (samePath !== undefined) {
    if (headPlanId !== null) {
      const baseId = samePath.planId;
      if (baseId !== headPlanId) {
        return {
          kind: "relabel-refuse",
          detail:
            `same-path plan.id rewrite at ${headRel}: base plan.id=${baseId ?? "(none)"} ` +
            `head plan.id=${headPlanId}; refuse before mint lookup (#5192)`,
        };
      }
    }
    return {
      kind: "resolved",
      baseRel: samePath.rel,
      basePlanId: samePath.planId,
      basePayload: samePath.payload,
      baseRaw: samePath.raw,
      move: false,
    };
  }

  // Path absent on base: planId move only when head has a plan.id.
  if (headPlanId === null) {
    return { kind: "missing" };
  }

  const matches = input.census.filter((b) => b.planId === headPlanId);
  if (matches.length === 0) {
    return { kind: "missing" };
  }
  if (matches.length > 1) {
    return {
      kind: "duplicate-refuse",
      detail:
        `plan.id ${headPlanId} resolves to ${String(matches.length)} merge-base briefs ` +
        `(${matches.map((m) => m.rel).join(", ")}); refuse (#5192)`,
    };
  }
  const unique = matches[0];
  if (unique === undefined) return { kind: "missing" };
  const baseRel = normalizeRel(unique.rel);
  // Move requires base path absent from head.
  if (headSet.has(baseRel)) {
    return {
      kind: "ambiguous-refuse",
      detail:
        `plan.id ${headPlanId} base path ${baseRel} still present on head; ` +
        "not a continuity move (#5192)",
    };
  }
  // Two HEAD briefs claiming the same plan.id must not both resolve the move.
  const headClaimants = input.headLifecycleRels.map(normalizeRel).filter((p) => p !== headRel);
  // Caller may pass planIds via optional headPlanIds; without them, refuse when
  // more than one other head lifecycle path exists beside headRel for this id
  // only when headPlanIds is provided.
  if (input.headPlanIds !== undefined) {
    const otherClaimants = headClaimants.filter((p) => input.headPlanIds?.get(p) === headPlanId);
    if (otherClaimants.length > 0) {
      return {
        kind: "ambiguous-refuse",
        detail:
          `plan.id ${headPlanId} claimed by multiple HEAD briefs ` +
          `(${[headRel, ...otherClaimants].join(", ")}); refuse (#5192)`,
      };
    }
  }
  return {
    kind: "resolved",
    baseRel,
    basePlanId: unique.planId,
    basePayload: unique.payload,
    baseRaw: unique.raw,
    move: true,
  };
}

/**
 * Lifecycle paths of a continuity-resolved identity (planId or same-basename).
 *
 * plan.id stories exempt only the continuity pair (headRel + baseRel) — basename
 * fan-out would hide deleting a different story that shares the leaf name.
 * no-plan.id identities keep same-basename lifecycle exempts (Prefer-A #5192).
 */
export function continuityExemptPaths(input: {
  readonly headRel: string;
  readonly headPlanId: string | null;
  readonly continuity: ContinuityResolution;
}): string[] {
  const out = new Set<string>();
  out.add(normalizeRel(input.headRel));
  if (input.continuity.kind === "resolved") {
    out.add(normalizeRel(input.continuity.baseRel));
    if (input.headPlanId === null) {
      for (const p of sameBasenameLifecyclePaths(input.headRel)) out.add(p);
    }
  } else if (input.headPlanId === null) {
    for (const p of sameBasenameLifecyclePaths(input.headRel)) out.add(p);
  }
  return [...out];
}
