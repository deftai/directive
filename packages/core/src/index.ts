import type { EngineInfo } from "@deftai/directive-types";
import { readCorePackageVersion } from "./engine-version.js";

/**
 * `@deftai/directive-core` — the deft directive engine core.
 *
 * Hosts the ported enforcement gates during the strangler-fig migration
 * (#1530). The Wave-1 encoding gate (`verify:encoding`, #1718) is re-exported
 * flat from the root for backward compatibility. The Wave-2 gates each expose
 * an `evaluate()` / `EvaluateResult` pair, so they are re-exported under stable
 * namespaces here (and as `@deftai/directive-core/<gate>` subpaths in package.json) to
 * avoid colliding on those shared symbol names.
 */

export * as authz from "./authz/index.js";
export * as branch from "./branch/index.js";
export * as cache from "./cache/index.js";
export * as capacity from "./capacity/index.js";
export * as codebase from "./codebase/index.js";
export * from "./coverage-hotspots/index.js";
export * as doctor from "./doctor/index.js";
export * from "./encoding/index.js";
export * as escalation from "./escalation/index.js";
export * as evalCrud from "./eval/crud-telemetry.js";
export * as evalHealth from "./eval/health.js";
export * as evalReport from "./eval/report.js";
export * as evalRun from "./eval/run.js";
export * as events from "./events/attribution-ledger.js";
export * from "./forward-coverage/evaluate.js";
// #2951 Phase 1: contained-write API for product sinks.
export {
  ContainedWriteError,
  ContainedWriteErrorCode,
  type ContainedWriteInput,
  type ContainedWriteMode,
  type ContainedWriteResult,
  containedWrite,
  resolveContainedTarget,
} from "./fs/contained-write.js";
export {
  assertDestinationNotSymlink,
  assertDirectoryNotSymlink,
  assertProjectionContained,
  assertWriteTargetSafe,
  PROJECTION_CONTAINMENT_REFUSED_EXIT_CODE,
  ProjectionContainmentError,
  walkDirectoryRejectSymlinks,
} from "./fs/projection-containment.js";
export * as intake from "./intake/index.js";
export * as layout from "./layout/index.js";
export * as legacyBridge from "./legacy-bridge/index.js";
export * as lifecycle from "./lifecycle/index.js";
export * as metrics from "./metrics/index.js";
export * as orchestration from "./orchestration/index.js";
export * as packs from "./packs/index.js";
export * as platform from "./platform/index.js";
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
export * as resolution from "./resolution/index.js";
export * as scm from "./scm/index.js";
export * as scope from "./scope/index.js";
export * as session from "./session/index.js";
export * as slash from "./slash/index.js";
export * as slice from "./slice/index.js";
export * as storyReady from "./story-ready/index.js";
export * as swarm from "./swarm/index.js";
export * as toolEvents from "./tool-events/index.js";
export * as triage from "./triage/index.js";
export * as userConfig from "./user-config/index.js";
export * as validateContent from "./validate-content/index.js";
export * as vbriefActivate from "./vbrief-activate/index.js";
export * as vbriefBuild from "./vbrief-build/index.js";
export * as vbriefReconcile from "./vbrief-reconcile/index.js";
export * as vbriefValidate from "./vbrief-validate/index.js";
export * as vbriefValidation from "./vbrief-validation/index.js";
export * as verifyEnv from "./verify-env/index.js";
export * as verifySource from "./verify-source/index.js";
export * as wipCap from "./wip-cap/index.js";
export * as xbrief from "./xbrief/index.js";
export * as xbriefMigrate from "./xbrief-migrate/index.js";

export const CORE_PACKAGE = "@deftai/directive-core" as const;

/** Returns identifying metadata for the core engine package. */
export function engineInfo(): EngineInfo {
  return { name: CORE_PACKAGE, version: readCorePackageVersion() };
}
