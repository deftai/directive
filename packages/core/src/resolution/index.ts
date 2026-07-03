/**
 * Resolution spine (keystone #2264 / epic #2203) — shared library primitives.
 *
 * The classifier (`classify`) produces the orthogonal fact-set; `plan()` applies
 * one ordered precedence table and emits the versioned public resolution-plan-v1
 * schema (the single source of truth). The engine ladder, local-engine integrity
 * check, three-band skew policy, and pin/VERSION/sha reconciliation are the
 * supporting primitives that init / update / doctor / headless (children B–E)
 * consume — this module ships them; it does NOT rewire verb behavior.
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
  decideEngineLadder,
  type EngineInstallOutcome,
  type EngineInstallRunner,
  type EngineResolution,
  type LadderDecision,
  type LadderFacts,
  type LadderRung,
  type LocalEngineFacts,
  type ReprojectRunner,
  type ResolveEngineOptions,
  resolveEngine,
} from "./engine-ladder.js";
export {
  checkLocalEngineIntegrity,
  type IntegrityResult,
  type IntegritySeams,
  LOCAL_ENGINE_MARKERS,
  LOCAL_ENGINE_ROOT,
  localEnginePlatformDir,
} from "./integrity.js";
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
export {
  ACCEPT_ENGINE_SKEW_ENV,
  DEFAULT_ENGINE_SKEW_WINDOW,
  evaluateSkew,
  type SkewBand,
  type SkewDecision,
  type SkewOptions,
  type SkewResult,
} from "./skew-policy.js";
