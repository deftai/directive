/**
 * Swarm implement-leaf pre-dispatch gate (#3228).
 *
 * Wires #3143 delivery-attempt DENY_DUPLICATE_ACTIVE onto the swarm re-dispatch
 * path: before starting a peer implement leaf on a unit, if a non-terminal
 * attempt already exists → exit non-zero and do not spawn.
 *
 * Takeover is two steps: cancel (complete status=cancelled) the prior attempt,
 * then pre-dispatch begin again — never concurrent dual active.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";
import {
  type AttemptTrigger,
  activeAttempts,
  beginAttempt,
  completeAttempt,
  completeAttemptOnDisk,
  type DeliveryAttemptRecord,
  evaluatePreDispatch,
  hasActiveAttempt,
  listUnitLedgers,
  loadOrCreateUnitLedger,
  loadUnitLedger,
  markBlocked,
  type PreDispatchDecision,
  saveUnitLedger,
  withUnitLock,
} from "../delivery-attempt/index.js";
import { listActiveLifecycleArtifacts, matchPinnedActiveScope } from "../hooks/scope.js";
import { briefOwnsIssue } from "../intake/residual-identity.js";
import { defaultScratchDir } from "../orchestration/subagent-monitor.js";
import {
  defaultFirstSeenDir,
  defaultSteerDir,
  evaluatePreCancel,
  type PreCancelVerdict,
} from "../orchestration/subagent-steer.js";
import {
  canonicalPathIdentity,
  defaultGitRunner,
  type GitRunner,
  gitCommonDir,
  sameWorktreePath,
  worktreePathOrNull,
} from "../session/git.js";
import { isLinkedWorktreePath } from "../session/main-worktree.js";
import { EXIT_CONFIG_ERROR, EXIT_GATE_FAILED, EXIT_OK } from "./constants.js";
import {
  ensureStoryBindingRecord,
  isStoryBindingStoreLockedDetail,
  readStoryBindingRecord,
  removeStoryBindingAttempts,
  type StoryBindingLockWait,
} from "./story-binding-record.js";
import { ensureSubagentStatusDir, looksLikeWorktreeDir } from "./subagent-status-dir.js";
import { runText } from "./subprocess.js";
import { resolveWorkerAuthDestPath, storyIdForBrief } from "./worker-auth-assignment.js";

/** DENY_DUPLICATE_ACTIVE operator hint family (#7274 P4). */
export type DuplicateActiveHintKind = "binding-repair" | "pre-cancel" | "inspect";

/** Default workflow id for drive-to:merge-ready implement leaves. */
export const IMPLEMENT_LEAF_WORKFLOW_ID = "drive-to:merge-ready";

export const PRE_DISPATCH_ACTIONS = ["begin", "complete", "cancel"] as const;
export type PreDispatchAction = (typeof PRE_DISPATCH_ACTIONS)[number];

export const COMPLETE_STATUSES = ["succeeded", "failed", "cancelled", "blocked"] as const;
export type CompleteStatus = (typeof COMPLETE_STATUSES)[number];

export interface SwarmPreDispatchInput {
  readonly projectRoot: string;
  readonly scopeId: string;
  readonly targetId: string;
  readonly workflowId?: string;
  readonly action?: PreDispatchAction;
  readonly sourceRevision?: string;
  readonly attemptId?: string;
  readonly status?: CompleteStatus;
  readonly workerId?: string | null;
  readonly externalRunId?: string | null;
  readonly trigger?: AttemptTrigger;
  readonly now?: string;
  /** Agent id for #5278 pre-cancel on --action cancel (defaults to attempt.workerId). */
  readonly agentId?: string | null;
  /** Canceller identity for pre-cancel writer_id match / --force audit. */
  readonly cancellerId?: string | null;
  readonly steerDir?: string | null;
  readonly scratchDir?: string | null;
  readonly firstSeenDir?: string | null;
  readonly preCancelForce?: boolean;
  readonly preCancelReason?: string | null;
  /** Test seam / injected attestation; when set, replaces live evaluatePreCancel. */
  readonly preCancelEvaluate?: (input: {
    agentId: string;
    cancellerId: string;
    steerDir: string;
    firstSeenDir: string;
    scratchDir: string;
    force: boolean;
    forceReason?: string;
    dispatchStartedAt: string | null;
    expectedWorkerId: string | null;
  }) => PreCancelVerdict;
  /** Begin-facing story-binding store-lock wait (#7274); tests inject sleep/budget. */
  readonly storyBindingLockWait?: StoryBindingLockWait;
}

export interface SwarmPreDispatchResult {
  readonly exitCode: typeof EXIT_OK | typeof EXIT_GATE_FAILED | typeof EXIT_CONFIG_ERROR;
  readonly decision: PreDispatchDecision | null;
  readonly reason: string;
  readonly action: PreDispatchAction;
  readonly scopeId: string;
  readonly targetId: string;
  readonly workflowId: string;
  readonly attempt: DeliveryAttemptRecord | null;
  readonly activeAttemptIds: readonly string[];
  /**
   * One line about the worktree's story-binding record (#6379): written,
   * not written (and why), or attempt ids removed. Absent when begin, cancel
   * or complete had no attempt id to record or remove.
   */
  readonly storyBinding?: string;
  /** Set on DENY_DUPLICATE_ACTIVE so the report hint matches repair vs cancel (#7274). */
  readonly duplicateActiveHint?: DuplicateActiveHintKind;
}

