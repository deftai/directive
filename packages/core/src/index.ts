import type { EngineInfo } from "@deftai/types";

/**
 * `@deftai/core` — the deft directive engine core.
 *
 * Hosts the ported enforcement gates during the strangler-fig migration
 * (#1530). The Wave-1 encoding gate (`verify:encoding`, #1718) is re-exported
 * flat from the root for backward compatibility. The Wave-2 gates each expose
 * an `evaluate()` / `EvaluateResult` pair, so they are re-exported under stable
 * namespaces here (and as `@deftai/core/<gate>` subpaths in package.json) to
 * avoid colliding on those shared symbol names.
 */

export * as branch from "./branch/index.js";
export * from "./encoding/index.js";
export * as policy from "./policy/index.js";
export * as preflight from "./preflight/index.js";
export * as storyReady from "./story-ready/index.js";
export * as wipCap from "./wip-cap/index.js";

export const CORE_PACKAGE = "@deftai/core" as const;

/** Returns identifying metadata for the core engine package. */
export function engineInfo(): EngineInfo {
  return { name: CORE_PACKAGE, version: "0.0.0" };
}
