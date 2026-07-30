export {
  ACCEPTED_VBRIEF_VERSIONS,
  EXTENSION_KEY_PATTERN,
  LEGACY_VBRIEF_CORE_SCHEMA_ID,
  LEGACY_VBRIEF_VERSION,
  TYPES_PACKAGE,
  VBRIEF_CORE_SCHEMA_ID,
  VBRIEF_REFERENCE_PREFIX,
  VBRIEF_VERSION,
  type VBriefVersion,
  XBRIEF_REFERENCE_PREFIX,
} from "./constants.js";
export type {
  EngineInfo,
  Plan,
  PlanArchitecture,
  PlanItem,
  VBriefDocument,
  VBriefInfo,
} from "./document.js";
export {
  collectExtensionProperties,
  type ExtensionKey,
  isExtensionKey,
} from "./extension.js";
export {
  GATE_EXIT_CONFIG_ERROR,
  GATE_EXIT_OK,
  GATE_EXIT_VIOLATION,
  type GateExitCode,
  type GateResult,
} from "./gate.js";

export {
  type HotfixCriteria,
  type PlanPolicy,
  type ProjectionProviderExpectation,
  type ProjectionProviderPolicy,
  REGISTERED_POLICY_FIELD_NAMES,
  type TriageScopeRule,
} from "./policy.js";
export {
  isVBriefReferenceType,
  KNOWN_REFERENCE_TYPES,
  type KnownReferenceType,
  referenceTypeMatches,
  type TrustLevel,
  type VBriefReference,
} from "./reference.js";
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
} from "./resolution.js";
export {
  FOLDER_ALLOWED_STATUSES,
  type Status,
  VALID_STATUSES,
} from "./status.js";

/** Relative path to the published v0.6 core JSON Schema inside the npm package. */
export const PUBLISHED_VBRIEF_CORE_SCHEMA_PATH = "schemas/vbrief-core-0.6.schema.json" as const;

/** Relative path to the published v0.8 core JSON Schema inside the npm package. */
export const PUBLISHED_XBRIEF_CORE_SCHEMA_PATH = "schemas/xbrief-core-0.8.schema.json" as const;

/** npm subpath export for the v0.6 core JSON Schema artifact. */
export const VBRIEF_CORE_SCHEMA_EXPORT = "./schemas/vbrief-core-0.6.schema.json" as const;

/** npm subpath export for the v0.8 core JSON Schema artifact. */
export const XBRIEF_CORE_SCHEMA_EXPORT = "./schemas/xbrief-core-0.8.schema.json" as const;