export function resolveSourceRevision(projectRoot: string, explicit?: string): string {
  if (explicit !== undefined && explicit.trim().length > 0) {
    return explicit.trim();
  }
  const captured = runText(["git", "rev-parse", "HEAD"], { cwd: projectRoot });
  if (captured.returncode === 0) {
    const sha = captured.stdout.trim();
    if (sha.length > 0) return sha;
  }
  return "unknown";
}

/**
 * True when targetId should be treated as a filesystem path (worktree), not an
 * opaque branch/ref id. Branch names with `/` (e.g. `feat/foo`) stay opaque.
 */
export function looksLikeFilesystemTarget(targetId: string): boolean {
  const t = targetId.trim();
  if (t.length === 0) return false;
  if (isAbsolute(t) || t.startsWith(".") || t.includes("\\")) return true;
  if (/^[A-Za-z]:[\\/]/.test(t)) return true;
  const lower = t.toLowerCase().replace(/\\/g, "/");
  return (
    lower.includes(".deft-scratch/") ||
    lower.includes("/worktrees/") ||
    lower.startsWith("worktrees/")
  );
}

/**
 * Canonical unit target for ledger keys so relative/absolute/separator/case
 * variants of the same worktree do not split gate state (#3228 Greptile P1).
 *
 * Always resolve under projectRoot to a stable absolute lexical key (even
 * before the path exists). Do **not** realpath: following a symlink that is
 * created between dispatches would change the key and split ledgers.
 * Case-fold prevents case-insensitive FS splits. Existence never changes
 * the ledger key.
 */
export function normalizeTargetId(projectRoot: string, targetId: string): string {
  const trimmed = targetId.trim();
  if (trimmed.length === 0) return trimmed;

  let pathKey = normalize(resolve(projectRoot, trimmed)).replace(/\\/g, "/").toLowerCase();
  if (pathKey.length > 1 && pathKey.endsWith("/")) {
    pathKey = pathKey.slice(0, -1);
  }
  return pathKey;
}

/**
 * Best-effort physical identity for alias peer checks. Ledger keys stay lexical
 * (stable); when a path exists, realpath groups symlink aliases that point at
 * the same worktree so sequential begins still DENY.
 */
export function physicalTargetKey(projectRoot: string, targetId: string): string {
  const lexical = normalizeTargetId(projectRoot, targetId);
  const candidates = [lexical, resolve(projectRoot, targetId.trim()), targetId.trim()];
  for (const candidate of candidates) {
    if (candidate.length === 0 || !existsSync(candidate)) continue;
    try {
      // win32: native identity so an 8.3 alias of one tree is one key (#7200).
      const physical =
        (process.platform === "win32" ? canonicalPathIdentity(candidate) : null) ??
        realpathSync(candidate);
      return normalize(physical).replace(/\\/g, "/").toLowerCase();
    } catch {
      /* try next candidate */
    }
  }
  return lexical;
}

/** True when another unit (same scope+workflow, different target key) is active on same physical path. */
export function hasActiveAliasPeer(
  projectRoot: string,
  scopeId: string,
  targetId: string,
  workflowId: string,
): boolean {
  return aliasPeerActiveIds(projectRoot, scopeId, targetId, workflowId).length > 0;
}

/** Running attempt ids on alias/realpath peers of the target (same scope and workflow). */
export function aliasPeerActiveIds(
  projectRoot: string,
  scopeId: string,
  targetId: string,
  workflowId: string,
): string[] {
  const mine = physicalTargetKey(projectRoot, targetId);
  const ids: string[] = [];
  for (const ledger of listUnitLedgers(projectRoot)) {
    if (ledger.scopeId !== scopeId || ledger.workflowId !== workflowId) continue;
    if (ledger.targetId === targetId) continue;
    if (!hasActiveAttempt(ledger)) continue;
    if (physicalTargetKey(projectRoot, ledger.targetId) === mine) {
      ids.push(...activeAttempts(ledger).map((a) => a.attemptId));
    }
  }
  return ids;
}

/**
 * Attempt ids among `ids` that a unit ledger of this checkout shows as ended
 * (#6379). An id no local ledger knows (another checkout's attempt) is not
 * reported: absence is not proof that it ended.
 */
function endedAttemptIds(projectRoot: string, ids: readonly string[]): string[] {
  const known = new Set<string>();
  const running = new Set<string>();
  for (const ledger of listUnitLedgers(projectRoot)) {
    for (const attempt of ledger.attempts) known.add(attempt.attemptId);
    for (const attempt of activeAttempts(ledger)) running.add(attempt.attemptId);
  }
  return ids.filter((id) => known.has(id) && !running.has(id));
}

function unitFields(input: SwarmPreDispatchInput): {
  scopeId: string;
  targetId: string;
  workflowId: string;
} {
  return {
    scopeId: input.scopeId.trim(),
    targetId: normalizeTargetId(input.projectRoot, input.targetId),
    workflowId: (input.workflowId ?? IMPLEMENT_LEAF_WORKFLOW_ID).trim(),
  };
}

