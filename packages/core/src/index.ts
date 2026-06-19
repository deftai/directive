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
export * as cache from "./cache/index.js";
export * as capacity from "./capacity/index.js";
export * as codebase from "./codebase/index.js";
export * as doctor from "./doctor/index.js";
export * from "./encoding/index.js";
export * as intake from "./intake/index.js";
export * as policy from "./policy/index.js";
export * as prClosingKeywords from "./pr-closing-keywords/index.js";
export * as prMergeReadiness from "./pr-merge-readiness/index.js";
export * as prMonitor from "./pr-monitor/index.js";
export * as prProtectedIssues from "./pr-protected-issues/index.js";
export * as prWaitMergeable from "./pr-wait-mergeable/index.js";
export * as preflight from "./preflight/index.js";
export * as release from "./release/index.js";
export * as releaseE2e from "./release-e2e/index.js";
export * as releasePublish from "./release-publish/index.js";
export * as releaseRollback from "./release-rollback/index.js";
export * as render from "./render/index.js";
export * as scm from "./scm/index.js";
export * as scope from "./scope/index.js";
export * as slice from "./slice/index.js";
export * as storyReady from "./story-ready/index.js";
export * as triage from "./triage/index.js";
export * as validateContent from "./validate-content/index.js";
export * as vbriefActivate from "./vbrief-activate/index.js";
export * as vbriefBuild from "./vbrief-build/index.js";
export * as vbriefReconcile from "./vbrief-reconcile/index.js";
export * as vbriefValidate from "./vbrief-validate/index.js";
export * as vbriefValidation from "./vbrief-validation/index.js";
export * as verifyEnv from "./verify-env/index.js";
export * as verifySource from "./verify-source/index.js";
export * as wipCap from "./wip-cap/index.js";

export const CORE_PACKAGE = "@deftai/core" as const;

/** Returns identifying metadata for the core engine package. */
export function engineInfo(): EngineInfo {
  return { name: CORE_PACKAGE, version: "0.0.0" };
}
