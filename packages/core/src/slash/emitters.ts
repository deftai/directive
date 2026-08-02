/**
 * Per-host native command/prompt emitters (#3053 / epic #55).
 *
 * Maps shared thin-wrapper IR from {@link generateThinWrappers} onto each
 * supported host’s repo-relative path layout. Pure generate-to-path records;
 * filesystem deposit is init-deposit `writeSlashCommandDeposit` (#3054).
 *
 * ## Host id → output directory / file pattern
 *
 * | Host id | Relative directory   | Filename pattern   |
 * |---------|----------------------|--------------------|
 * | claude  | `.claude/commands/`  | `{hyphen-stem}.md` |
 * | cursor  | `.cursor/commands/`  | `{hyphen-stem}.md` |
 * | grok    | `.grok/commands/`    | `{hyphen-stem}.md` |
 * | codex   | `.codex/prompts/`    | `{hyphen-stem}.md` |
 *
 * All four use the shared thin-wrapper markdown template (L5). Adding a host is
 * an additive layout entry + optional frontmatter reshape — not a new product
 * name table (L2 lives in product-set / generator only).
 *
 * ⊗ Empty stub dirs for “enabled but no emitter” (L6).
 * ⊗ Native legacy alias files (L3).
 */

import { generateThinWrappers, isThinWrapperMarkdown, type ThinWrapperIR } from "./generator.js";
import { PRODUCT_COMMAND_COUNT } from "./product-set.js";

/**
 * Hosts with a real slash/prompt emitter layout (aligned with hook host ids).
 * Default enabled set for deposit (#3054) is this list when policy opts in.
 */
export const SLASH_EMITTER_HOSTS = ["claude", "cursor", "grok", "codex"] as const;

export type SlashEmitterHostId = (typeof SLASH_EMITTER_HOSTS)[number];

/** Repo-relative layout for one host’s native command/prompt files. */
export interface HostCommandLayout {
  readonly hostId: SlashEmitterHostId;
  /**
   * Repo-relative directory (posix, no trailing slash).
   * Example: `.claude/commands`
   */
  readonly relativeDir: string;
  /** Human-readable file pattern (always `{stem}.md` for v1). */
  readonly filePattern: string;
  /**
   * Kind of native surface the host loads (documentation + deposit policy).
   * Does not change file contents in v1 — all emit shared thin markdown.
   */
  readonly surfaceKind: "commands" | "prompts";
}

/**
 * Documented host id → directory / file pattern mapping (issue #3053 AC).
 * Frozen; additive registration only.
 */
export const HOST_COMMAND_LAYOUTS: Readonly<Record<SlashEmitterHostId, HostCommandLayout>> =
  Object.freeze({
    claude: Object.freeze({
      hostId: "claude",
      relativeDir: ".claude/commands",
      filePattern: "{stem}.md",
      surfaceKind: "commands",
    }),
    cursor: Object.freeze({
      hostId: "cursor",
      relativeDir: ".cursor/commands",
      filePattern: "{stem}.md",
      surfaceKind: "commands",
    }),
    grok: Object.freeze({
      hostId: "grok",
      relativeDir: ".grok/commands",
      filePattern: "{stem}.md",
      surfaceKind: "commands",
    }),
    codex: Object.freeze({
      hostId: "codex",
      relativeDir: ".codex/prompts",
      filePattern: "{stem}.md",
      surfaceKind: "prompts",
    }),
  });

/** One host-native file ready for deposit (#3054) or tests. */
export interface HostEmittedFile {
  readonly hostId: SlashEmitterHostId;
  /** Canonical slash id from the product set. */
  readonly logicalId: string;
  /** Hyphen filename stem (L4). */
  readonly filenameStem: string;
  /** Basename including `.md`. */
  readonly filename: string;
  /** Repo-relative posix path, e.g. `.claude/commands/deft-continue.md`. */
  readonly relativePath: string;
  /** Thin-wrapper file contents (frontmatter + body). */
  readonly contents: string;
  readonly description: string;
  readonly dispatchPath: string;
}

