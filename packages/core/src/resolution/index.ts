/**
 * Resolution spine (keystone #2264 / epic #2203) — shared library primitives.
 *
 * The classifier (`classify`) produces the orthogonal fact-set; `plan()` applies
 * one ordered precedence table and emits the versioned public resolution-plan-v1
 * schema (the single source of truth). Engine reachability and engine/pin
 * reconciliation are the supporting primitives — no engine ladder, skew windows,
 * or accept-engine escape hatches (AC12.6).
 */

export {
  RESOLUTION_ENCODINGS,
  RESOLUTION_MODES,
  RESOLUTION_PLAN_SCHEMA_VERSION,
  type ResolutionEncoding,
  type ResolutionFacts,
  type ResolutionFile,
  type ResolutionMode,
  type ResolutionNextAction,
  type ResolutionPlan,
} from "@deftai/directive-types";
export {
  type ClassifySeams,
  classify,
  defaultEngineProbe,
  type EngineProbeResult,
} from "./classify.js";
export {
  contentMatchesEngine,
  type EnginePinBand,
  type EnginePinDecision,
  type EnginePinResult,
  evaluateEnginePin,
} from "./engine-pin.js";
export {
  decideEngineAvailability,
  type EngineDecision,
  type EngineFacts,
  type EngineInstallRunner,
  type EngineResolution,
  type LocalEngineFacts,
  type ReprojectRunner,
  type ResolveEngineOptions,
  resolveEngine,
} from "./engine-resolve.js";
export {
  checkLocalEngineIntegrity,
  type IntegrityResult,
  type IntegritySeams,
  LOCAL_ENGINE_MARKERS,
  LOCAL_ENGINE_ROOT,
  localEnginePlatformDir,
} from "./integrity.js";
export {
  DEFAULT_PACKAGE_MANAGER,
  type DetectPackageManagerInput,
  detectPackageManager,
  ENGINE_PACKAGE,
  PACKAGE_MANAGERS,
  type PackageManager,
  type PackageManagerCommands,
  renderEphemeral,
  renderGlobalInstall,
  renderPackageManagerCommands,
  renderProjectInstall,
} from "./package-manager.js";
export {
  compareSemver,
  isExactPin,
  PIN_DEPENDENCY_NAME,
  type PinReadResult,
  type PinReadSeams,
  parseSemver,
  type ReconcileInputs,
  type ReconcileResult,
  readPin,
  reconcileVersions,
  type SemverTriple,
  semverGte,
} from "./pin.js";
export { type PlanOptions, plan } from "./plan.js";
