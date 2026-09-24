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

/**
 * Story write-fence load view (#4956).
 * `unreadableDetail` set → callers MUST fail closed (do not empty-allow).
 * Returned failure avoids new throw-sites for verify:intent-constraint.
 */
export type StoryWriteFenceView = {
  readonly fileScope: string[];
  readonly denyPaths: string[];
  readonly unreadableDetail?: string;
};

export function isStoryWriteFenceUnreadable(
  fence: StoryWriteFenceView,
): fence is StoryWriteFenceView & { readonly unreadableDetail: string } {
  return typeof fence.unreadableDetail === "string" && fence.unreadableDetail.length > 0;
}

function unreadableFence(scopePath: string, detail: string): StoryWriteFenceView {
  return {
    fileScope: [],
    denyPaths: [],
    unreadableDetail: `story write fence unreadable at ${scopePath}: ${detail}`,
  };
}

function detailFromUnknown(err: unknown): string {
  if (err instanceof Error && err.message.trim().length > 0) return err.message;
  return String(err);
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
 * or malformed JSON → unreadableDetail (fail closed, #4956).
 */
export function loadStoryWriteFenceFromPath(
  scopePath: string | null | undefined,
): StoryWriteFenceView {
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
    return unreadableFence(scopePath, detailFromUnknown(err));
  }
}

/**
 * Load story fence from merge-base brief bytes (#4956).
 * Null raw → inactive story fence (brief not on base / first PR).
 * Malformed raw → unreadableDetail (fail closed).
 */
export function loadStoryWriteFenceFromBaseRaw(
  raw: string | null | undefined,
  label = "merge-base brief",
): StoryWriteFenceView {
  if (raw === null || raw === undefined) {
    return { fileScope: [], denyPaths: [] };
  }
  try {
    const data: unknown = JSON.parse(raw);
    return extractStoryFileScope(data);
  } catch (err) {
    return unreadableFence(label, detailFromUnknown(err));
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

/** Short process-local TTL so per-write hooks reuse merge-base / brief reads (#4956). */
const WRITE_FENCE_MEMO_TTL_MS = Number("5000");

type MergeBaseMemoHit =
  | { readonly kind: "sha"; readonly baseRef: string; readonly sha: string }
  | { readonly kind: "inactive" };

type MergeBaseResolveResult =
  | MergeBaseMemoHit
  | { readonly kind: "unreadable"; readonly fence: StoryWriteFenceView };

type BriefRawResult =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable"; readonly fence: StoryWriteFenceView };

type FenceLoadMemoHit = StoryWriteFenceView;

type MemoEntry<T> = { readonly expiresAt: number; readonly value: T };

const mergeBaseMemo = new Map<string, MemoEntry<MergeBaseMemoHit>>();
const fenceLoadMemo = new Map<string, MemoEntry<FenceLoadMemoHit>>();

function memoGet<T>(map: Map<string, MemoEntry<T>>, key: string): T | undefined {
  const hit = map.get(key);
  if (hit === undefined) return undefined;
  if (Date.now() > hit.expiresAt) {
    map.delete(key);
    return undefined;
  }
  return hit.value;
}

function memoSet<T>(map: Map<string, MemoEntry<T>>, key: string, value: T): T {
  map.set(key, { expiresAt: Date.now() + WRITE_FENCE_MEMO_TTL_MS, value });
  return value;
}

/** Test seam: drop process-local write-fence git memos. */
export function clearWriteFenceMemosForTests(): void {
  mergeBaseMemo.clear();
  fenceLoadMemo.clear();
}

function gitSpawnUnreadable(scopePath: string, err: Error | undefined): StoryWriteFenceView {
  if (err !== undefined) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return unreadableFence(scopePath, "'git' executable not found on PATH");
    }
    return unreadableFence(scopePath, detailFromUnknown(err));
  }
  return unreadableFence(scopePath, "git spawn failed");
}

function selectBaseRefForFence(
  projectRoot: string,
): { readonly ok: true; readonly baseRef: string } | { readonly ok: false; readonly fence: StoryWriteFenceView } {
  const envCandidates = [
    process.env.DEFT_BASE_REF,
    process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : undefined,
    process.env.GITHUB_BASE_REF,
  ].filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  for (const cand of [...envCandidates, "origin/master", "origin/main", "master", "main"]) {
    const probe = gitFenceSpawn(projectRoot, ["rev-parse", "--verify", "-q", cand]);
    if (probe.error) return { ok: false, fence: gitSpawnUnreadable("merge-base", probe.error) };
    if (probe.signal) {
      return {
        ok: false,
        fence: unreadableFence(
          "merge-base",
          `git rev-parse killed by signal ${String(probe.signal)}`,
        ),
      };
    }
    if (probe.status === 0) return { ok: true, baseRef: cand };
  }
  return {
    ok: false,
    fence: unreadableFence(
      "merge-base",
      "no merge-base ref (origin/master|main or DEFT_BASE_REF/GITHUB_BASE_REF); " +
        "cannot establish story write fence",
    ),
  };
}

/**
 * Resolve an immutable merge-base commit SHA for the write fence (#4956).
 * Moving refs (origin/master) must not be passed to `git show` — a later base
 * advance would otherwise widen the fence.
 *
 * Non-git cwd → inactive so hook fixtures / non-repo trees keep the prior allow
 * path. Inside a git worktree, missing base ref / merge-base failure →
 * unreadable (fail closed).
 */
function resolveMergeBaseCommitForFence(projectRoot: string): MergeBaseResolveResult {
  const envKey = [process.env.DEFT_BASE_REF ?? "", process.env.GITHUB_BASE_REF ?? ""].join("|");
  const memoKey = `${projectRoot}\0${envKey}`;
  const cached = memoGet(mergeBaseMemo, memoKey);
  if (cached !== undefined) return cached;

  const inside = gitFenceSpawn(projectRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.error) {
    return { kind: "unreadable", fence: gitSpawnUnreadable("merge-base", inside.error) };
  }
  if (inside.signal) {
    return {
      kind: "unreadable",
      fence: unreadableFence(
        "merge-base",
        `git rev-parse killed by signal ${String(inside.signal)}`,
      ),
    };
  }
  // Non-repo / missing cwd (common in hook unit tests) → inactive story fence.
  if (inside.status !== 0) return memoSet(mergeBaseMemo, memoKey, { kind: "inactive" });

  const selected = selectBaseRefForFence(projectRoot);
  if (!selected.ok) return { kind: "unreadable", fence: selected.fence };
  const baseRef = selected.baseRef;
  const mb = gitFenceSpawn(projectRoot, ["merge-base", "HEAD", baseRef]);
  if (mb.error) {
    return { kind: "unreadable", fence: gitSpawnUnreadable("merge-base", mb.error) };
  }
  if (mb.signal) {
    return {
      kind: "unreadable",
      fence: unreadableFence(
        "merge-base",
        `git merge-base killed by signal ${String(mb.signal)}`,
      ),
    };
  }
  const sha = mb.stdout.trim();
  if (mb.status !== 0 || sha.length === 0) {
    const detail = `${mb.stdout}\n${mb.stderr}`.trim();
    return {
      kind: "unreadable",
      fence: unreadableFence(
        "merge-base",
        detail.length > 0 ? detail : `could not compute merge-base of HEAD and ${baseRef}`,
      ),
    };
  }
  return memoSet(mergeBaseMemo, memoKey, { kind: "sha", baseRef, sha });
}

function readMergeBaseBriefRaw(
  projectRoot: string,
  mergeBaseSha: string,
  relPath: string,
): BriefRawResult {
  const path = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const result = gitFenceSpawn(projectRoot, ["show", `${mergeBaseSha}:${path}`]);
  if (result.error) {
    return { kind: "unreadable", fence: gitSpawnUnreadable(`merge-base:${path}`, result.error) };
  }
  if (result.signal) {
    return {
      kind: "unreadable",
      fence: unreadableFence(
        `merge-base:${path}`,
        `git show killed by signal ${String(result.signal)}`,
      ),
    };
  }
  if (result.status === 0) return { kind: "text", text: result.stdout };
  const detail = `${result.stdout}\n${result.stderr}`.trim();
  if (isGitMissingPathDetail(detail)) return { kind: "missing" };
  return {
    kind: "unreadable",
    fence: unreadableFence(
      `merge-base:${path}`,
      detail.length > 0 ? detail : `git show exited ${String(result.status)}`,
    ),
  };
}

/**
 * Runtime write fence: read file_scope from the merge-base brief (#4956).
 * Never uses the working-tree head brief as authority. Missing brief on the
 * resolved merge-base commit, non-git cwd, or scope path outside the project
 * → inactive story fence. Unresolvable base inside a git worktree /
 * present-but-unreadable / git failures → unreadableDetail (fail closed).
 */
export function loadStoryWriteFenceFromMergeBase(
  projectRoot: string,
  scopePath: string | null | undefined,
): StoryWriteFenceView {
  if (scopePath === null || scopePath === undefined || scopePath.trim().length === 0) {
    return { fileScope: [], denyPaths: [] };
  }
  const root = resolve(projectRoot);
  const abs = resolve(scopePath);
  let rel = relative(root, abs).replace(/\\/g, "/");
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) {
    rel = scopePath.replace(/\\/g, "/").replace(/^\.\//, "");
  }
  // Outside-root / stub scope paths (hook fixtures) → inactive story fence.
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) {
    return { fileScope: [], denyPaths: [] };
  }

  const resolved = resolveMergeBaseCommitForFence(root);
  if (resolved.kind === "unreadable") return resolved.fence;
  if (resolved.kind === "inactive") {
    return { fileScope: [], denyPaths: [] };
  }

  const loadKey = `${root}\0${resolved.baseRef}\0${resolved.sha}\0${rel}`;
  const cached = memoGet(fenceLoadMemo, loadKey);
  if (cached !== undefined) return cached;

  const raw = readMergeBaseBriefRaw(root, resolved.sha, rel);
  if (raw.kind === "unreadable") return raw.fence;
  const loaded = loadStoryWriteFenceFromBaseRaw(
    raw.kind === "text" ? raw.text : null,
    `merge-base:${rel}`,
  );
  if (isStoryWriteFenceUnreadable(loaded)) return loaded;
  return memoSet(fenceLoadMemo, loadKey, {
    fileScope: [...loaded.fileScope],
    denyPaths: [...loaded.denyPaths],
  });
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
