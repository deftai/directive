/**
 * Operator product-scope ceiling from an explicit scope-limit phrase (#4545).
 *
 * Distinct from slash-verb intent-ceiling (#1193): this binds prompt phrases
 * such as "do not add" / "initial version only" onto a seeded brief (or an
 * equivalent durable artifact) and feeds the warn-first untraceable-surface list.
 */

/** Plan metadata key for the durable ceiling on a seeded brief. */
export const OPERATOR_SCOPE_CEILING_PLAN_KEY = "x-directive/operatorScopeCeiling";

/** Standalone durable artifact relative path when no brief exists yet. */
export const OPERATOR_SCOPE_CEILING_ARTIFACT_REL = ".deft/operator-scope-ceiling.json";

export const OPERATOR_SCOPE_CEILING_SCHEMA = "deft.operator-scope-ceiling.v1" as const;

/** Single remediation string for untraceable shipped surfaces (#4545). */
export const UNTRACEABLE_SURFACE_REMEDIATION =
  "remove, or add to the brief and get operator approval";

export type ShippedSurfaceKind = "server-action" | "route" | "page";

export interface ShippedSurface {
  readonly kind: ShippedSurfaceKind;
  /** Stable id: export name (e.g. updateVehicleAction) or route/page path. */
  readonly id: string;
  /** Optional repo-relative file path that declared the surface. */
  readonly path?: string;
}

export interface OperatorScopeCeiling {
  readonly schema: typeof OPERATOR_SCOPE_CEILING_SCHEMA;
  /** Exact matched phrase from the closed lexicon (substring as found). */
  readonly matchedPhrase: string;
  /** Requirement lines recorded for the surface check to read. */
  readonly requirementLines: readonly string[];
  readonly source: "operator-prompt";
}

export interface UntraceableSurface {
  readonly surface: ShippedSurface;
  readonly remediation: typeof UNTRACEABLE_SURFACE_REMEDIATION;
}

export type SeedCeilingResult =
  | {
      readonly ok: true;
      readonly ceiling: OperatorScopeCeiling;
      /** Brief with ceiling + requirement lines recorded (when a brief was supplied). */
      readonly brief: Record<string, unknown> | null;
      /** Standalone durable artifact payload (always present on success). */
      readonly artifact: OperatorScopeCeiling;
    }
  | {
      readonly ok: false;
      readonly reason: "no-scope-limit-phrase" | "empty-prompt";
      readonly detail: string;
    };

export type UntraceableSurfaceCheckResult = {
  readonly severity: "clean" | "warn";
  readonly untraceable: readonly UntraceableSurface[];
  /** Present when severity is warn; always the single Bound remediation string. */
  readonly remediation: typeof UNTRACEABLE_SURFACE_REMEDIATION | null;
  readonly message: string;
};
