/**
 * `@deftai/directive-types` — shared types for the deft directive TypeScript engine.
 *
 * Wave-1 skeleton (#1717): carries only the identity constant and a
 * placeholder metadata shape needed to prove the cross-package dependency
 * graph (types → core → cli). The real ported domain types arrive with the
 * `verify:encoding` tracer bullet and parity harness (#1718).
 */

export const TYPES_PACKAGE = "@deftai/directive-types" as const;

/** Identifying metadata for a deft engine package. */
export interface EngineInfo {
  readonly name: string;
  readonly version: string;
}