/** Type guard for {@link SlashEmitterHostId}. */
export function isSlashEmitterHostId(value: string): value is SlashEmitterHostId {
  return (SLASH_EMITTER_HOSTS as readonly string[]).includes(value);
}

/** Stable list of hosts that have real emitters (no stubs). */
export function listSlashEmitterHosts(): readonly SlashEmitterHostId[] {
  return SLASH_EMITTER_HOSTS;
}

/** Look up the documented layout for a host, or throw. */
export function getHostCommandLayout(hostId: SlashEmitterHostId): HostCommandLayout {
  const layout = HOST_COMMAND_LAYOUTS[hostId];
  if (layout === undefined) {
    throw new Error(`No slash emitter layout for host: ${hostId}`);
  }
  return layout;
}

/**
 * Build the repo-relative path for one IR entry under a host layout (L4 filenames).
 */
export function hostRelativePath(hostId: SlashEmitterHostId, filename: string): string {
  const layout = getHostCommandLayout(hostId);
  // Defensive: refuse path separators in filename so deposit cannot escape relativeDir.
  if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
    throw new Error(`Invalid command filename for host emit: ${filename}`);
  }
  return `${layout.relativeDir}/${filename}`;
}

/**
 * Emit host-native file records for one host from shared thin-wrapper IR.
 *
 * Does not redefine the L2 product table — defaults to {@link generateThinWrappers}.
 * Contents stay thin (L5); paths use L4 hyphen names under the host layout.
 */
export function emitHostCommandFiles(
  hostId: SlashEmitterHostId,
  wrappers: readonly ThinWrapperIR[] = generateThinWrappers(),
): readonly HostEmittedFile[] {
  if (!isSlashEmitterHostId(hostId)) {
    throw new Error(`Unknown slash emitter host: ${String(hostId)}`);
  }
  // Snapshot layout once; additive hosts must register before emit.
  getHostCommandLayout(hostId);

  return wrappers.map((w) => {
    const contents = renderHostFileContents(hostId, w);
    return {
      hostId,
      logicalId: w.logicalId,
      filenameStem: w.filenameStem,
      filename: w.filename,
      relativePath: hostRelativePath(hostId, w.filename),
      contents,
      description: w.description,
      dispatchPath: w.dispatchPath,
    };
  });
}

/**
 * Emit for every host that has a real emitter (default: all of {@link SLASH_EMITTER_HOSTS}).
 *
 * Returns a map keyed by host id; each value has count === product set when using
 * default IR.
 */
export function emitAllHostCommandFiles(
  hosts: readonly SlashEmitterHostId[] = SLASH_EMITTER_HOSTS,
  wrappers: readonly ThinWrapperIR[] = generateThinWrappers(),
): ReadonlyMap<SlashEmitterHostId, readonly HostEmittedFile[]> {
  const out = new Map<SlashEmitterHostId, readonly HostEmittedFile[]>();
  for (const hostId of hosts) {
    out.set(hostId, emitHostCommandFiles(hostId, wrappers));
  }
  return out;
}

/**
 * Host-specific markdown reshape hook.
 *
 * v1: all hosts share the generator’s host-agnostic `fileMarkdown` (description +
 * optional argument-hint + thin body). Future hosts may remap frontmatter keys
 * here without touching the product name table.
 */
export function renderHostFileContents(
  _hostId: SlashEmitterHostId,
  wrapper: ThinWrapperIR,
): string {
  return wrapper.fileMarkdown;
}

/** Assert emitted contents remain thin pointers (for tests and deposit validation). */
export function assertThinHostEmission(files: readonly HostEmittedFile[]): void {
  if (files.length !== PRODUCT_COMMAND_COUNT) {
    throw new Error(`Expected ${PRODUCT_COMMAND_COUNT} host command files, got ${files.length}`);
  }
  for (const f of files) {
    if (!isThinWrapperMarkdown(f.contents, f.dispatchPath)) {
      throw new Error(`Non-thin emission for ${f.relativePath}`);
    }
  }
}
