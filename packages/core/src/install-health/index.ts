/**
 * Install-health module — single in-sync definition (R2 / AC2.3).
 *
 * Full check: doctor and setup call sites (later waves).
 * Cheap check: hooks (AC2.4).
 *
 * Primary pin package: `@deftai/directive-runtime` (UNIFIED target architecture).
 */

export { checkCheapInSync } from "./cheap.js";
export {
  DEFT_DOCTOR_HOOK_DIAGNOSTIC,
  GENERATION_REL,
  INSTALLATION_RECOVERY_GUIDANCE,
  READINESS_DIR_REL,
  RUNTIME_PACKAGE_PATH_PREFIX,
  RUNTIME_PIN_PACKAGE,
  readinessFileName,
} from "./constants.js";
export { checkFullInSync } from "./in-sync.js";
export type {
  OwnedArtifact,
  OwnershipInspection,
  OwnershipKind,
  PackageManagerFact,
  SetupOwnershipRecord,
} from "./ownership.js";
export {
  buildOwnershipRecord,
  fingerprintContent,
  generationPath,
  inspectOwnershipRecord,
  MANAGED_SECTION_CLOSE,
  MANAGED_SECTION_MARKER_ID,
  MANAGED_SECTION_OPEN_PREFIX,
  normalizeRelativePath,
  OWNERSHIP_KINDS,
  OWNERSHIP_SCHEMA_VERSION,
  ownershipRecordsEqual,
  PACKAGE_MANAGER_FACTS,
  parseOwnershipRecord,
  readEvidenceGenerationNumber,
  readOwnershipRecord,
  stableOwnershipFingerprint,
  writeOwnershipRecord,
} from "./ownership.js";

export type { FsSeams, LockfileVersionRead, ReadinessRead, RuntimePinRead } from "./readers.js";
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
export type {
  CheapInSyncResult,
  FullInSyncOptions,
  FullInSyncResult,
  MinimalGenerationSetup,
  PredicateResult,
  SeparateSyncSignals,
} from "./types.js";
export type { WiringCheckResult } from "./wiring.js";
export {
  checkWiringTargetsRuntime,
  hasDirectiveWiringEvidence,
  WIRING_PROBE_RELS,
} from "./wiring.js";
