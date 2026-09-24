/**
 * Observable UI scope contract types (#4495).
 *
 * First ship: closed `.html` (parse5) + `.jsx`/`.tsx` (project-resolved TypeScript parse-only).
 * Runtime/state-derived default-tab is #4503. Same-file const useState
 * StringLiteral unwrap is #4586. Markup-visible selected /
 * aria-selected / source-order is in scope.
 */

export const OBSERVABLE_CHANGE_PLAN_KEY = "x-directive/observableChange";
export const OBSERVABLE_SCOPE_DIR = ".deft/observable-scope";
export const OBSERVABLE_UI_POLICY_REL = ".deft/observable-ui.policy.json";
export const OBSERVABLE_UI_POLICY_SCHEMA = "deft.observable-ui.policy.v1";
export const OBSERVABLE_SCOPE_RECORD_SCHEMA = "deft.observable-scope.v1";
export const OBSERVABLE_UI_ARTIFACT_SCHEMA = "deft.observable-ui.v1";
export const OBSERVABLE_UI_PROVIDER = "parse5+typescript";
export const OBSERVABLE_UI_PROVIDER_VERSION = 1;
/** Primary fail path (#5010): restore baseline or in-harness ask; TTY mint is legacy repair only. */
export const OBSERVABLE_SCOPE_REMEDIATION =
  "Restore the baseline markup structure, or ask the human in the parent chat to land the merge-base observable-scope record (mintedVia in-harness-ask). Unattended/C1: rewrite or park — leave-harness TTY scope:record-observable-scope is not the primary path (legacy repair only).";
export const CHANGE_KINDS = ["fields-only", "layout-authorized"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export const STRUCTURE_KINDS = [
  "tab",
  "tab-selected",
  "heading",
  "control",
  "table-column",
  "landmark",
  "container",
] as const;

export type StructureKind = (typeof STRUCTURE_KINDS)[number];

export const CHANGE_OPS = ["add", "remove", "reorder"] as const;
export type ChangeOp = (typeof CHANGE_OPS)[number];

export interface StructureFact {
  readonly kind: StructureKind;
  /** Stable locator, e.g. `tab:Overview`, `heading:1:Dashboard`, `control:button:Save`. */
  readonly id: string;
}

export interface SurfaceSnapshot {
  readonly path: string;
  readonly facts: readonly StructureFact[];
}

export interface ArtifactParsers {
  readonly html: string;
  readonly typescript: string | null;
}

export interface ObservableArtifact {
  readonly schema: typeof OBSERVABLE_UI_ARTIFACT_SCHEMA;
  readonly provider: typeof OBSERVABLE_UI_PROVIDER;
  readonly version: typeof OBSERVABLE_UI_PROVIDER_VERSION;
  /**
   * Informational parser identities (tokenizer version, resolved TypeScript
   * version or null when no .jsx/.tsx surface was parsed). Never compared
   * against the base-committed mint record; never part of its hash.
   */
  readonly parsers: ArtifactParsers;
  readonly surfaces: readonly SurfaceSnapshot[];
}

export interface AllowedChange {
  readonly kind: StructureKind;
  readonly op: ChangeOp;
  readonly name?: string;
  /** When set, the allowance applies only to this surface path. */
  readonly path?: string;
}

export interface ObservableScopeHumanApproval {
  readonly kind: string;
  readonly actor: string;
  readonly mintedAt: string;
  readonly mintedVia?: string;
}

export interface ObservableScopeFinding {
  readonly kind: "non-adoption" | "unlisted-delta" | "missing-mint" | "same-pr-rewrite";
  readonly path?: string;
  readonly detail: string;
}

export interface ObservableScopeRecord {
  readonly schema: typeof OBSERVABLE_SCOPE_RECORD_SCHEMA;
  readonly planId: string;
  readonly xbriefRelPath: string;
  readonly approvedAt: string;
  readonly changeKind: ChangeKind;
  readonly oracle: {
    readonly provider: typeof OBSERVABLE_UI_PROVIDER;
    readonly version: typeof OBSERVABLE_UI_PROVIDER_VERSION;
  };
  readonly allowedChanges: readonly AllowedChange[];
  readonly mustPreserve?: readonly AllowedChange[];
  readonly humanApproval: ObservableScopeHumanApproval;
  readonly contractDigest: string;
}

export interface ObservableUiPolicy {
  readonly schema: typeof OBSERVABLE_UI_POLICY_SCHEMA;
  readonly surfaces: readonly string[];
}

export interface StructureDelta {
  readonly path: string;
  readonly kind: StructureKind;
  readonly op: ChangeOp;
  readonly name: string;
  readonly id: string;
}
