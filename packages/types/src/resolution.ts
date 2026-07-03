/**
 * Public contract for the shared resolution spine (keystone #2264 / epic #2203).
 *
 * `classify()` (in @deftai/directive-core/resolution) produces the orthogonal
 * {@link ResolutionFacts} fact-set; `plan()` applies one ordered precedence
 * table over those facts and emits a {@link ResolutionPlan}, the single
 * versioned public JSON schema every epic-#2203 consumer derives from
 * (init / update / doctor / headless). Keeping the decision behind one schema
 * closes the #537 split-source drift risk.
 *
 * The matching JSON Schema lives at
 * `packages/types/schemas/resolution-plan-v1.schema.json` and MUST stay in
 * lockstep with the types below (a lockstep test enforces it in the core
 * resolution suite).
 */

/** Schema version tag stamped into every {@link ResolutionPlan}. */
export const RESOLUTION_PLAN_SCHEMA_VERSION = "resolution-plan/v1" as const;

/** Content encoding for a file the plan recommends materialising. */
export type ResolutionEncoding = "utf-8" | "base64";

/**
 * Orthogonal project + engine fact-set returned by `classify()`.
 *
 * It is deliberately a flat set of independent facts, never a single collapsed
 * enum — `plan()` owns the collapse into one recommended action so there is
 * exactly one precedence table in the system.
 */
export interface ResolutionFacts {
  /** A git worktree is present at the classified root. */
  readonly hasGit: boolean;
  /** Consumer application source is present (app markers, not just a Deft deposit). */
  readonly hasAppCode: boolean;
  /** The canonical `.deft/core/` vendored payload directory is present. */
  readonly hasDeftCore: boolean;
  /** Version marker read from the `.deft/core/VERSION` manifest, or null. */
  readonly deftCorePayloadVersion: string | null;
  /** `AGENTS.md` carries a v2/v3 managed section. */
  readonly hasManagedSection: boolean;
  /** `sha=` attribute parsed from the managed-section open marker, or null. */
  readonly managedSectionSha: string | null;
  /** A legacy `vbrief/` lifecycle tree is present. */
  readonly hasVbrief: boolean;
  /** An `xbrief/` lifecycle tree is present. */
  readonly hasXbrief: boolean;
  /** Pre-v0.20 document-model artifacts require migration before any gate. */
  readonly preCutoverArtifacts: boolean;
  /** A Directive engine is reachable in the execution environment. */
  readonly engineReachable: boolean;
  /** Version of the reachable engine, or null when unreachable. */
  readonly engineVersion: string | null;
  /** Exact committed `package.json` devDependency pin, or null. */
  readonly pinVersion: string | null;
}

/** A file the plan recommends materialising (empty in the keystone spine). */
export interface ResolutionFile {
  readonly path: string;
  readonly content: string;
  readonly encoding: ResolutionEncoding;
}

/** The single recommended next action for the resolved mode. */
export interface ResolutionNextAction {
  /** Command to run, or null when the action is manual / has no single command. */
  readonly command: string | null;
  /** Why this action is recommended (the resolved fact combination). */
  readonly rootCause: string;
  /** Human-facing remediation guidance. */
  readonly remediation: string;
}

/**
 * The one recommended resolution mode. `plan()` emits exactly one.
 *
 * - `proceed`         — engine + content matched; run the requested gate.
 * - `init`            — no usable deposit; deposit / reconstitute one.
 * - `migrate`         — pre-v0.20 (or legacy) artifacts must migrate first.
 * - `update`          — deposit present but content behind the pin; forward-migrate.
 * - `install-global`  — install the pinned engine into the global prefix.
 * - `install-sandbox` — install the pinned engine into `.deft/.cli/<platform>`.
 * - `install-staged`  — registry down; install from a staged / vendored payload.
 * - `blocked`         — cannot self-heal (skew fail-closed, no payload); needs an operator.
 */
export type ResolutionMode =
  | "proceed"
  | "init"
  | "migrate"
  | "update"
  | "install-global"
  | "install-sandbox"
  | "install-staged"
  | "blocked";

/** The versioned public output of `plan()` — the single source of truth. */
export interface ResolutionPlan {
  readonly schemaVersion: typeof RESOLUTION_PLAN_SCHEMA_VERSION;
  readonly mode: ResolutionMode;
  readonly files: readonly ResolutionFile[];
  readonly nextAction: ResolutionNextAction;
  readonly warnings: readonly string[];
}

/** All resolution modes, exported for exhaustiveness checks + schema lockstep. */
export const RESOLUTION_MODES: readonly ResolutionMode[] = [
  "proceed",
  "init",
  "migrate",
  "update",
  "install-global",
  "install-sandbox",
  "install-staged",
  "blocked",
];

/** All resolution encodings, exported for schema lockstep. */
export const RESOLUTION_ENCODINGS: readonly ResolutionEncoding[] = ["utf-8", "base64"];
