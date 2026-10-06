export {
  detectStaleUnmanagedHeader,
  type HeaderPatchOutcome,
  type HeaderRewriteResult,
  type HeaderTokenReplacement,
  LEGACY_HEADER_TOKENS,
  patchAgentsMdHeader,
  renderHeaderPatchSummary,
  renderStaleHeaderLine,
  rewriteUnmanagedHeaderTokens,
  type StaleHeaderDetection,
} from "./agents-header.js";
export {
  CONFIDENCE_MIGRATE_COMMAND,
  mainEntry as migrateConfidenceMainEntry,
  migrateConfidenceCorpus,
} from "./confidence.js";
export {
  OBSOLETE_FRAMEWORK_NARRATIVE_FILENAME,
  VBRIEF_DEPRECATION_MARKER_BODY,
  VBRIEF_DEPRECATION_MARKER_FILENAME,
  VBRIEF_DEPRECATION_MARKER_SENTINEL,
} from "./constants.js";
export {
  detectLegacyVbriefLayout,
  detectXbriefConvergence,
  type LegacyVbriefLayoutDetection,
  type XbriefConvergenceDetection,
  type XbriefConvergenceState,
} from "./detect.js";
export {
  BUILTIN_ALLOW_LIST,
  corpusEnvelopeFindingFromObject,
  type DriftEvaluateOptions,
  type DriftEvaluateResult,
  type DriftFinding,
  type DriftScanMode,
  evaluateXbriefDrift,
  inMemoryCorpusEnvelopeIsDirty,
  isCorpusEnvelopeCandidatePath,
  LEGACY_REFERENCE_PREFIX,
  scanCorpusEnvelope,
  scanCorpusToken,
} from "./drift-gate.js";
export {
  hasVbriefDeprecationMarker,
  isDirectory,
  isEffectivelyEmptyDir,
} from "./fs-helpers.js";
export {
  convergeLegacyVbriefRoot,
  emitXbriefMigration,
  legacyInfoIsRedundantWithCanonical,
  planRedundantLegacyEnvelopeStrips,
  removeStaleMigratedFrameworkNarrative,
  runXbriefMigration,
  runXbriefMigrationCli,
  shouldOmitLegacyMigrationFile,
  type VbriefConvergeAction,
  type XbriefMigrationArgs,
  type XbriefMigrationIo,
  type XbriefMigrationOutcome,
} from "./migrate-project.js";
export { renderXbriefMigrationLine, xbriefMigrationGuidance } from "./signpost.js";
export {
  assertFeatureEmissionAllowed,
  assertLayoutAwareWritePath,
  FeatureEmissionRejectedError,
  type JsonObject,
  type JsonValue,
  readDeclaredArtifactVersion,
  resolveLayoutAwareRelativePath,
  rewriteEmbeddedTokens,
  SplitLayoutRejectedError,
  TransformError,
  transformArtifactV06ToV08,
  transformArtifactV06ToV08Transactional,
} from "./transforms.js";
export { isPatchOnlyUpgrade, parseSemverPrefix } from "./version.js";
