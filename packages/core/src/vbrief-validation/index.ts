export {
  alignSpecNarratives,
  buildEdgesFromTasks,
  buildRequirementsNarrative,
  CANONICAL_SPEC_KEYS,
  formatMigrationLogEntry,
  ingestSpecNarratives,
  mapSpecStatus,
  parseRequirementDefinitions,
  parseSpecTasks,
  SPEC_KNOWN_MAPPINGS,
  taskScopeNarratives,
} from "./fidelity.js";
export {
  lookupCanonical,
  normalizeTitle,
  parseTopLevelSections,
  partitionSections,
} from "./legacy-sections.js";
export { cmdVbriefValidation, run, usage } from "./main.js";
export {
  PARITY_SCENARIO_NAMES,
  renderScenarioOutput,
  runParityScenario,
} from "./parity-scenarios.js";
export type { BackupRecord, FileModification, RenameRecord } from "./safety.js";
export {
  dirtyTreeRefusalMessage,
  isTreeDirty,
  LEGACY_DIR,
  loadSafetyManifest,
  MIGRATION_DIR,
  manifestPath,
  nowUtcIso,
  PREMIGRATE_SUFFIX,
  planBackups,
  premigrateSibling,
  rollback,
  SAFETY_MANIFEST_NAME,
  SafetyManifest,
  sha256Of,
  writeBackups,
  writeSafetyManifest,
} from "./safety.js";
export type { StoryQualityParams } from "./story-quality.js";
export {
  acceptanceTextsFromItems,
  asStrList,
  deprecatedSubitemsIssues,
  itemHasAcceptance,
  itemHasTraces,
  itemsHaveAcceptance,
  missingRequiredSwarmFields,
  storyQualityIssues,
} from "./story-quality.js";
export type {
  JsonObject,
  MigrationLogEntry,
  SectionTuple,
  SpecTask,
} from "./types.js";
export {
  finalizeMigration,
  HASH_SUFFIX_LENGTH,
  ID_MAX_LENGTH,
  isolateInvalidOutput,
  RECOVERY_HINT,
  slugFallbackId,
  slugifyId,
  validateMigrationOutput,
} from "./validation.js";