function baseResult(
  input: SwarmPreDispatchInput,
  action: PreDispatchAction,
  partial: {
    exitCode: SwarmPreDispatchResult["exitCode"];
    decision: PreDispatchDecision | null;
    reason: string;
    attempt?: DeliveryAttemptRecord | null;
    activeAttemptIds?: readonly string[];
    storyBinding?: string;
    duplicateActiveHint?: DuplicateActiveHintKind;
  },
): SwarmPreDispatchResult {
  const { scopeId, targetId, workflowId } = unitFields(input);
  return {
    exitCode: partial.exitCode,
    decision: partial.decision,
    reason: partial.reason,
    action,
    scopeId,
    targetId,
    workflowId,
    attempt: partial.attempt ?? null,
    activeAttemptIds: partial.activeAttemptIds ?? [],
    ...(partial.storyBinding !== undefined ? { storyBinding: partial.storyBinding } : {}),
    ...(partial.duplicateActiveHint !== undefined
      ? { duplicateActiveHint: partial.duplicateActiveHint }
      : {}),
  };
}

function attemptHasAttachedWorker(attempt: DeliveryAttemptRecord): boolean {
  return typeof attempt.workerId === "string" && attempt.workerId.trim().length > 0;
}

/**
 * True when the target resolves to a linked worktree whose record is missing
 * or omits any of the attempt ids. Unresolvable targets are not repair-eligible
 * (#7274): plain branch/path units without a binding store stay on DENY.
 */
function storyBindingMissingForAttempts(
  input: Pick<SwarmPreDispatchInput, "projectRoot" | "targetId">,
  attemptIds: readonly string[],
): boolean {
  if (attemptIds.length === 0) return false;
  const target = resolveStoryBindingTarget(input.projectRoot, input.targetId);
  if (!target.ok) return false;
  const read = readStoryBindingRecord(target.worktreePath, target.commonDir);
  if (!read.ok || read.record === null) return true;
  const listed = new Set(read.record.attempt_ids);
  return attemptIds.some((id) => !listed.has(id));
}

function classifyDuplicateActiveHint(
  actives: readonly DeliveryAttemptRecord[],
  bindingMissing: boolean,
): DuplicateActiveHintKind {
  if (actives.some((a) => attemptHasAttachedWorker(a))) return "pre-cancel";
  if (bindingMissing) return "binding-repair";
  return "inspect";
}

function listActiveIds(
  projectRoot: string,
  scopeId: string,
  targetId: string,
  workflowId: string,
): string[] {
  const ledger = loadUnitLedger(projectRoot, scopeId, targetId, workflowId);
  if (ledger === null) return [];
  return activeAttempts(ledger).map((a) => a.attemptId);
}

/**
 * Parse beginAttemptOnDisk-style error messages without a ReDoS-prone regex
 * (CodeQL: polynomial regex on uncontrolled data).
 */
export function parseDecisionFromError(message: string): {
  decision: PreDispatchDecision | null;
  reason: string;
} {
  const prefix = "delivery-attempt ";
  if (!message.startsWith(prefix)) {
    return { decision: null, reason: message };
  }
  const rest = message.slice(prefix.length);
  const colon = rest.indexOf(":");
  if (colon <= 0) {
    return { decision: null, reason: message };
  }
  const code = rest.slice(0, colon).trim();
  // Bound check: decision codes are short fixed tokens (ALLOW_*/DENY_*/BLOCK_*).
  if (code.length > 64 || code.length < 6) {
    return { decision: null, reason: message };
  }
  if (!code.startsWith("ALLOW_") && !code.startsWith("DENY_") && !code.startsWith("BLOCK_")) {
    return { decision: null, reason: message };
  }
  for (let i = 0; i < code.length; i += 1) {
    const c = code.charCodeAt(i);
    const ok =
      (c >= 65 && c <= 90) || // A-Z
      (c >= 48 && c <= 57) || // 0-9
      c === 95; // _
    if (!ok) {
      return { decision: null, reason: message };
    }
  }
  const reason = rest.slice(colon + 1).trim();
  return {
    decision: code as PreDispatchDecision,
    reason: reason.length > 0 ? reason : message,
  };
}

export type StoryBindingTargetResult =
  | { readonly ok: true; readonly worktreePath: string; readonly commonDir: string }
  | { readonly ok: false; readonly reason: string };

export type StoryBindingScopeResult =
  | { readonly ok: true; readonly storyId: string; readonly briefPath: string }
  | { readonly ok: false; readonly reason: string };

/** Shared worktree compare: resolve, win32 fold, win32 physical identity (#7200). */
const sameRepoPath = sameWorktreePath;

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Linked worktree paths with the branch each has checked out (`git worktree list`). */
function linkedWorktreesOnBranch(
  projectRoot: string,
  branch: string,
  runGit: GitRunner,
): string[] | null {
  const listed = runGit(projectRoot, ["worktree", "list", "--porcelain"]);
  if (listed.code !== 0) return null;
  const want = `refs/heads/${branch.replace(/^refs\/heads\//, "")}`;
  const hits: string[] = [];
  let first = true;
  for (const block of listed.stdout.replace(/\r/g, "").split(/\n\n+/)) {
    const lines = block.split("\n");
    const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    if (path === undefined) continue;
    // The first block is the main worktree: only a linked worktree can be bound.
    const isMain = first;
    first = false;
    if (isMain) continue;
    if (lines.some((line) => line === `branch ${want}`)) hits.push(resolve(path));
  }
  return hits;
}

