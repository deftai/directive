/**
 * Slash-command generator + per-host emitters (#3052 / #3053 / epic #55).
 *
 * Product command table + thin-wrapper IR/templates + host path layouts.
 * Disk deposit lives in init-deposit `writeSlashCommandDeposit` (#3054).
 */

export {
  assertThinHostEmission,
  emitAllHostCommandFiles,
  emitHostCommandFiles,
  getHostCommandLayout,
  HOST_COMMAND_LAYOUTS,
  type HostCommandLayout,
  type HostEmittedFile,
  hostRelativePath,
  isSlashEmitterHostId,
  listSlashEmitterHosts,
  renderHostFileContents,
  SLASH_EMITTER_HOSTS,
  type SlashEmitterHostId,
} from "./emitters.js";
export {
  BYTES_PER_TOKEN_ESTIMATE,
  estimateTokens,
  generateThinWrapper,
  generateThinWrappers,
  isThinWrapperMarkdown,
  MAX_CATALOG_TOKENS,
  MAX_DESCRIPTION_TOKENS,
  MAX_WRAPPER_BODY_TOKENS,
  measureTokenBudget,
  renderThinWrapperBody,
  renderThinWrapperFile,
  type ThinWrapperIR,
  type TokenBudgetReport,
} from "./generator.js";
export {
  getProductCommand,
  listProductCommands,
  logicalIdToFilename,
  logicalIdToFilenameStem,
  PRODUCT_COMMAND_COUNT,
  PRODUCT_COMMANDS,
  type ProductCommand,
  type SlashDispatchKind,
} from "./product-set.js";
