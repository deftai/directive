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

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
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

export class StoryWriteFenceUnreadableError extends Error {
  readonly scopePath: string;
  constructor(scopePath: string, cause?: unknown) {
    super(`story write fence unreadable at ${scopePath}`);
    this.name = "StoryWriteFenceUnreadableError";
    this.scopePath = scopePath;
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

function isMissingPathError(err: unknown): boolean {
  if (err !== null && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return true;
  }
  return false;
}

/**
 * Load story fence from an active xBRIEF path (working-tree / test seam).
 * Missing path → inactive story fence (prior allow). Present-but-unreadable
 * or malformed JSON → fail closed (#4956).
 */
export function loadStoryWriteFenceFromPath(scopePath: string | null | undefined): {
  readonly fileScope: string[];
  readonly denyPaths: string[];
} {
  if (scopePath === null || scopePath === undefined || scopePath.trim().length === 0) {
    return { fileScope: [], denyPaths: [] };
  }
  if (!existsSync(scopePath)) {
    return { fileScope: [], denyPaths: [] };
  }
  try {
    const text = readFileSync(scopePath, "utf8");
    const data: unknown = JSON.parse(text);
    return extractStoryFileScope(data);
  } catch (err) {
    if (isMissingPathError(err)) {
      return { fileScope: [], denyPaths: [] };
    }
    throw new StoryWriteFenceUnreadableError(scopePath, err);
  }
}

/**
 * Load story fence from merge-base brief bytes (#4956).
 * Null raw → inactive story fence (brief not on base / first PR).
 * Malformed raw → fail closed.
 */
export function loadStoryWriteFenceFromBaseRaw(
  raw: string | null | undefined,
  label = "merge-base brief",
): {
  readonly fileScope: string[];
  readonly denyPaths: string[];
} {
  if (raw === null || raw === undefined) {
    return { fileScope: [], denyPaths: [] };
  }
  try {
    const data: unknown = JSON.parse(raw);
    return extractStoryFileScope(data);
  } catch (err) {
    throw new StoryWriteFenceUnreadableError(label, err);
  }
}

function isGitMissingPathDetail(detail: string): boolean {
  const s = detail.toLowerCase();
  return (
    s.includes("does not exist") ||
    s.includes("exists on disk, but not in") ||
    s.includes("pathspec")
  );
}

function gitFenceSpawn(
  projectRoot: string,
  args: readonly string[],
): {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly signal: NodeJS.Signals | null;
  readonly error: Error | undefined;
} {
  const result = spawnSync("git", [...args], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    signal: result.signal ?? null,
    error: result.error,
  };
}

/**
 * Resolve an immutable merge-base commit SHA for the write fence (#4956).
 * Moving refs (origin/master) must not be passed to `git show` — a later base
 * advance would otherwise widen the fence. Fail closed when the base cannot be
 * established (no inactive empty fence).
 */
function resolveMergeBaseCommitForFence(projectRoot: string): string {
  const inside = gitFenceSpawn(projectRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.error) {
    const e = inside.error as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new StoryWriteFenceUnreadableError(
        "merge-base",
        new Error("'git' executable not found on PATH"),
      );
    }
    throw new StoryWriteFenceUnreadableError("merge-base", inside.error);
  }
  if (inside.signal) {
    throw new StoryWriteFenceUnreadableError(
      "merge-base",
      new Error(`git rev-parse killed by signal ${String(inside.signal)}`),
    );
  }
  if (inside.status !== 0) {
    throw new StoryWriteFenceUnreadableError(
      "merge-base",
      new Error("not a git worktree; cannot resolve merge-base write fence"),
    );
  }

  const envCandidates = [
    process.env.DEFT_BASE_REF,
    process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : undefined,
    process.env.GITHUB_BASE_REF,
  ].filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  let baseRef: string | null = null;
  for (const cand of [...envCandidates, "origin/master", "origin/main", "master", "main"]) {
    const probe = gitFenceSpawn(projectRoot, ["rev-parse", "--verify", "-q", cand]);
    if (probe.error) {
      const e = probe.error as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        throw new StoryWriteFenceUnreadableError(
          "merge-base",
          new Error("'git' executable not found on PATH"),
        );
      }
      throw new StoryWriteFenceUnreadableError("merge-base", probe.error);
    }
    if (probe.signal) {
      throw new StoryWriteFenceUnreadableError(
        "merge-base",
        new Error(`git rev-parse killed by signal ${String(probe.signal)}`),
      );
    }
    if (probe.status === 0) {
      baseRef = cand;
      break;
    }
  }
  if (baseRef === null) {
    throw new StoryWriteFenceUnreadableError(
      "merge-base",
      new Error(
        "no merge-base ref (origin/master|main or DEFT_BASE_REF/GITHUB_BASE_REF); " +
          "cannot establish story write fence",
      ),
    );
  }