/** True when the checkout looks like a Directive project (#7270 foreign bind). */
export function isDirectiveProjectRoot(root: string): boolean {
  const top = resolve(root);
  return (
    existsSync(join(top, "xbrief", "PROJECT-DEFINITION.xbrief.json")) ||
    existsSync(join(top, "vbrief", "PROJECT-DEFINITION.vbrief.json"))
  );
}

function linkedTarget(
  projectCommon: string,
  dir: string,
  label: string,
  runGit: GitRunner,
): StoryBindingTargetResult {
  const top = worktreePathOrNull(dir, runGit);
  if (top === null) return { ok: false, reason: `target ${label} is not inside a Git worktree` };
  if (!isLinkedWorktreePath(top)) {
    return { ok: false, reason: `target ${label} is not a linked worktree` };
  }
  const commonDir = gitCommonDir(top, runGit);
  if (commonDir === null) {
    return { ok: false, reason: `target ${label} is not a worktree of this repository` };
  }
  if (!sameRepoPath(projectCommon, commonDir)) {
    // #7270: foreign linked Directive worktree writes under its own common-dir.
    if (!isDirectiveProjectRoot(top)) {
      return { ok: false, reason: `target ${label} is not a worktree of this repository` };
    }
  }
  return { ok: true, worktreePath: resolveWorkerAuthDestPath(top, runGit), commonDir };
}

/**
 * Resolve a begin target to one linked worktree (#6379 item 2): an existing
 * directory is a worktree path; anything else is a branch name that exactly
 * one linked worktree has checked out.
 */
export function resolveStoryBindingTarget(
  projectRoot: string,
  targetId: string,
  runGit: GitRunner = defaultGitRunner,
): StoryBindingTargetResult {
  const raw = targetId.trim();
  const label = JSON.stringify(raw);
  if (raw.length === 0) return { ok: false, reason: "target is empty" };
  const projectCommon = gitCommonDir(projectRoot, runGit);
  if (projectCommon === null) {
    return { ok: false, reason: "the project root is not inside a Git repository" };
  }
  const candidate = isAbsolute(raw) ? raw : resolve(projectRoot, raw);
  if (isDirectory(candidate)) return linkedTarget(projectCommon, candidate, label, runGit);
  const onBranch = linkedWorktreesOnBranch(projectRoot, raw, runGit);
  if (onBranch === null) {
    return {
      ok: false,
      reason: `target ${label} is not a directory and worktrees cannot be listed`,
    };
  }
  const only = onBranch[0];
  if (onBranch.length !== 1 || only === undefined) {
    return {
      ok: false,
      reason: `target ${label} is not a directory, and ${onBranch.length} linked worktrees have that branch checked out`,
    };
  }
  return linkedTarget(projectCommon, only, label, runGit);
}

function readBriefPlan(path: string): {
  data: Record<string, unknown> | null;
  plan: Record<string, unknown> | null;
} {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return { data: null, plan: null };
    }
    const data = raw as Record<string, unknown>;
    const plan = data.plan;
    return {
      data,
      plan:
        plan !== null && typeof plan === "object" && !Array.isArray(plan)
          ? (plan as Record<string, unknown>)
          : null,
    };
  } catch {
    return { data: null, plan: null };
  }
}

/**
 * Resolve a scope id to exactly one brief under `xbrief/active/` in the
 * worktree (#6379 item 2): by brief path, story id (plan.id or filename stem)
 * or owned issue number (`6379` or `#6379`).
 */
