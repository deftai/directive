/**
 * Host-agnostic slash-command generator core (#3052 / epic #55).
 *
 * Product command table + thin-wrapper IR/templates for multi-host emitters.
 * Does not write `.claude/commands/` (etc.) — that is #3054 deposit work.
 * Per-host format layouts are #3053.
 */

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
