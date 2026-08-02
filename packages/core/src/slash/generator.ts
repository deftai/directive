/**
 * Host-agnostic thin-wrapper generator for product slash commands (#3052 / epic #55).
 *
 * Emits IR + markdown templates that per-host emitters (#3053) format into native
 * command/prompt/workflow files. Wrappers stay thin (L5): frontmatter description +
 * short dispatch pointer — never inlined strategy/skill/commands.md bodies.
 *
 * ## Token / context budgets (from #55 token design rules)
 *
 * | When | Target |
 * |---|---|
 * | Idle (user never invokes `/deft…`) | ~0 from command files |
 * | Catalog (`/` menu: name + description × N) | ≤ ~1k tok for the product set |
 * | Single invoke | ~40–100 tok thin wrapper body |
 * | After dispatch | cost of the target strategy/skill (unchanged) |
 *
 * Multi-host deposit does not multiply tokens in one session: each host reads only
 * its own command directory. Real spend is the loaded artifact after invoke.
 */

import {
  listProductCommands,
  logicalIdToFilename,
  logicalIdToFilenameStem,
  PRODUCT_COMMAND_COUNT,
  type ProductCommand,
} from "./product-set.js";

/** Rough UTF-8 bytes-per-token estimate (aligned with agents-md-budget). */
export const BYTES_PER_TOKEN_ESTIMATE = 4;

/** L5: invoke wrapper body budget (≈100 tokens). */
export const MAX_WRAPPER_BODY_TOKENS = 100;

/** Per-command catalog description hard cap for tests (order-of-magnitude 20–50). */
export const MAX_DESCRIPTION_TOKENS = 50;

/** Full product-set description catalog budget (≤ ~1k tok). */
export const MAX_CATALOG_TOKENS = 1000;

/**
 * Host-agnostic intermediate representation for one thin wrapper.
 *
 * Emitters consume this shape without re-listing product names.
 */
export interface ThinWrapperIR {
  /** Canonical slash id, e.g. `/deft:directive:run:interview`. */
  readonly logicalId: string;
  /** Hyphen stem without extension. */
  readonly filenameStem: string;
  /** On-disk filename including `.md`. */
  readonly filename: string;
  /** Catalog description (host frontmatter `description`). */
  readonly description: string;
  readonly dispatchKind: ProductCommand["dispatchKind"];
  /** Content-root-relative primary load path. */
  readonly dispatchPath: string;
  readonly argumentHint?: string;
  /** Body markdown only (no frontmatter). */
  readonly bodyMarkdown: string;
  /** Full file: YAML frontmatter + body (host-agnostic template). */
  readonly fileMarkdown: string;
  /** Estimated body tokens (UTF-8 bytes / {@link BYTES_PER_TOKEN_ESTIMATE}). */
  readonly estimatedBodyTokens: number;
  /** Estimated description tokens. */
  readonly estimatedDescriptionTokens: number;
}

/** Aggregate token budget report for the product set. */
export interface TokenBudgetReport {
  readonly commandCount: number;
  readonly catalogTokens: number;
  readonly maxBodyTokens: number;
  readonly maxDescriptionTokens: number;
  readonly withinBodyBudget: boolean;
  readonly withinDescriptionBudget: boolean;
  readonly withinCatalogBudget: boolean;
  readonly ok: boolean;
}

/** Estimate tokens from a UTF-8 string (bytes / 4). */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / BYTES_PER_TOKEN_ESTIMATE);
}

/**
 * Render the thin body only: short dispatch pointer, no inlined target content.
 *
 * Keeps invoke cost in the ~40–100 token band (L5).
 */
