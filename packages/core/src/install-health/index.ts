/**
 * Install-health module — single in-sync definition (R2 / AC2.3).
 *
 * Full check: doctor and setup call sites (later waves).
 * Cheap check: hooks (AC2.4).
 *
 * Primary pin package: `@deftai/directive-runtime` (UNIFIED target architecture).
 */

export {
  DEFT_DOCTOR_HOOK_DIAGNOSTIC,
  GENERATION_REL,
  INSTALLATION_RECOVERY_GUIDANCE,
  READINESS_DIR_REL,
  RUNTIME_PACKAGE_PATH_PREFIX,
  RUNTIME_PIN_PACKAGE,
  readinessFileName,
} from "./constants.js";

export { checkCheapInSync } from "./cheap.js";
export { checkFullInSync } from "./in-sync.js";

export type {
  CheapInSyncResult,
  FullInSyncOptions,
  FullInSyncResult,
  MinimalGenerationSetup,
  PredicateResult,
  SeparateSyncSignals,
} from "./types.js";

export {
  compareSchemaVersion,
  isExactSemver,
  normalizeVersion,
  parseMinimalGeneration,
  readGenerationSetup,
  readInstalledRuntimeVersion,
  readLockfileRuntimeVersion,
  readProjectXbriefSchemaVersion,
  readReadiness,
  readRuntimePin,
} from "./readers.js";

export type { FsSeams, LockfileVersionRead, ReadinessRead, RuntimePinRead } from "./readers.js";

export { WIRING_PROBE_RELS, checkWiringTargetsRuntime } from "./wiring.js";
export type { WiringCheckResult } from "./wiring.js";

export {
  MANAGED_SECTION_CLOSE,
  MANAGED_SECTION_MARKER_ID,
  MANAGED_SECTION_OPEN_PREFIX,
  OWNERSHIP_KINDS,
  OWNERSHIP_SCHEMA_VERSION,
  PACKAGE_MANAGER_FACTS,
  buildOwnershipRecord,
  fingerprintContent,
  generationPath,
  inspectOwnershipRecord,
  normalizeRelativePath,
  ownershipRecordsEqual,
  parseOwnershipRecord,
  readOwnershipRecord,
  stableOwnershipFingerprint,
  writeOwnershipRecord,
} from "./ownership.js";
export type {
  OwnedArtifact,
  OwnershipInspection,
  OwnershipKind,
  PackageManagerFact,
  SetupOwnershipRecord,
} from "./ownership.js";
