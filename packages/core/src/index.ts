import type { EngineInfo } from "@deftai/types";

/**
 * `@deftai/core` — the deft directive engine core.
 *
 * Wave-1 skeleton (#1717): exposes only its identity and an `engineInfo()`
 * accessor that consumes a type from `@deftai/types`, proving the
 * types → core project reference resolves. Ported enforcement logic lands
 * with #1718 onward.
 */

export const CORE_PACKAGE = "@deftai/core" as const;

/** Returns identifying metadata for the core engine package. */
export function engineInfo(): EngineInfo {
  return { name: CORE_PACKAGE, version: "0.0.0" };
}