export function renderThinWrapperBody(command: ProductCommand): string {
  const lines = [
    `Read and follow \`${command.dispatchPath}\` (content-relative; deposit under \`.deft/core/\` when installed).`,
    "Honor `$ARGUMENTS` as documented for this command.",
    "Do not inline the strategy, skill, or commands.md body here.",
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * Render host-agnostic file markdown: description frontmatter + thin body.
 *
 * Per-host emitters may re-shape frontmatter keys; the body semantics stay shared.
 */
export function renderThinWrapperFile(command: ProductCommand): string {
  const body = renderThinWrapperBody(command);
  const frontmatterLines = [`description: ${yamlSingleLine(command.description)}`];
  if (command.argumentHint !== undefined) {
    frontmatterLines.push(`argument-hint: ${yamlSingleLine(command.argumentHint)}`);
  }
  return `---\n${frontmatterLines.join("\n")}\n---\n\n${body}`;
}

function yamlSingleLine(value: string): string {
  // Descriptions are product-controlled short ASCII; quote when needed for YAML safety.
  if (/[:#{}[\],&*!|>'"%@`]|^\s|\s$/.test(value) || value === "") {
    return JSON.stringify(value);
  }
  return value;
}

/** Build {@link ThinWrapperIR} for one product command. */
export function generateThinWrapper(command: ProductCommand): ThinWrapperIR {
  const bodyMarkdown = renderThinWrapperBody(command);
  const fileMarkdown = renderThinWrapperFile(command);
  return {
    logicalId: command.logicalId,
    filenameStem: command.filenameStem,
    filename: logicalIdToFilename(command.logicalId),
    description: command.description,
    dispatchKind: command.dispatchKind,
    dispatchPath: command.dispatchPath,
    argumentHint: command.argumentHint,
    bodyMarkdown,
    fileMarkdown,
    estimatedBodyTokens: estimateTokens(bodyMarkdown),
    estimatedDescriptionTokens: estimateTokens(command.description),
  };
}

/**
 * Generate thin wrappers for the full L2 product set (stable order, count === 13).
 *
 * This is the primary API for #3053 emitters.
 */
export function generateThinWrappers(
  commands: readonly ProductCommand[] = listProductCommands(),
): readonly ThinWrapperIR[] {
  return commands.map(generateThinWrapper);
}

/** Measure catalog + per-wrapper body budgets for the generated set. */
export function measureTokenBudget(
  wrappers: readonly ThinWrapperIR[] = generateThinWrappers(),
): TokenBudgetReport {
  const catalogTokens = wrappers.reduce((sum, w) => sum + w.estimatedDescriptionTokens, 0);
  const maxBodyTokens = wrappers.reduce((max, w) => Math.max(max, w.estimatedBodyTokens), 0);
  const maxDescriptionTokens = wrappers.reduce(
    (max, w) => Math.max(max, w.estimatedDescriptionTokens),
    0,
  );
  const withinBodyBudget = wrappers.every((w) => w.estimatedBodyTokens <= MAX_WRAPPER_BODY_TOKENS);
  const withinDescriptionBudget = wrappers.every(
    (w) => w.estimatedDescriptionTokens <= MAX_DESCRIPTION_TOKENS,
  );
  const withinCatalogBudget = catalogTokens <= MAX_CATALOG_TOKENS;
  return {
    commandCount: wrappers.length,
    catalogTokens,
    maxBodyTokens,
    maxDescriptionTokens,
    withinBodyBudget,
    withinDescriptionBudget,
    withinCatalogBudget,
    ok:
      wrappers.length === PRODUCT_COMMAND_COUNT &&
      withinBodyBudget &&
      withinDescriptionBudget &&
      withinCatalogBudget,
  };
}

/**
 * Structural check that a wrapper file looks like a thin pointer template.
 * Used by unit tests and available to emitters for deposit validation.
 */
export function isThinWrapperMarkdown(fileMarkdown: string, dispatchPath: string): boolean {
  if (!fileMarkdown.startsWith("---\n")) {
    return false;
  }
  const close = fileMarkdown.indexOf("\n---\n", 4);
  if (close < 0) {
    return false;
  }
  const frontmatter = fileMarkdown.slice(4, close);
  if (!/^description:\s.+/m.test(frontmatter)) {
    return false;
  }
  const body = fileMarkdown.slice(close + 5);
  if (!body.includes(dispatchPath)) {
    return false;
  }
  // Fat-body guard: refuse multi-kilobyte dumps / obvious strategy section headers.
  if (estimateTokens(body) > MAX_WRAPPER_BODY_TOKENS) {
    return false;
  }
  if (/^##\s+(Phase|Workflow|Steps|Acceptance)\b/m.test(body)) {
    return false;
  }
  return true;
}

/** Re-export mapping helpers for emitter convenience without a second import path. */
export { logicalIdToFilename, logicalIdToFilenameStem, PRODUCT_COMMAND_COUNT };
