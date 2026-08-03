/**
 * Slash-command generator + per-host emitters (#3052 / #3053 / epic #55)
 * + OpenClaw L2 product-command adapter (#3064).
 *
 * Product command table + thin-wrapper IR/templates + host path layouts.
 * Disk deposit for file hosts: init-deposit `writeSlashCommandDeposit` (#3054).
 * OpenClaw skills deposit: `depositOpenClawL2ProductCommands` (#3064) — not a
 * fake `.openclaw/commands/` file emitter.
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
  assertThinOpenClawArtifacts,
  generateOpenClawSkillArtifacts,
  isManagedOpenClawL2Skill,
  isManagedOpenClawRouterSkill,
  isThinOpenClawSkillMarkdown,
  listOpenClawManagedSkillSlugs,
  listOpenClawProductSkillSlugs,
  OPENCLAW_L2_MANAGED_MARKER,
  OPENCLAW_L2_ROUTER_MARKER,
  type OpenClawSkillArtifact,
  renderOpenClawProductSkillMarkdown,
  renderOpenClawRouterSkillMarkdown,
} from "./openclaw-adapter.js";
export {
  DEFAULT_OPENCLAW_PRODUCT_COMMANDS,
  depositOpenClawL2ProductCommands,
  FIELD_OPENCLAW_PRODUCT_COMMANDS,
  FIELD_OPENCLAW_PRODUCT_COMMANDS_CLI_ALIAS,
  inspectOpenClawProductCommands,
  loadOpenClawProductCommandsPolicyFromProject,
  type OpenClawL2DepositOptions,
  type OpenClawL2DepositResult,
  type OpenClawProductCommandsPolicy,
  type OpenClawProductCommandsPolicyField,
  resolveOpenClawProductCommandsPolicy,
  validateOpenClawProductCommands,
} from "./openclaw-deposit.js";
export {
  assertOpenClawSlugMapIntegrity,
  isValidOpenClawSlug,
  listOpenClawSlugEntries,
  logicalIdToOpenClawSlug,
  OPENCLAW_LOGICAL_ID_BY_SLUG,
  OPENCLAW_ROUTER_SLUG,
  OPENCLAW_SLUG_BY_LOGICAL_ID,
  OPENCLAW_SLUG_MAX_LEN,
  OPENCLAW_SLUG_PATTERN,
  type OpenClawSlugEntry,
  openClawSlugToLogicalId,
} from "./openclaw-slugs.js";
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
