import type { EngineInfo } from "@deftai/types";

/**
 * `@deftai/core` — the deft directive engine core.
 *
 * Hosts the first ported enforcement gate (`verify:encoding`, #1718) under
 * `./encoding`, alongside the Wave-1 identity accessor.
 */

export * from "./encoding/index.js";

export const CORE_PACKAGE = "@deftai/core" as const;

/** Returns identifying metadata for the core engine package. */
export function engineInfo(): EngineInfo {
  return { name: CORE_PACKAGE, version: "0.0.0" };
}
