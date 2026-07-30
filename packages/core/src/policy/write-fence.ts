/**
 * Unified path write fence (#516 / #2443 / #2948 Wave 3).
 *
 * Single evaluation SoT: path checks always go through
 * `evaluateRuntimeAuthorityPath` / `evaluateRuntimeAuthorityDirectWrite`.
 * This module only **resolves** a RuntimeAuthorityPolicy by intersecting
 * project `runtimeAuthority.allowPaths` / `denyPaths` with optional story
 * `plan.metadata.swarm.file_scope` (and a read-time `writeScope` alias).
 *
 * There is no second independent writeScope evaluation engine.
 */

import { readFileSync } from "node:fs";
import {
  DEFAULT_RUNTIME_AUTHORITY_POLICY,
  DEFAULT_RUNTIME_AUTHORITY_SCOPES,
  type RuntimeAuthorityPolicy,
  type WriteFenceSource,
} from "./runtime-authority.js";

/** Clean non-empty path glob strings. */
function cleanGlobs(raw: readonly string[] | null | undefined): string[] {
  if (raw === null || raw === undefined) return [];
  return raw.filter((s): s is string => typeof s === "string" && s.trim().length > 0);
}

function cleanGlobArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is string => typeof s === "string" && s.trim().length > 0);
}

/**
 * Normalize a legacy #2443 `writeScope` alias into `file_scope` + deny globs.
 * Accepts:
 * - `string[]` → allow list
 * - `{ allow?: string[], deny?: string[] }`
 * - `{ file_scope?: string[], denyPaths?: string[] }` (already-normalized shape)
 *
 * Callers MUST feed the result into {@link resolveWriteFence}; do not evaluate
 * writeScope with a separate matcher.
 */
export function normalizeStoryWriteScope(raw: unknown): {
  readonly fileScope: string[];
  readonly denyPaths: string[];
} {
  if (raw === null || raw === undefined) {
    return { fileScope: [], denyPaths: [] };
  }
  if (Array.isArray(raw)) {
    return { fileScope: cleanGlobArray(raw), denyPaths: [] };
  }
  if (typeof raw !== "object") {
    return { fileScope: [], denyPaths: [] };
  }
  const rec = raw as Record<string, unknown>;
  const allow = cleanGlobArray(rec.allow ?? rec.file_scope ?? rec.fileScope);
  const deny = cleanGlobArray(rec.deny ?? rec.denyPaths);
  return { fileScope: allow, denyPaths: deny };
}

/**
 * Extract story write fence from an xBRIEF/vBRIEF document.
 * Prefer `plan.metadata.swarm.file_scope`; fall back to normalized `writeScope`
 * on `plan.metadata.swarm` or `plan.metadata` (read-time alias only).
 */
export function extractStoryFileScope(storyData: unknown): {
  readonly fileScope: string[];
  readonly denyPaths: string[];
} {
  if (typeof storyData !== "object" || storyData === null || Array.isArray(storyData)) {
    return { fileScope: [], denyPaths: [] };
  }
  const plan = (storyData as Record<string, unknown>).plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return { fileScope: [], denyPaths: [] };
  }
  const metadata = (plan as Record<string, unknown>).metadata;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return { fileScope: [], denyPaths: [] };
  }
  const meta = metadata as Record<string, unknown>;
  const swarmRaw = meta.swarm;
  const swarm =
    typeof swarmRaw === "object" && swarmRaw !== null && !Array.isArray(swarmRaw)
      ? (swarmRaw as Record<string, unknown>)
      : null;

  const fromFileScope = cleanGlobArray(swarm?.file_scope ?? swarm?.fileScope);
  const fromWriteScope = normalizeStoryWriteScope(
    swarm?.writeScope ?? swarm?.write_scope ?? meta.writeScope ?? meta.write_scope,
  );

  // file_scope is SoT when present; writeScope alias only when file_scope empty.
  if (fromFileScope.length > 0) {
    // Still merge writeScope.deny so legacy deny lists are not lost.
    return {
      fileScope: fromFileScope,
      denyPaths: fromWriteScope.denyPaths,
    };
  }
  return fromWriteScope;
}

