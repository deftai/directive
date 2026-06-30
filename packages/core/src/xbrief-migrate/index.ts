export {
  detectLegacyVbriefLayout,
  type LegacyVbriefLayoutDetection,
} from "./detect.js";
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