  const mb = gitFenceSpawn(projectRoot, ["merge-base", "HEAD", baseRef]);
  if (mb.error) {
    const e = mb.error as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new StoryWriteFenceUnreadableError(
        "merge-base",
        new Error("'git' executable not found on PATH"),
      );
    }
    throw new StoryWriteFenceUnreadableError("merge-base", mb.error);
  }
  if (mb.signal) {
    throw new StoryWriteFenceUnreadableError(
      "merge-base",
      new Error(`git merge-base killed by signal ${String(mb.signal)}`),
    );
  }
  const sha = mb.stdout.trim();
  if (mb.status !== 0 || sha.length === 0) {
    const detail = `${mb.stdout}\n${mb.stderr}`.trim();
    throw new StoryWriteFenceUnreadableError(
      "merge-base",
      new Error(
        detail.length > 0
          ? detail
          : `could not compute merge-base of HEAD and ${baseRef}`,
      ),
    );
  }
  return sha;
}

function readMergeBaseBriefRaw(
  projectRoot: string,
  mergeBaseSha: string,
  relPath: string,
): string | null {
  const path = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const result = gitFenceSpawn(projectRoot, ["show", `${mergeBaseSha}:${path}`]);
  if (result.error) {
    const e = result.error as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new StoryWriteFenceUnreadableError(
        `merge-base:${path}`,
        new Error("'git' executable not found on PATH"),
      );
    }
    throw new StoryWriteFenceUnreadableError(`merge-base:${path}`, e);
  }
  if (result.signal) {
    throw new StoryWriteFenceUnreadableError(
      `merge-base:${path}`,
      new Error(`git show killed by signal ${String(result.signal)}`),
    );
  }
  if (result.status === 0) return result.stdout;
  const detail = `${result.stdout}\n${result.stderr}`.trim();
  if (isGitMissingPathDetail(detail)) return null;
  throw new StoryWriteFenceUnreadableError(
    `merge-base:${path}`,
    new Error(detail.length > 0 ? detail : `git show exited ${String(result.status)}`),
  );
}

/**
 * Runtime write fence: read file_scope from the merge-base brief (#4956).
 * Never uses the working-tree head brief as authority. Missing brief on the
 * resolved merge-base commit → inactive story fence. Unresolvable base /
 * present-but-unreadable / git failures → throw (fail closed).
 */
export function loadStoryWriteFenceFromMergeBase(
  projectRoot: string,
  scopePath: string | null | undefined,
): {
  readonly fileScope: string[];
  readonly denyPaths: string[];
} {
  if (scopePath === null || scopePath === undefined || scopePath.trim().length === 0) {
    return { fileScope: [], denyPaths: [] };
  }
  const root = resolve(projectRoot);
  const abs = resolve(scopePath);
  let rel = relative(root, abs).replace(/\\/g, "/");
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) {
    rel = scopePath.replace(/\\/g, "/").replace(/^\.\//, "");
  }
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) {
    throw new StoryWriteFenceUnreadableError(
      "merge-base",
      new Error(`scope path escapes project root: ${scopePath}`),
    );
  }

  const mergeBaseSha = resolveMergeBaseCommitForFence(root);
  const raw = readMergeBaseBriefRaw(root, mergeBaseSha, rel);
  return loadStoryWriteFenceFromBaseRaw(raw, `merge-base:${rel}`);
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
    // Carry the project setting through: resolving a write fence must not
    // silently enable Shell dest-form enforcement for a story (#3438 / #3594).
    shellDestForms: projectPolicy.shellDestForms,
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