/** Load story fence from an active xBRIEF path (fail-open on IO/parse errors). */
export function loadStoryWriteFenceFromPath(scopePath: string | null | undefined): {
  readonly fileScope: string[];
  readonly denyPaths: string[];
} {
  if (scopePath === null || scopePath === undefined || scopePath.trim().length === 0) {
    return { fileScope: [], denyPaths: [] };
  }
  try {
    const text = readFileSync(scopePath, "utf8");
    const data: unknown = JSON.parse(text);
    return extractStoryFileScope(data);
  } catch {
    // Residual: host/session may not surface a readable active story.
    // Fail open at story layer (project policy still applies if enabled).
    return { fileScope: [], denyPaths: [] };
  }
}

export interface ResolveWriteFenceOptions {
  /** Extra deny globs from normalized writeScope.deny (merged; deny always wins). */
  readonly storyDenyPaths?: readonly string[] | null;
}

export interface ResolvedWriteFence {
  /**
   * Policy for `evaluateRuntimeAuthorityPath` / `evaluateRuntimeAuthorityDirectWrite`.
   * This is the only evaluation shape — no parallel engine.
   */
  readonly policy: RuntimeAuthorityPolicy;
  /** Layers that contribute to this fence (empty when inactive). */
  readonly sources: readonly WriteFenceSource[];
  /** True when project and/or story path fence is active. */
  readonly fenceActive: boolean;
  readonly storyAllowPaths: readonly string[];
  readonly storyDenyPaths: readonly string[];
}

/**
 * Intersect project `runtimeAuthority` with optional story `file_scope`.
 *
 * Rules:
 * - Empty project `allowPaths` when enabled = all paths until story narrows.
 * - Empty story scope = project policy only.
 * - Story `file_scope` alone enables a fence even when project policy is disabled.
 * - `denyPaths` always win (project + story-normalized denys).
 * - When both project allowPaths and story file_scope are non-empty, a path must
 *   match **both** layers (AND / intersection semantics via dual allow layers).
 */
export function resolveWriteFence(
  projectPolicy: RuntimeAuthorityPolicy,
  storyFileScope?: readonly string[] | null,
  options?: ResolveWriteFenceOptions,
): ResolvedWriteFence {
  const storyAllow = cleanGlobs(storyFileScope);
  const storyDeny = cleanGlobs(options?.storyDenyPaths);
  const projectActive = projectPolicy.enabled;
  const storyActive = storyAllow.length > 0 || storyDeny.length > 0;

  if (!projectActive && !storyActive) {
    return {
      policy: DEFAULT_RUNTIME_AUTHORITY_POLICY,
      sources: [],
      fenceActive: false,
      storyAllowPaths: [],
      storyDenyPaths: [],
    };
  }

  const sources: WriteFenceSource[] = [];
  if (projectActive) sources.push("project");
  if (storyActive) sources.push("story");

  // Project denyPaths + story denyPaths; deny always wins at evaluation time.
  const denyPaths = [...projectPolicy.denyPaths, ...storyDeny];

  // Project allow layer only when project policy is enabled (empty = unrestricted until story).
  const allowPaths = projectActive ? [...projectPolicy.allowPaths] : [];

  // Story-only: enable fence with default scopes (edits true) so direct writes are gated.
  const scopes = projectActive
    ? projectPolicy.scopes
    : { ...DEFAULT_RUNTIME_AUTHORITY_SCOPES, edits: true };

  const policy: RuntimeAuthorityPolicy = {
    enabled: true,
    allowPaths,
    denyPaths,
    scopes,
    storyAllowPaths: storyAllow,
    fenceSources: sources,
  };

  return {
    policy,
    sources,
    fenceActive: true,
    storyAllowPaths: storyAllow,
    storyDenyPaths: storyDeny,
  };
}

/**
 * Resolve the write fence for PreToolUse / product sinks.
 * Composes project policy with story fence extracted from an active xBRIEF path.
 */
export function resolveWriteFenceForScope(
  projectPolicy: RuntimeAuthorityPolicy,
  scopePath: string | null | undefined,
  loadStory: (path: string | null | undefined) => {
    fileScope: readonly string[];
    denyPaths: readonly string[];
  } = loadStoryWriteFenceFromPath,
): ResolvedWriteFence {
  const story = loadStory(scopePath);
  return resolveWriteFence(projectPolicy, story.fileScope, {
    storyDenyPaths: story.denyPaths,
  });
}