export function resolveStoryBindingScope(
  worktreePath: string,
  scopeId: string,
): StoryBindingScopeResult {
  const id = scopeId.trim();
  const label = JSON.stringify(id);
  const scanned = listActiveLifecycleArtifacts(worktreePath).paths;
  const matches = new Set<string>();
  const byPath = id.length > 0 ? matchPinnedActiveScope(worktreePath, id, scanned) : null;
  if (byPath !== null) matches.add(byPath);
  const issue = /^#?(\d+)$/.exec(id);
  const issueNumber = issue?.[1] !== undefined ? Number.parseInt(issue[1], 10) : null;
  for (const path of scanned) {
    const { data, plan } = readBriefPlan(path);
    if (id.length > 0 && storyIdForBrief(path, plan) === id) matches.add(path);
    if (issueNumber !== null && data !== null && briefOwnsIssue(data, issueNumber)) {
      matches.add(path);
    }
  }
  const only = [...matches][0];
  if (matches.size !== 1 || only === undefined) {
    return {
      ok: false,
      reason: `scope id ${label} matches ${matches.size} active briefs in ${worktreePath} (need exactly one)`,
    };
  }
  return { ok: true, storyId: storyIdForBrief(only, readBriefPlan(only).plan), briefPath: only };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Write or update the target worktree's story-binding record (#6379 items 1 to
 * 3). Runs no `swarm:launch` readiness check. Begin passes `lockWait` (#7274);
 * callers that must not wait omit it. A failed resolution writes nothing and
 * returns one line naming it.
 */
export function ensureBeginStoryBinding(
  input: Pick<SwarmPreDispatchInput, "projectRoot" | "scopeId" | "targetId" | "storyBindingLockWait">,
  attemptIds: readonly string[],
): string {
  try {
    const target = resolveStoryBindingTarget(input.projectRoot, input.targetId);
    if (!target.ok) return `story-binding: no record written (target): ${target.reason}`;
    const scope = resolveStoryBindingScope(target.worktreePath, input.scopeId);
    if (!scope.ok) return `story-binding: no record written (scope): ${scope.reason}`;
    const wrote = ensureStoryBindingRecord({
      commonDir: target.commonDir,
      worktreePath: target.worktreePath,
      storyId: scope.storyId,
      attemptIds,
      // Checkout root that owns the delivery-attempt ledger (#7270); not common-dir.
      begunFrom: resolve(input.projectRoot),
      // Re-read under the store lock: an attempt a concurrent cancel/complete
      // ended after begin read the ledger is not written back; ids only
      // another checkout's ledger knows are kept.
      endedAttemptIds: (ids) => endedAttemptIds(input.projectRoot, ids),
      lockWait: input.storyBindingLockWait ?? {},
    });
    if (!wrote.ok) return `story-binding: no record written (store): ${wrote.detail}`;
    return (
      `story-binding: ${target.worktreePath} -> ${scope.storyId} ` +
      `(attempts ${wrote.record.attempt_ids.join(",")})`
    );
  } catch (err) {
    return `story-binding: no record written (error): ${errorText(err)}`;
  }
}

function removeEndedFromCommonDir(
  commonDir: string,
  endedAttemptIds: readonly string[],
): { ok: true; updated: number; deleted: number } | { ok: false; detail: string } {
  const removed = removeStoryBindingAttempts({ commonDir, attemptIds: endedAttemptIds });
  if (!removed.ok) return { ok: false, detail: removed.detail };
  return { ok: true, updated: removed.updated.length, deleted: removed.deleted.length };
}

/**
 * Remove ended attempt ids from every story-binding record of this repository
 * (#6379 item 5), and from a foreign dest store when `targetId` resolves there
 * (#7270). Returns null when nothing listed them.
 */
export function removeEndedStoryBindings(
  projectRoot: string,
  endedAttemptIds: readonly string[],
  targetId?: string,
): string | null {
  if (endedAttemptIds.length === 0) return null;
  try {
    const commonDir = gitCommonDir(projectRoot);
    if (commonDir === null) return null;
    const primary = removeEndedFromCommonDir(commonDir, endedAttemptIds);
    if (!primary.ok) return `story-binding: attempt ids not removed: ${primary.detail}`;
    let updated = primary.updated;
    let deleted = primary.deleted;
    const rawTarget = targetId?.trim() ?? "";
    if (rawTarget.length > 0) {
      const target = resolveStoryBindingTarget(projectRoot, rawTarget);
      if (target.ok && !sameRepoPath(commonDir, target.commonDir)) {
        const foreign = removeEndedFromCommonDir(target.commonDir, endedAttemptIds);
        if (!foreign.ok) return `story-binding: attempt ids not removed: ${foreign.detail}`;
        updated += foreign.updated;
        deleted += foreign.deleted;
      }
    }
    if (updated === 0 && deleted === 0) return null;
    return (
      `story-binding: removed ${endedAttemptIds.join(",")} ` +
      `(records deleted ${deleted}, kept ${updated})`
    );
  } catch (err) {
    return `story-binding: attempt ids not removed: ${errorText(err)}`;
  }
}

/**
 * Begin under the unit lock through binding write (#6379 / #7274): wait on the
 * store lock, roll back a just-created attempt if wait fails, and repair-admit
 * an orphan running attempt that still lacks a binding and has no worker.
 */
function runBegin(input: SwarmPreDispatchInput): SwarmPreDispatchResult {
  const { scopeId, targetId, workflowId } = unitFields(input);
  const sourceRevision = resolveSourceRevision(input.projectRoot, input.sourceRevision);
  const trigger: AttemptTrigger = input.trigger ?? "automatic";
  // Arm heartbeat scratch so verify:subagent-alive can return REDISPATCH_OK
  // instead of exit 2 ("scratch dir does not exist") after a host-kill (#3730).
  // A bare relative worktree name (`b3730`) is opaque to the branch-vs-path
  // heuristic, so accept an on-disk worktree as the second arming signal.
  const armTarget = resolve(input.projectRoot, input.targetId.trim());
  if (looksLikeFilesystemTarget(input.targetId) || looksLikeWorktreeDir(armTarget)) {
    // Heartbeat dir only. Child occupancy owner is recorded at claim time
    // (#3999): this parent process does not know a host-env child's id.
    ensureSubagentStatusDir(armTarget);
  }

  try {
    return withUnitLock(input.projectRoot, scopeId, targetId, workflowId, () => {
      // Symlink alias peer: different lexical keys, same physical worktree.
      const peerIds = aliasPeerActiveIds(input.projectRoot, scopeId, targetId, workflowId);
      if (peerIds.length > 0) {
        const activeIds = [
          ...new Set([
            ...listActiveIds(input.projectRoot, scopeId, targetId, workflowId),
            ...peerIds,
          ]),
        ];
        const binding = ensureBeginStoryBinding(input, activeIds);
        return baseResult(input, "begin", {
          exitCode: EXIT_GATE_FAILED,
          decision: "DENY_DUPLICATE_ACTIVE",
          reason: "active attempt exists on alias/realpath peer of target",
          activeAttemptIds: activeIds,
          storyBinding: binding,
          duplicateActiveHint: "inspect",
        });
      }
      const current = loadOrCreateUnitLedger(input.projectRoot, {
        scopeId,
        targetId,
        workflowId,
        now: input.now,
      });
      const actives = activeAttempts(current);

      // P3: orphan repair-admit — missing binding + this unit active + no worker.
      if (actives.length > 0) {
        const bindingMissing = storyBindingMissingForAttempts(
          input,
          actives.map((a) => a.attemptId),
        );
        const noWorker = actives.every((a) => !attemptHasAttachedWorker(a));
        if (bindingMissing && noWorker) {
          const ids = actives.map((a) => a.attemptId);
          const binding = ensureBeginStoryBinding(input, ids);
          if (isStoryBindingStoreLockedDetail(binding)) {
            return baseResult(input, "begin", {
              exitCode: EXIT_GATE_FAILED,
              decision: "DENY_DUPLICATE_ACTIVE",
              reason: "active attempt exists for unit; binding repair blocked by store lock",
              attempt: actives[0] ?? null,
              activeAttemptIds: ids,
              storyBinding: binding,
              duplicateActiveHint: "binding-repair",
            });
          }
          if (binding.startsWith("story-binding: no record written")) {
            return baseResult(input, "begin", {
              exitCode: EXIT_GATE_FAILED,
              decision: "DENY_DUPLICATE_ACTIVE",
              reason: "active attempt exists for unit; binding repair failed",
              attempt: actives[0] ?? null,
              activeAttemptIds: ids,
              storyBinding: binding,
              duplicateActiveHint: "binding-repair",
            });
          }
          const repaired = actives[0] ?? null;
          return baseResult(input, "begin", {
            exitCode: EXIT_OK,
            decision: "ALLOW_RESUME",
            reason: `repair-admit; attempt ${repaired?.attemptId ?? ids[0]} binding restored`,
            attempt: repaired,
            activeAttemptIds: ids,
            storyBinding: binding,
          });
        }
      }

      const decision = evaluatePreDispatch(current, {
        scopeId,
        targetId,
        workflowId,
        sourceRevision,
        trigger,
        now: input.now,
      });
      if (!decision.allowed) {
        if (decision.handoff !== null) {
          const blocked = markBlocked(
            current,
            decision.decision,
            decision.handoff.resumeCondition,
            input.now,
          );
          saveUnitLedger(input.projectRoot, blocked);
        }
        const activeRows = activeAttempts(current);
        const activeIds = activeRows.map((a) => a.attemptId);
        const bindingMissing = storyBindingMissingForAttempts(input, activeIds);
        const hint =
          decision.decision === "DENY_DUPLICATE_ACTIVE"
            ? classifyDuplicateActiveHint(activeRows, bindingMissing)
            : undefined;
        const binding =
          decision.decision === "DENY_DUPLICATE_ACTIVE" && activeIds.length > 0
            ? ensureBeginStoryBinding(input, activeIds)
            : undefined;
        return baseResult(input, "begin", {
          exitCode: EXIT_GATE_FAILED,
          decision: decision.decision,
          reason: decision.reason,
          activeAttemptIds: activeIds,
          ...(binding !== undefined ? { storyBinding: binding } : {}),
          ...(hint !== undefined ? { duplicateActiveHint: hint } : {}),
        });
      }
      const { ledger, attempt } = beginAttempt(current, {
        sourceRevision,
        trigger,
        status: "running",
        workerId: input.workerId ?? null,
        externalRunId: input.externalRunId ?? null,
        now: input.now,
        consumeOverride: decision.decision === "ALLOW_OVERRIDE",
      });
      saveUnitLedger(input.projectRoot, ledger);
      // P1/P2: bind under the same unit lock; roll back on store-lock exhaustion.
      const binding = ensureBeginStoryBinding(input, [attempt.attemptId]);
      if (isStoryBindingStoreLockedDetail(binding)) {
        const rolled = completeAttempt(ledger, {
          attemptId: attempt.attemptId,
          status: "cancelled",
          now: input.now,
        });
        saveUnitLedger(input.projectRoot, rolled);
        return baseResult(input, "begin", {
          exitCode: EXIT_GATE_FAILED,
          decision: null,
          reason:
            `story-binding store lock wait exhausted; attempt ${attempt.attemptId} rolled back`,
          attempt: rolled.attempts.find((a) => a.attemptId === attempt.attemptId) ?? null,
          activeAttemptIds: activeAttempts(rolled).map((a) => a.attemptId),
          storyBinding: binding,
        });
      }
      return baseResult(input, "begin", {
        exitCode: EXIT_OK,
        decision: decision.decision,
        reason: `allowed; attempt ${attempt.attemptId} begun`,
        attempt,
        activeAttemptIds: [attempt.attemptId],
        storyBinding: binding,
      });
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const parsed = parseDecisionFromError(message);
    if (parsed.decision !== null) {
      return baseResult(input, "begin", {
        exitCode: EXIT_GATE_FAILED,
        decision: parsed.decision,
        reason: parsed.reason,
        activeAttemptIds: listActiveIds(input.projectRoot, scopeId, targetId, workflowId),
      });
    }
    return baseResult(input, "begin", {
      exitCode: EXIT_CONFIG_ERROR,
      decision: null,
      reason: message,
      activeAttemptIds: listActiveIds(input.projectRoot, scopeId, targetId, workflowId),
    });
  }
}

function resolveCancelWorktreeRoot(input: SwarmPreDispatchInput): string {
  if (looksLikeFilesystemTarget(input.targetId)) {
    const raw = input.targetId.trim();
    return isAbsolute(raw) ? normalize(raw) : resolve(input.projectRoot, raw);
  }
  return resolve(input.projectRoot);
}

function evaluateCancelPreCancelGate(
  input: SwarmPreDispatchInput,
  active: DeliveryAttemptRecord | null,
): PreCancelVerdict {
  const worktreeRoot = resolveCancelWorktreeRoot(input);
  const agentId = (input.agentId ?? input.workerId ?? active?.workerId ?? "").trim();
  const cancellerId = (input.cancellerId ?? process.env.DEFT_SESSION_ID ?? "").trim();
  const steerDir = input.steerDir?.trim()
    ? resolve(worktreeRoot, input.steerDir)
    : defaultSteerDir(worktreeRoot);
  const scratchDir = input.scratchDir?.trim()
    ? resolve(worktreeRoot, input.scratchDir)
    : defaultScratchDir(worktreeRoot);
  const firstSeenDir = input.firstSeenDir?.trim()
    ? resolve(worktreeRoot, input.firstSeenDir)
    : defaultFirstSeenDir(worktreeRoot);
  const force = input.preCancelForce === true;
  const forceReason = input.preCancelReason ?? undefined;
  const payload = {
    agentId,
    cancellerId,
    steerDir,
    firstSeenDir,
    scratchDir,
    force,
    forceReason,
    dispatchStartedAt: active?.startedAt ?? null,
    expectedWorkerId: active?.workerId ?? null,
  };
  if (input.preCancelEvaluate !== undefined) {
    return input.preCancelEvaluate(payload);
  }
  return evaluatePreCancel(payload);
}

function runComplete(
  input: SwarmPreDispatchInput,
  action: "complete" | "cancel",
): SwarmPreDispatchResult {
  const { scopeId, targetId, workflowId } = unitFields(input);
  const status: CompleteStatus = action === "cancel" ? "cancelled" : (input.status ?? "succeeded");

  const ledger = loadUnitLedger(input.projectRoot, scopeId, targetId, workflowId);
  if (ledger === null) {
    return baseResult(input, action, {
      exitCode: EXIT_GATE_FAILED,
      decision: null,
      reason: "no delivery-attempt ledger for unit",
      activeAttemptIds: [],
    });
  }

  const actives = activeAttempts(ledger);
  if (actives.length === 0 && input.attemptId === undefined && input.externalRunId === undefined) {
    return baseResult(input, action, {
      exitCode: EXIT_GATE_FAILED,
      decision: null,
      reason: "no active attempt to complete/cancel",
      activeAttemptIds: [],
    });
  }

  // Pin the attempt that cleared pre-cancel so cancel cannot retarget a successor
  // that starts between the gate and completeAttemptOnDisk (#5288 Greptile P1).
  // Explicit --attempt-id / --external-run-id that matches no active attempt
  // refuses — never fall back to another worker.
  let cancelPinnedAttemptId: string | undefined = input.attemptId;
  if (action === "cancel" && actives.length > 0) {
    let active: DeliveryAttemptRecord | null = null;
    if (input.attemptId !== undefined) {
      active = actives.find((a) => a.attemptId === input.attemptId) ?? null;
      if (active === null) {
        return baseResult(input, action, {
          exitCode: EXIT_GATE_FAILED,
          decision: null,
          reason: `no active attempt matching --attempt-id ${JSON.stringify(input.attemptId)}`,
          activeAttemptIds: actives.map((a) => a.attemptId),
        });
      }
    } else if (input.externalRunId !== undefined) {
      active = actives.find((a) => a.externalRunId === input.externalRunId) ?? null;
      if (active === null) {
        return baseResult(input, action, {
          exitCode: EXIT_GATE_FAILED,
          decision: null,
          reason: `no active attempt matching --external-run-id ${JSON.stringify(input.externalRunId)}`,
          activeAttemptIds: actives.map((a) => a.attemptId),
        });
      }
    } else {
      active = actives[0] ?? null;
    }
    const pre = evaluateCancelPreCancelGate(input, active);
    if (!pre.ok) {
      return baseResult(input, action, {
        exitCode: pre.exitCode === 2 ? EXIT_CONFIG_ERROR : EXIT_GATE_FAILED,
        decision: null,
        reason: `pre-cancel refused: ${pre.message}`,
        attempt: active,
        activeAttemptIds: actives.map((a) => a.attemptId),
      });
    }
    if (active !== null) {
      cancelPinnedAttemptId = active.attemptId;
    }
  }

  try {
    const next = completeAttemptOnDisk(input.projectRoot, {
      scopeId,
      targetId,
      workflowId,
      attemptId: action === "cancel" ? cancelPinnedAttemptId : input.attemptId,
      externalRunId: input.externalRunId ?? null,
      status,
      now: input.now,
    });
    const closed =
      next.attempts.find(
        (a) => a.attemptId === (action === "cancel" ? cancelPinnedAttemptId : input.attemptId),
      ) ??
      next.attempts.filter((a) => a.endedAt !== null).at(-1) ??
      null;
    const result = baseResult(input, action, {
      exitCode: EXIT_OK,
      decision: null,
      reason: `attempt ${closed?.attemptId ?? "?"} marked ${status}`,
      attempt: closed,
      activeAttemptIds: activeAttempts(next).map((a) => a.attemptId),
    });
    // The attempts this call ended: running before, not running now (#6379 item 5).
    const stillActive = new Set(result.activeAttemptIds);
    const ended = actives.map((a) => a.attemptId).filter((id) => !stillActive.has(id));
    if (closed !== null && closed.endedAt !== null && !ended.includes(closed.attemptId)) {
      ended.push(closed.attemptId);
    }
    const note = removeEndedStoryBindings(input.projectRoot, ended, input.targetId);
    return note === null ? result : { ...result, storyBinding: note };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return baseResult(input, action, {
      exitCode: EXIT_CONFIG_ERROR,
      decision: null,
      reason: message,
      activeAttemptIds: listActiveIds(input.projectRoot, scopeId, targetId, workflowId),
    });
  }
}

/**
 * Swarm pre-dispatch gate for implement leaves.
 *
 * - begin (default): evaluate #3143 gate; on allow, beginAttempt; exit 0 / 1 / 2
 * - complete: terminal success/fail/blocked
 * - cancel: terminal cancel (takeover step 1)
 */
export function swarmPreDispatch(input: SwarmPreDispatchInput): SwarmPreDispatchResult {
  const action: PreDispatchAction = input.action ?? "begin";
  const { scopeId, targetId, workflowId } = unitFields(input);

  if (scopeId.length === 0) {
    return baseResult(input, action, {
      exitCode: EXIT_CONFIG_ERROR,
      decision: null,
      reason: "--scope-id is required (story/issue or xBRIEF plan id)",
    });
  }
  if (targetId.length === 0) {
    return baseResult(input, action, {
      exitCode: EXIT_CONFIG_ERROR,
      decision: null,
      reason: "--target-id is required (worktree path or branch)",
    });
  }
  if (workflowId.length === 0) {
    return baseResult(input, action, {
      exitCode: EXIT_CONFIG_ERROR,
      decision: null,
      reason: "--workflow-id must be non-empty",
    });
  }
  if (!(PRE_DISPATCH_ACTIONS as readonly string[]).includes(action)) {
    return baseResult(input, "begin", {
      exitCode: EXIT_CONFIG_ERROR,
      decision: null,
      reason: `--action must be one of: ${PRE_DISPATCH_ACTIONS.join(", ")}`,
    });
  }
  if (
    action === "complete" &&
    input.status !== undefined &&
    !(COMPLETE_STATUSES as readonly string[]).includes(input.status)
  ) {
    return baseResult(input, action, {
      exitCode: EXIT_CONFIG_ERROR,
      decision: null,
      reason: `--status must be one of: ${COMPLETE_STATUSES.join(", ")}`,
    });
  }

  if (action === "begin") return runBegin(input);
  return runComplete(input, action);
}

/** Human-readable one-line report for CLI stdout. */
export function formatPreDispatchReport(result: SwarmPreDispatchResult): string {
  const unit = `${result.scopeId} / ${result.targetId} / ${result.workflowId}`;
  const decision = result.decision !== null ? result.decision : "n/a";
  const active = result.activeAttemptIds.length > 0 ? result.activeAttemptIds.join(",") : "(none)";
  const lines = [
    `[swarm:pre-dispatch] action=${result.action} exit=${result.exitCode}`,
    `  unit: ${unit}`,
    `  decision: ${decision}`,
    `  reason: ${result.reason}`,
    `  active: ${active}`,
  ];
  if (result.attempt !== null) {
    lines.push(`  attempt: ${result.attempt.attemptId} status=${result.attempt.status}`);
  }
  if (result.storyBinding !== undefined) {
    lines.push(`  ${result.storyBinding}`);
  }
  if (result.exitCode === EXIT_GATE_FAILED && result.decision === "DENY_DUPLICATE_ACTIVE") {
    const hint = result.duplicateActiveHint ?? "pre-cancel";
    if (hint === "binding-repair") {
      lines.push(
        "  hint: do not spawn; binding is missing for the active attempt and no worker id is known.",
        "  Binding-repair: re-run the same swarm:pre-dispatch begin (scope+target) to repair-admit,",
        "  or cancel only after confirming a live worker. REDISPATCH_OK does not lift DENY_DUPLICATE_ACTIVE.",
      );
    } else if (hint === "inspect") {
      lines.push(
        "  hint: do not spawn; an active attempt is already bound for this unit.",
        "  Inspect/resolve-identity before cancel: task swarm:pre-dispatch status / ledger inspect,",
        "  then pre-cancel+cancel only when a worker/subagent id is known. REDISPATCH_OK does not lift DENY_DUPLICATE_ACTIVE.",
      );
    } else {
      lines.push(
        "  hint: do not spawn; a killed worker stays running until cancelled.",
        "  Takeover: task subagent:pre-cancel -- --agent <id> --canceller-id <id> --target-id <target>",
        "  then: task swarm:pre-dispatch -- --scope-id <id> --target-id <target> --action cancel --agent <id>",
        "  then the same command without --action (begin). REDISPATCH_OK does not lift DENY_DUPLICATE_ACTIVE.",
        "  ⊗ bare ledger cancel while pre-cancel is red (#5278).",
      );
    }
  }
  if (result.exitCode === EXIT_GATE_FAILED && result.reason.startsWith("pre-cancel refused:")) {
    lines.push(
      "  hint: write status steer (subagent:steer kind=note|correction), wait observed window/ack,",
      "  clear via heartbeat STALE/missing under grace, or --pre-cancel-force --pre-cancel-reason.",
    );
  }
  return lines.join("\n");
}
