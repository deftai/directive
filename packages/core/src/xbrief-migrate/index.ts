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
  detectLegacyVbriefLayout,
  type LegacyVbriefLayoutDetection,
} from "./detect.js";
export {
  BUILTIN_ALLOW_LIST,
  type DriftEvaluateOptions,
  type DriftEvaluateResult,
  type DriftFinding,
  type DriftScanMode,
  evaluateXbriefDrift,
  LEGACY_REFERENCE_PREFIX,
  scanCorpusToken,
} from "./drift-gate.js";
export {
  emitXbriefMigration,
  runXbriefMigration,
  runXbriefMigrationCli,
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
