import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  type AuthzDecision,
  type AuthzState,
  appendAuthzAudit,
  classifyHookAuthzOps,
  evaluateAuthzMutation,
  evidenceSatisfiesImplementationApproval,
  type HumanOriginGrant,
  listActiveHumanGrants,
  loadAuthzStateResult,
  markGrantUsed,
  shouldConsumeSingleUseGrant,
  utcIso,
} from "../authz/index.js";
import { runningInsideDeftRepo } from "../doctor/paths.js";
import {
  assertProjectionContained,
  ProjectionContainmentError,
} from "../fs/projection-containment.js";
import { hasArtifactSuffix } from "../layout/resolve.js";
import {
  detectDeftDirectiveDisable,
  formatDeftDirectiveDisableMessage,
  isDeftDirectiveDisableActive,
} from "../policy/deft-directive-disable.js";
import { evaluateIntentCeilingFromEnv, type IntentCeilingOp } from "../policy/intent-ceiling.js";
import {
  detectNoDeftDirective,
  NO_DEFT_DIRECTIVE_DISABLED_MESSAGE,
  NO_DEFT_DIRECTIVE_INCONSISTENT_MESSAGE,
} from "../policy/no-deft-directive.js";
import {
  classifyMcpTool,
  DEFAULT_RUNTIME_AUTHORITY_POLICY,
  evaluateRuntimeAuthorityDirectWrite,
  evaluateRuntimeAuthorityShellOp,
  listShellOps,
  loadRuntimeAuthorityFromProject,
  type RuntimeAuthorityPolicy,
  type RuntimeAuthorityShellOp,
} from "../policy/runtime-authority.js";
import { loadStoryWriteFenceFromPath, resolveWriteFence } from "../policy/write-fence.js";
import {
  appendSoftAgentsRebindToMessage,
  decisionCarriesSoftAgentsRebind,
  formatSoftAgentsRebindChecklist,
} from "../session/compact-ritual.js";
import {
  defaultGitRunner,
  detectBranch,
  existingAncestorDir,
  type GitRunner,
  gitCommonDir,
  memoizeGitRunner,
  worktreePathOrNull,
} from "../session/git.js";
import { evaluateOccupancyWriteGate } from "../session/occupancy.js";
import { emitSessionRitualBlockedProcessCost } from "../session/process-cost.js";
import { markRitualStaleAfterCompact } from "../session/ritual-sentinel.js";
import { runSessionStartHookWrite } from "../session/session-start-hook.js";
import {
  type DetectWorkSelection,
  formatRitualRecoveryInstruction,
  type RitualRunner,
  type VerifyResult,
  verifySessionRitual,
  writeGateRitualOptions,
} from "../session/verify-session-ritual.js";
import {
  type HookPayloadContext,
  hookMcpArgsText,
  hookMutationTargetPaths,
  hookShellCommand,
  hookToolName,
  hookWriteTargetPath,
  inspectExactLifecycleCommand,
  missingToolNameMessage,
  record,
  resolveHookHostIdentity,
  rewriteExactLifecycleCommand,
  toolInputRecord,
} from "./classify/index.js";
import { classifyProductDestForms, payloadWithInjectedWriteTarget } from "./dest-form.js";
import {
  isAssistPosture,
  isEphemeralSpawn,
  isExploreSpawn,
  isReadOnlyHookContext,
} from "./readonly.js";
import { type ActiveScopeInspection, inspectActiveScope } from "./scope.js";
import { isDirectWriteTool, isMcpTool, isShellTool, isSpawnTool } from "./tools.js";

// Pure parse/classify helpers are defined in ./classify/ and re-exported from
// ./index.ts (#2950). Dispatcher is orchestration: classify → policy → decision.

export {
  ASSIST_SESSION_POSTURE_ENV,
  hookReadOnlyFromPayload,
  isAssistPosture,
  isEphemeralSpawn,
  isExploreSpawn,
  isReadOnlyHookContext,
} from "./readonly.js";
export {
  DIRECT_WRITE_HOOK_MATCHER,
  DIRECT_WRITE_TOOL_NAMES,
  isDirectWriteTool,
  isMcpTool,
  isShellTool,
  isSpawnTool,
  MCP_HOOK_MATCHER,
  MCP_PUSH_MERGE_BARE_NAMES,
  READ_ONLY_HOOK_ENV,
  SHELL_HOOK_MATCHER,
  SHELL_TOOL_NAMES,
  SPAWN_HOOK_MATCHER,
  SPAWN_TOOL_NAMES,
} from "./tools.js";

export const HOOK_HOSTS = ["claude", "grok", "cursor", "codex"] as const;
export type HookHost = (typeof HOOK_HOSTS)[number];

export const HOOK_EVENTS = ["session.start", "session.compact", "tool.before"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Hosts that receive compact/resume hook deposits via init/update (#2113). */
export const COMPACT_HOOK_HOSTS = ["claude", "grok", "cursor"] as const;
export type CompactHookHost = (typeof COMPACT_HOOK_HOSTS)[number];

/** Hosts without a native compact hook surface — deposit skips cleanly (#2113). */
export const COMPACT_HOOK_SKIP_HOSTS = ["codex"] as const;

export type HookVerdict = "allow" | "deny";
export type HookDecisionCode =
  | "session-start"
  | "session-start-disabled"
  | "session-start-degraded"
  /** Enforcement skipped: root `.deft-directive-disable` test kill-switch (#3039). */
  | "directive-disabled"
  | "session-compact-rearm"
  | "session-compact-rearm-degraded"
  | "session-compact-noop"
  | "not-direct-write"
  | "invalid-input"
  /** Host closed stdin with zero bytes — integration failure, not a policy gate (#2864). */
  | "stdin-empty"
  | "ritual-not-ready"
  /** Product-path write while another live session occupies this worktree (#3433). */
  | "occupancy-occupied"
  /** A supported host omitted or malformed its cooperative payload owner (#3611). */
  | "occupancy-identity-unavailable"
  /** Host payload identity conflicts with explicit/environment identity (#3611). */
  | "occupancy-identity-conflict"
  /** Live lease and exact verified ritual state name different owners (#3611). */
  | "occupancy-ritual-mismatch"
  /** Write target resolved to a Git repository that does not share git-common-dir (#3794). */
  | "foreign-repository-deny"
  | "scope-not-ready"
  | "write-propose-ready"
  /** Allowlisted assist/scratch write without active xBRIEF (#1802). */
  | "write-assist-scratch-ready"
  | "write-ready"
  | "read-only-deny"
  | "spawn-explore-ready"
  /** Non-lifecycle assist/docs spawn allowed without active xBRIEF (#3080). */
  | "spawn-ephemeral-ready"
  | "spawn-ready"
  | "spawn-not-ready"
  | "runtime-policy-deny-path"
  | "runtime-policy-deny-scope"
  /** Shell/MCP classifiable push/merge allowed under runtimeAuthority (#2711). */
  | "shell-op-ready"
  /** Shell/MCP tool seen but command/tool not classifiable as push/merge — fail open (#2711). */
  | "shell-op-unclassifiable"
  /** UAT lease / human-origin grant denial (#2944). */
  | "authz-uat-deny"
  | "authz-grant-missing"
  | "authz-grant-origin-reject"
  | "authz-grant-scope-deny"
  | "authz-grant-expired"
  | "authz-grant-revoked"
  | "authz-grant-single-use-spent"
  /** Slash-command intent ceiling denial (#1193). */
  | "intent-ceiling-deny";

export interface HookDecision {
  readonly verdict: HookVerdict;
  readonly code: HookDecisionCode;
  readonly event: HookEvent;
  readonly host: HookHost;
  readonly toolName: string | null;
  readonly projectRoot: string;
  readonly message: string;
  readonly scopePath: string | null;
  /** Complete host tool input replacement for an exact lifecycle command (#3611). */
  readonly updatedInput?: Readonly<Record<string, unknown>>;
}

export interface HookDispatchInput {
  readonly host: HookHost;
  readonly event: HookEvent;
  readonly projectRoot: string;
  readonly payload: unknown;
  readonly payloadContext?: HookPayloadContext;
  /** Injected for tests; defaults to `process.env`. */
  readonly environ?: NodeJS.ProcessEnv;
}

export interface HookPolicySeams {
  /** Active mutation-boundary verifier. Defaults to gated verification. */
  readonly verifyRitual?: (projectRoot: string) => VerifyResult;
  /** @deprecated Compatibility seam for existing tests and callers. */
  readonly inspectRitual?: (projectRoot: string) => VerifyResult;
  /**
   * Test seam: ritual runner used by the default write-gate verifier (#3738).
   * Ignored when `verifyRitual` / `inspectRitual` is supplied.
   */
  readonly ritualRunner?: RitualRunner;
  /**
   * Test seam: work-selection detector for the default write-gate verifier (#3738).
   * Ignored when `verifyRitual` / `inspectRitual` is supplied.
   */
  readonly detectWorkSelection?: DetectWorkSelection;
  /**
   * Test seam: git runner for the default write-gate verifier (#3738).
   * Ignored when `verifyRitual` / `inspectRitual` is supplied.
   */
  readonly ritualRunGit?: GitRunner;
  readonly inspectScope?: (projectRoot: string) => ActiveScopeInspection;
  readonly sessionStart?: (projectRoot: string) => { code: number; stdout: string; stderr: string };
  /** Test seam for #2926 root opt-out on SessionStart. */
  readonly detectNoDeftDirective?: typeof detectNoDeftDirective;
  /** Test seam for #3039 root test kill-switch (precedence over #2926 for enforcement). */
  readonly detectDeftDirectiveDisable?: typeof detectDeftDirectiveDisable;
  readonly markCompactStale?: (projectRoot: string) => {
    changed: boolean;
    statePath: string;
    message: string;
  };
  readonly loadRuntimeAuthority?: (projectRoot: string) => RuntimeAuthorityPolicy;
  /**
   * Test seam for #516 / #2443 story write fence.
   * Defaults to reading `plan.metadata.swarm.file_scope` (+ writeScope alias)
   * from the active scope path when present.
   */
  readonly loadStoryWriteFence?: (
    projectRoot: string,
    scopePath: string | null,
  ) => { readonly fileScope: readonly string[]; readonly denyPaths: readonly string[] };
  /** Test seam for #2944 UAT lease + human-origin grants. */
  readonly loadAuthzState?: (projectRoot: string) => AuthzState;
  readonly loadAuthzGrants?: (
    projectRoot: string,
    state: AuthzState,
  ) => readonly HumanOriginGrant[];
  /** When false, skip writing `.deft/authz/audit.jsonl` (tests). Default true. */
  readonly authzAudit?: boolean;
  /** Test seam for restricting Task lifecycle rewrites to the Directive source repo. */
  readonly runningInsideDeftRepo?: (projectRoot: string) => boolean;
  /** Test seam for execution-root realpath binding in lifecycle rewrites. */
  readonly realpathLifecycleExecutionRoot?: (path: string) => string;
  /** Test seam for Windows drive-only execution-root payloads (#2787). */
  readonly lifecycleExecutionPlatform?: NodeJS.Platform;
}

/** POSIX-ish project-relative path for lifecycle matching. */
export function toProjectRelativePosix(projectRoot: string, targetPath: string): string {
  const abs = resolve(projectRoot, targetPath.replace(/\\/g, "/"));
  const rel = relative(resolve(projectRoot), abs);
  return rel.split(sep).join("/").replace(/\\/g, "/");
}

function posixRelative(fromAbs: string, toAbs: string): string {
  return relative(fromAbs, toAbs).split(sep).join("/").replace(/\\/g, "/");
}

/**
 * Lexical "outside project root" predicate used by #2885.
 * - `".."` / `"../…"` are outside (not bare `startsWith("..")` — that matches `..secret`).
 * - Absolute relatives and win32 cross-drive paths (`D:/…`) are outside.
 * - Drive-letter form is win32-only so POSIX children like `D:/tmp/x` stay in-repo.
 */
export function isLexicalOutsideProjectRoot(relPosix: string): boolean {
  if (relPosix === ".." || relPosix.startsWith("../") || isAbsolute(relPosix)) {
    return true;
  }
  // path.relative returns absolute drive paths across volumes on Windows only.
  return process.platform === "win32" && /^[A-Za-z]:\//.test(relPosix);
}

/**
 * True when a write target is outside `projectRoot` for the active-scope skip (#2885).
 * Lexically outside paths still fail the skip when a symlink/junction re-enters the project.
 * When the project root cannot be realpath'd (unit fixtures), lexical classification wins.
 */
export function isOutsideProjectRootWrite(projectRoot: string, targetPath: string): boolean {
  const projectAbs = resolve(projectRoot);
  const targetAbs = resolve(projectRoot, targetPath.replace(/\\/g, "/"));
  const rel = posixRelative(projectAbs, targetAbs);
  if (!isLexicalOutsideProjectRoot(rel)) return false;

  try {
    const projectReal = realpathSync(projectAbs);
    let probe = targetAbs;
    for (;;) {
      try {
        const probeReal = realpathSync(probe);
        const reenter = posixRelative(projectReal, probeReal);
        // Empty reenter ⇒ probeReal === projectReal (inside). Lexical-outside reenter ⇒ truly out.
        if (reenter === "" || !isLexicalOutsideProjectRoot(reenter)) return false;
        return true;
      } catch {
        const parent = dirname(probe);
        if (parent === probe) return true;
        probe = parent;
      }
    }
  } catch {
    return true;
  }
}

/**
 * Proposing a scope under xbrief/proposed/ (or legacy vbrief/proposed/) is
 * planning, not implementation dispatch — exempt from the active-scope gate (#2625).
 */
export function isProposedLifecycleWrite(projectRoot: string, targetPath: string | null): boolean {
  if (targetPath === null || targetPath.trim().length === 0) return false;
  const posix = toProjectRelativePosix(projectRoot, targetPath);
  // resolve()+relative() collapses mid-path `..`; only outside-root `..` remains.
  if (posix.startsWith("..")) return false;
  const base = posix.includes("/") ? posix.slice(posix.lastIndexOf("/") + 1) : posix;
  if (!hasArtifactSuffix(base)) return false;
  return posix.startsWith("xbrief/proposed/") || posix.startsWith("vbrief/proposed/");
}

/**
 * Canonical + gitignored assist scratch roots for low-ceremony disposable notes (#1802).
 * Path fence only — not free-text "for Obsidian" NLP. Tracked trees (src/, packages/, …)
 * are never listed here.
 */
export const ASSIST_SCRATCH_ROOT_PREFIXES = [".deft-scratch/", "temp/"] as const;

/**
 * True when the write target is under an allowlisted disposable scratch root (#1802).
 * Fail closed on null/empty/unparseable targets and on path escape (`..`).
 * Does not authorize tracked product paths even under assist posture.
 *
 * #3186: after lexical allowlist match, realpath the scratch root and require
 * {@link assertProjectionContained}; refuse symlink scratch roots and any
 * realpath outside the project (host Write would follow the link).
 * When the project root cannot be realpath'd (unit fixtures), lexical classification wins.
 */
export function isAllowlistedAssistScratchPath(
  projectRoot: string,
  targetPath: string | null,
): boolean {
  if (targetPath === null || targetPath.trim().length === 0) return false;
  const posix = toProjectRelativePosix(projectRoot, targetPath);
  // resolve()+relative() collapses mid-path `..`; only outside-root `..` remains.
  if (posix === ".." || posix.startsWith("../") || isAbsolute(posix)) return false;
  if (isLexicalOutsideProjectRoot(posix)) return false;
  let matchedPrefix: string | null = null;
  for (const prefix of ASSIST_SCRATCH_ROOT_PREFIXES) {
    if (posix === prefix.slice(0, -1) || posix.startsWith(prefix)) {
      matchedPrefix = prefix;
      break;
    }
  }
  if (matchedPrefix === null) return false;

  // #3186 containment: realpath scratch root + projection fence (symlink escape).
  const projectAbs = resolve(projectRoot);
  try {
    realpathSync(projectAbs);
  } catch {
    // Unit fixtures / missing project dir — lexical allowlist only.
    return true;
  }

  const scratchRootName = matchedPrefix.slice(0, -1); // ".deft-scratch" | "temp"
  const scratchRootAbs = resolve(projectAbs, scratchRootName);
  try {
    // Refuse when the scratch root (or any parent on the path) escapes via symlink.
    assertProjectionContained(projectAbs, scratchRootAbs);
  } catch (err) {
    if (err instanceof ProjectionContainmentError) return false;
    return false;
  }

  // Refuse symlink scratch roots entirely (#3186) — even in-tree links can divert Write.
  try {
    const st = lstatSync(scratchRootAbs);
    if (st.isSymbolicLink()) return false;
  } catch {
    // Scratch root does not exist yet — mkdir will create a real directory; allow.
  }

  // Also fence the concrete write target when it already exists on disk.
  const targetAbs = resolve(projectAbs, targetPath.replace(/\\/g, "/"));
  try {
    assertProjectionContained(projectAbs, targetAbs);
  } catch (err) {
    if (err instanceof ProjectionContainmentError) return false;
    return false;
  }

  return true;
}

/**
 * Assist/ephemeral classification for scratch-write carve-out (#1802).
 * Requires allowlisted path AND (assist posture markers OR ephemeral spawn markers).
 * Path alone without posture markers fails closed to the mutation gate stack.
 */
export function isAssistScratchWrite(
  projectRoot: string,
  targetPath: string | null,
  payload: unknown,
  environ: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isAllowlistedAssistScratchPath(projectRoot, targetPath)) return false;
  // Structural classification only — compose with #3080 / #3259 ephemeral markers.
  if (isAssistPosture(payload, environ)) return true;
  if (isEphemeralSpawn(payload, environ)) return true;
  return false;
}

function isWindowsDriveOnlyRoot(
  value: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32" && /^[A-Za-z]:[/\\]?$/.test(value.trim());
}

function hookPayloadRootCandidates(input: Record<string, unknown>): string[] {
  const candidates: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && value.trim().length > 0) {
      candidates.push(value.trim());
    }
  };
  push(input.workspaceRoot);
  push(input.workspace_root);
  const workspaceRoots = input.workspace_roots;
  if (Array.isArray(workspaceRoots)) {
    for (const entry of workspaceRoots) push(entry);
  }
  push(input.cwd);
  return candidates;
}

/** Collapse join('C:', 'c:\\...') doubled drive prefix on Windows (#2787). */
function collapseDoubledWindowsDrivePrefix(path: string): string {
  return path.replace(/^([A-Za-z]:\\)(?=[A-Za-z]:\\)/i, "");
}

function msysPathToWin32(path: string): string | null {
  const match = /^\/([a-zA-Z])\/(.*)$/.exec(path.trim());
  if (match === null || match[1] === undefined || match[2] === undefined) return null;
  return `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, "\\")}`;
}

/** Normalize hook project-root resolution on Windows (doubled drive + MSYS `/c/...`). */
export function normalizeHookProjectRoot(path: string): string {
  if (process.platform !== "win32") return resolve(path);
  const trimmed = path.trim();
  const msys = msysPathToWin32(trimmed);
  let resolved = resolve(msys ?? trimmed);
  const collapsed = collapseDoubledWindowsDrivePrefix(resolved);
  if (collapsed !== resolved) {
    resolved = resolve(collapsed);
  }
  if (/^[a-z]:\\/.test(resolved)) {
    resolved = `${resolved.charAt(0).toUpperCase()}${resolved.slice(1)}`;
  }
  return resolved;
}

export function projectRootFromHookPayload(payload: unknown, fallback: string): string {
  const fallbackResolved = normalizeHookProjectRoot(fallback);
  const input = record(payload);
  if (input === null) return fallbackResolved;
  const usable = hookPayloadRootCandidates(input).find(
    (candidate) => !isWindowsDriveOnlyRoot(candidate),
  );
  if (usable !== undefined) {
    return normalizeHookProjectRoot(usable);
  }
  return fallbackResolved;
}

/** Interpolate both roots so a deny names the tree that was judged (#3794). */
export function formatHookRootNote(payloadRoot: string, effectiveRoot: string): string {
  return `payloadRoot=${payloadRoot} effectiveRoot=${effectiveRoot}`;
}

/** Why a mutation target was refused, so the deny message can be specific (#3794). */
export type EffectiveHookRootRefusal =
  /** Both common-dirs resolved and differ: a proven separate repository. */
  | "foreign-repository"
  /** `payloadRoot` is a repository but the target's identity could not be read. */
  | "unproven-identity"
  /** Members of one mutation resolved to two admitted worktrees. */
  | "worktree-span";

export interface EffectiveHookRootAdmission {
  readonly root: string;
  /** True when the target was refused and the dispatcher must deny (#3794). */
  readonly foreign: boolean;
  readonly candidate: string | null;
  readonly refusal: EffectiveHookRootRefusal | null;
}

function admitPayload(payload: string, candidate: string | null): EffectiveHookRootAdmission {
  return { root: payload, foreign: false, candidate, refusal: null };
}

/**
 * Admit the Git toplevel of the write target only when it shares
 * `--git-common-dir` with `payloadRoot`.
 *
 * Identity resolves to one of three outcomes, not two. A `payloadRoot` that is
 * not a Git repository never posed a containment question, so it keeps today's
 * payloadRoot gating. A `payloadRoot` that *is* a repository, paired with a
 * target that resolved to some other toplevel whose identity cannot be read, is
 * a question asked and left unanswered — that fails closed rather than
 * inheriting payloadRoot's occupancy and ritual state (#3794).
 */
export function admitEffectiveHookRoot(
  payloadRoot: string,
  writeTarget: string | null,
  runGit: GitRunner,
): EffectiveHookRootAdmission {
  const payload = normalizeHookProjectRoot(payloadRoot);
  if (writeTarget === null) return admitPayload(payload, null);
  const ancestor = existingAncestorDir(writeTarget);
  if (ancestor === null) return admitPayload(payload, null);
  const candidateRaw = worktreePathOrNull(ancestor, runGit);
  if (candidateRaw === null) return admitPayload(payload, null);
  const candidate = normalizeHookProjectRoot(candidateRaw);
  if (candidate === payload) return admitPayload(payload, candidate);
  const payloadCommon = gitCommonDir(payload, runGit);
  if (payloadCommon === null) {
    // No containment question exists: payloadRoot is not a repository, so there
    // is no boundary for the target to be inside or outside of. Denying here
    // would invent a class this defect never had.
    return admitPayload(payload, candidate);
  }
  const candidateCommon = gitCommonDir(candidate, runGit);
  if (candidateCommon === null) {
    return { root: payload, foreign: true, candidate, refusal: "unproven-identity" };
  }
  if (normalizeHookProjectRoot(payloadCommon) === normalizeHookProjectRoot(candidateCommon)) {
    return { root: candidate, foreign: false, candidate, refusal: null };
  }
  return { root: payload, foreign: true, candidate, refusal: "foreign-repository" };
}

/**
 * Admit every mutation target and require one effectiveRoot. A refused member
 * short-circuits; a span of two admitted worktrees is also refused so
 * occupancy/ritual cannot follow only the declared ApplyPatch path (#3794).
 */
export function admitMutationTargetSet(
  payloadRoot: string,
  targets: readonly string[],
  runGit: GitRunner,
): EffectiveHookRootAdmission {
  const payload = normalizeHookProjectRoot(payloadRoot);
  if (targets.length === 0) return admitPayload(payload, null);
  const admitted: EffectiveHookRootAdmission[] = [];
  for (const target of targets) {
    const next = admitEffectiveHookRoot(payload, target, runGit);
    if (next.foreign) return next;
    admitted.push(next);
  }
  const roots = [...new Set(admitted.map((item) => item.root))];
  if (roots.length > 1) {
    return {
      root: payload,
      foreign: true,
      candidate: roots.join(" | "),
      refusal: "worktree-span",
    };
  }
  return admitted[0] ?? admitPayload(payload, null);
}

export function isHookHost(value: string): value is HookHost {
  return (HOOK_HOSTS as readonly string[]).includes(value);
}

export function isHookEvent(value: string): value is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(value);
}

function scopeNotReadyCoverageHint(toolName: string): string {
  if (isSpawnTool(toolName)) return "";
  if (isShellTool(toolName)) {
    return (
      " This deny is the active-scope write gate on a recognized Shell dest-form " +
      "(git checkout --, git restore, rm/rmdir of in-repo paths)."
    );
  }
  return (
    " This gate covers direct-write tools (Edit/Write) and implementation spawn, " +
    "plus recognized Shell dest-forms (git checkout --, git restore, rm/rmdir). " +
    "Other shell (python -c, cmd /c copy, git status) is not this deny."
  );
}

function deny(
  input: HookDispatchInput,
  code: HookDecisionCode,
  toolName: string | null,
  message: string,
  scopePath: string | null = null,
): HookDecision {
  return {
    verdict: "deny",
    code,
    event: input.event,
    host: input.host,
    toolName,
    projectRoot: resolve(input.projectRoot),
    message,
    scopePath,
  };
}

interface MutationActorResolution {
  readonly sessionId: string | undefined;
  readonly issue: "unavailable" | "conflict" | null;
  readonly message: string | null;
  readonly payloadAuthoritative: boolean;
}

/**
 * Resolve the cooperative actor presented to the occupancy gate.
 * Supported payload hosts are payload-authoritative; ambient identity may only
 * corroborate. Grok retains the pre-#3611 environment path until its payload
 * contract is verified.
 */
function resolveMutationActor(
  input: HookDispatchInput,
  environ: NodeJS.ProcessEnv,
): MutationActorResolution {
  const hostIdentity = resolveHookHostIdentity(input.host, input.payload);
  const environmentId = environ.DEFT_SESSION_ID?.trim() || undefined;
  if (hostIdentity.status === "unsupported") {
    return {
      sessionId: environmentId,
      issue: null,
      message: null,
      payloadAuthoritative: false,
    };
  }
  if (hostIdentity.status === "ok" && hostIdentity.sessionId !== null) {
    if (environmentId !== undefined && environmentId !== hostIdentity.sessionId) {
      return {
        sessionId: hostIdentity.sessionId,
        issue: "conflict",
        message:
          `Host payload owner ${hostIdentity.sessionId} conflicts with ` +
          `DEFT_SESSION_ID ${environmentId}.`,
        payloadAuthoritative: true,
      };
    }
    return {
      sessionId: hostIdentity.sessionId,
      issue: null,
      message: null,
      payloadAuthoritative: true,
    };
  }
  return {
    sessionId: undefined,
    issue: hostIdentity.status === "conflict" ? "conflict" : "unavailable",
    message: hostIdentity.message,
    payloadAuthoritative: true,
  };
}

function runtimeAuthorityForDirectWrite(
  input: HookDispatchInput,
  toolName: string,
  seams: HookPolicySeams,
  scopePath: string | null,
): HookDecision | null {
  const projectRoot = resolve(input.projectRoot);
  // Project policy load failure: treat as disabled project layer, still apply
  // independent story file_scope when present (#516 / #2443 Greptile P1).
  let basePolicy: RuntimeAuthorityPolicy = DEFAULT_RUNTIME_AUTHORITY_POLICY;
  try {
    basePolicy = (seams.loadRuntimeAuthority ?? loadRuntimeAuthorityFromProject)(projectRoot);
  } catch {
    basePolicy = DEFAULT_RUNTIME_AUTHORITY_POLICY;
  }
  // Wave 3 unified write fence: intersect project runtimeAuthority with active
  // story file_scope (#516 / #2443 / #2948). Single evaluation SoT via
  // evaluateRuntimeAuthorityDirectWrite — no parallel writeScope engine.
  let storyFence: { fileScope: readonly string[]; denyPaths: readonly string[] };
  try {
    storyFence = seams.loadStoryWriteFence
      ? seams.loadStoryWriteFence(projectRoot, scopePath)
      : loadStoryWriteFenceFromPath(scopePath);
  } catch {
    // Residual: host cannot load active story — project fence still applies.
    storyFence = { fileScope: [], denyPaths: [] };
  }
  const fence = resolveWriteFence(basePolicy, storyFence.fileScope, {
    storyDenyPaths: storyFence.denyPaths,
  });
  // Neither layer active → allow (same as disabled runtimeAuthority historically).
  if (!fence.fenceActive) return null;
  const writeTarget = hookWriteTargetPath(input.payload);
  const relPath = writeTarget !== null ? toProjectRelativePosix(projectRoot, writeTarget) : null;
  const verdict = evaluateRuntimeAuthorityDirectWrite({
    policy: fence.policy,
    relPathPosix: relPath,
  });
  if (verdict.allowed) return null;
  return deny(
    input,
    verdict.code ?? "runtime-policy-deny-path",
    toolName,
    verdict.reason ?? "Directive denied this direct write under write fence policy.",
    scopePath,
  );
}

function loadAuthzContext(
  projectRoot: string,
  seams: HookPolicySeams,
): {
  state: AuthzState;
  grants: readonly HumanOriginGrant[];
  corrupt: boolean;
  corruptReason: string | null;
} {
  if (seams.loadAuthzState !== undefined) {
    const state = seams.loadAuthzState(projectRoot);
    const raw = (seams.loadAuthzGrants ?? listActiveHumanGrants)(projectRoot, state);
    // Production filter: self-authored grants never enter the implement gate (#2944).
    const grants = raw.filter((g) => evidenceSatisfiesImplementationApproval({ grant: g }));
    return { state, grants, corrupt: false, corruptReason: null };
  }
  const loaded = loadAuthzStateResult(projectRoot);
  const raw = (seams.loadAuthzGrants ?? listActiveHumanGrants)(projectRoot, loaded.state);
  const grants = raw.filter((g) => evidenceSatisfiesImplementationApproval({ grant: g }));
  return {
    state: loaded.state,
    grants,
    corrupt: loaded.corrupt,
    corruptReason: loaded.ok ? null : loaded.reason,
  };
}

function authzCodeToHook(code: AuthzDecision["code"]): HookDecisionCode {
  // Map authz decision codes onto HookDecisionCode (same string values for denials).
  if (
    code === "authz-uat-deny" ||
    code === "authz-grant-missing" ||
    code === "authz-grant-origin-reject" ||
    code === "authz-grant-scope-deny" ||
    code === "authz-grant-expired" ||
    code === "authz-grant-revoked" ||
    code === "authz-grant-single-use-spent"
  ) {
    return code;
  }
  return "authz-uat-deny";
}

function recordAuthzAudit(
  projectRoot: string,
  decision: AuthzDecision,
  state: AuthzState,
  seams: HookPolicySeams,
): void {
  if (seams.authzAudit === false) return;
  // Only audit when UAT is active or a deny occurred under an authz code.
  const uatActive = state.uat?.active === true;
  if (!uatActive && decision.allowed) return;
  try {
    appendAuthzAudit(projectRoot, {
      schemaVersion: 1,
      ts: utcIso(),
      humanApprovalRef: decision.humanApprovalRef,
      approvedScope: decision.approvedScope,
      attemptedOp: String(decision.attemptedOp),
      path: decision.path,
      result: decision.allowed ? "allow" : "deny",
      code: decision.code,
      message: decision.reason,
      campaignId: state.uat?.campaignId ?? null,
    });
  } catch {
    // Audit write must not crash the host tool gate.
  }
}

/**
 * UAT lease + human-origin grant gate (#2944). Returns deny decision or null when allowed.
 * Composes before runtimeAuthority path/scope checks for direct writes and shell/MCP.
 */
function authzForMutation(
  input: HookDispatchInput,
  toolName: string,
  seams: HookPolicySeams,
  options: {
    isDirectWrite: boolean;
    relPath: string | null;
    scopePath: string | null;
    runGit?: GitRunner;
  },
): HookDecision | null {
  // #3794: grant scoping and the authz audit trail stay on payloadRoot.
  // Re-pointing would break exact-string UAT grants and shard the audit file.
  const projectRoot = resolve(input.projectRoot);
  let state: AuthzState;
  let grants: readonly HumanOriginGrant[];
  let corrupt: boolean;
  let corruptReason: string | null;
  try {
    ({ state, grants, corrupt, corruptReason } = loadAuthzContext(projectRoot, seams));
  } catch (err) {
    // Fail closed: unreadable authz store must not disable UAT enforcement (#2944).
    return deny(
      input,
      "authz-uat-deny",
      toolName,
      `Directive denied this mutation: authz store unreadable (${String(err)}). ` +
        "Human action required: repair `.deft/authz/state.json` or re-run `deft authz:uat-start`.",
      options.scopePath,
    );
  }

  const shellCommand = isShellTool(toolName) ? hookShellCommand(input.payload) : null;
  const ops = classifyHookAuthzOps({
    toolName,
    shellCommand,
    isDirectWrite: options.isDirectWrite,
    mcpArgsText: options.isDirectWrite ? null : hookMcpArgsText(input.payload),
  });

  // No classifiable authz ops (unrelated tools) — leave to other gates,
  // except corrupt state still fails closed on direct writes / classifiable shell.
  if (ops.length === 0) {
    if (corrupt && (options.isDirectWrite || isShellTool(toolName))) {
      return deny(
        input,
        "authz-uat-deny",
        toolName,
        `Directive denied this mutation: ${corruptReason ?? "authz state corrupt"}. ` +
          "Fail closed while UAT authority cannot be verified. " +
          "Human action required: repair `.deft/authz/state.json`.",
        options.scopePath,
      );
    }
    return null;
  }

  // Structural context for bound grants (branch from git; repo optional env).
  let branch: string | null = null;
  try {
    branch = detectBranch(projectRoot, options.runGit);
  } catch {
    branch = null;
  }
  const repo = (process.env.DEFT_AUTHZ_REPO ?? process.env.GITHUB_REPOSITORY ?? "").trim() || null;

  // Evaluate each op; first deny wins (compound shell must not short-circuit).
  for (const op of ops) {
    const decision = evaluateAuthzMutation({
      state,
      grants,
      op,
      path: options.relPath,
      branch,
      repo,
      worktree: projectRoot,
    });
    recordAuthzAudit(projectRoot, decision, state, seams);
    if (!decision.allowed) {
      return deny(
        input,
        authzCodeToHook(decision.code),
        toolName,
        decision.reason,
        options.scopePath,
      );
    }
    // Consume single-use grants after allow (persist usedAt).
    if (shouldConsumeSingleUseGrant(decision) && decision.humanApprovalRef !== null) {
      try {
        markGrantUsed(projectRoot, decision.humanApprovalRef);
      } catch {
        // Persistence failure must not flip allow → deny after a successful check;
        // next load will still see unused if write failed (prefer allow-once risk over deadlock).
      }
    }
  }
  return null;
}

function loadRuntimeAuthorityPolicySafe(
  input: HookDispatchInput,
  seams: HookPolicySeams,
): RuntimeAuthorityPolicy | null {
  const projectRoot = resolve(input.projectRoot);
  try {
    return (seams.loadRuntimeAuthority ?? loadRuntimeAuthorityFromProject)(projectRoot);
  } catch {
    return null;
  }
}

/**
 * Evaluate scopes.push / scopes.merge for Shell/Bash or classifiable MCP tools (#2711).
 * Returns a full HookDecision (allow or deny). Unclassifiable ops fail open.
 */
function decideShellOrMcpRuntimeAuthority(
  input: HookDispatchInput,
  toolName: string,
  seams: HookPolicySeams,
): HookDecision {
  const projectRoot = resolve(input.projectRoot);

  // Wave 1 authz first: UAT lease denies push/PR/merge/settings/deploy without cohort (#2944).
  // Composes with #2711 shell matchers; does not re-implement them.
  const authzDeny = authzForMutation(input, toolName, seams, {
    isDirectWrite: false,
    relPath: null,
    scopePath: null,
  });
  if (authzDeny !== null) return authzDeny;

  // #1193 intent ceiling: non-implement slash verbs cannot authorize push/merge (and deploy via merge).
  const env = input.environ ?? process.env;
  const shellOpsPreview: RuntimeAuthorityShellOp[] = [];
  if (isShellTool(toolName)) {
    const command = hookShellCommand(input.payload);
    if (command !== null) shellOpsPreview.push(...listShellOps(command));
  } else {
    const mcpOp = classifyMcpTool(toolName, hookMcpArgsText(input.payload));
    if (mcpOp !== null) shellOpsPreview.push(mcpOp);
  }
  for (const shellOp of shellOpsPreview) {
    const intentOp: IntentCeilingOp = shellOp === "push" ? "push" : "merge";
    const intent = evaluateIntentCeilingFromEnv(intentOp, env);
    if (!intent.allowed) {
      return deny(input, "intent-ceiling-deny", toolName, intent.reason);
    }
  }

  const policy = loadRuntimeAuthorityPolicySafe(input, seams);
  if (policy === null) {
    return {
      verdict: "allow",
      code: "shell-op-unclassifiable",
      event: input.event,
      host: input.host,
      toolName,
      projectRoot,
      message: `Directive allowed ${toolName}: runtimeAuthority policy load failed (fail open).`,
      scopePath: null,
    };
  }

  // Shell: evaluate every classifiable op in compound/multi-line commands (#2711 Greptile).
  // MCP / bare push-merge names: single tool name maps to at most one op
  // (includes bare `merge_pull_request` etc. that isMcpTool does not flag).
  const ops: RuntimeAuthorityShellOp[] = [];
  if (isShellTool(toolName)) {
    const command = hookShellCommand(input.payload);
    if (command !== null) ops.push(...listShellOps(command));
  } else {
    const mcpOp = classifyMcpTool(toolName, hookMcpArgsText(input.payload));
    if (mcpOp !== null) ops.push(mcpOp);
  }

  if (ops.length === 0) {
    return {
      verdict: "allow",
      code: "shell-op-unclassifiable",
      event: input.event,
      host: input.host,
      toolName,
      projectRoot,
      message:
        `${toolName} is classifiable as Shell/MCP but the command/tool was not recognized as ` +
        "push or merge — fail open (host gap; see runtime-authority.md).",
      scopePath: null,
    };
  }

  // Deny if any classifiable op is out of scope (compound commands must not short-circuit).
  for (const op of ops) {
    const verdict = evaluateRuntimeAuthorityShellOp({ policy, op });
    if (!verdict.allowed) {
      return deny(
        input,
        verdict.code ?? "runtime-policy-deny-scope",
        toolName,
        verdict.reason ??
          "Directive denied this shell/MCP operation under runtime authority policy.",
      );
    }
  }

  const opsLabel = ops.join("+");
  return {
    verdict: "allow",
    code: "shell-op-ready",
    event: input.event,
    host: input.host,
    toolName,
    projectRoot,
    message: `Directive runtimeAuthority allowed classifiable ${opsLabel} via ${toolName}.`,
    scopePath: null,
  };
}

function inspectMutationGates(
  input: HookDispatchInput,
  toolName: string,
  seams: HookPolicySeams,
  options: { proposedLifecycleExempt: boolean },
): HookDecision {
  // payloadRoot stays authoritative for authz, audit trail, kill-switch,
  // #2885 outside-root, file_scope (commit 2), and deny().projectRoot.
  const payloadRoot = resolve(input.projectRoot);
  const projectRoot = payloadRoot;
  const environ = input.environ ?? process.env;
  const dispatchGit = memoizeGitRunner(seams.ritualRunGit ?? defaultGitRunner);
  const mutationTargets = isSpawnTool(toolName) ? [] : hookMutationTargetPaths(input.payload);
  const admission: EffectiveHookRootAdmission = isSpawnTool(toolName)
    ? { root: payloadRoot, foreign: false, candidate: null, refusal: null }
    : admitMutationTargetSet(payloadRoot, mutationTargets, dispatchGit);
  const effectiveRoot = admission.root;
  const rootsNote = ` ${formatHookRootNote(payloadRoot, effectiveRoot)}`;
  if (admission.foreign) {
    const candidate = admission.candidate ?? "<none>";
    const reason =
      admission.refusal === "worktree-span"
        ? `write targets span more than one Git worktree (candidate=${candidate}).`
        : admission.refusal === "unproven-identity"
          ? `write target resolved to a separate Git working tree whose repository ` +
            `identity could not be read, so containment is unproven (candidate=${candidate}).`
          : `write target is in a different Git repository ` +
            `than the hook payload root (candidate=${candidate}).`;
    return deny(
      input,
      "foreign-repository-deny",
      toolName,
      `Directive denied ${toolName}: ${reason}${rootsNote}`,
    );
  }

  // Assist/scratch low-ceremony writes (#1802): allowlisted gitignored roots under
  // assist/ephemeral classification skip ritual + active-scope (no fake scope:activate).
  // Tracked product paths never match the path fence. Read-only still denied upstream.
  if (!isSpawnTool(toolName)) {
    const scratchTarget = hookWriteTargetPath(input.payload);
    if (isAssistScratchWrite(projectRoot, scratchTarget, input.payload, environ)) {
      const relPath =
        scratchTarget !== null ? toProjectRelativePosix(projectRoot, scratchTarget) : null;
      const authzDeny = authzForMutation(input, toolName, seams, {
        isDirectWrite: true,
        relPath,
        scopePath: null,
        runGit: dispatchGit,
      });
      if (authzDeny !== null) return authzDeny;
      const runtimeDeny = runtimeAuthorityForDirectWrite(input, toolName, seams, null);
      if (runtimeDeny !== null) return runtimeDeny;
      return {
        verdict: "allow",
        code: "write-assist-scratch-ready",
        event: input.event,
        host: input.host,
        toolName,
        projectRoot,
        message:
          `Directive write gate allowed ${toolName} under allowlisted assist scratch ` +
          "root (disposable notes; active scope and story-start not required). " +
          "Tracked product paths still require mutation gates — do not smuggle source " +
          "under .deft-scratch/ or temp/.",
        scopePath: null,
      };
    }
  }

  let ritual: VerifyResult;
  try {
    // Mutation dispatch is a live gated boundary: active verification reruns
    // non-cacheable agent-hook readiness instead of trusting persisted success.
    // Write-surface authority executes agent_hooks only (#3738). cache_fresh
    // is not required and is never executed. doctor is read from the record.
    // Its allow fixture is non-write and its deny fixture is read-only, so the
    // installed-shim probe cannot recurse into this mutation path.
    ritual = (
      seams.verifyRitual ??
      seams.inspectRitual ??
      ((root) =>
        verifySessionRitual(
          root,
          writeGateRitualOptions({
            bypass: false,
            runner: seams.ritualRunner,
            detectWorkSelection: seams.detectWorkSelection,
            runGit: dispatchGit,
          }),
        ))
    )(effectiveRoot);
  } catch (cause) {
    // #2994: best-effort local process-cost; never changes deny verdict.
    emitSessionRitualBlockedProcessCost(
      {
        toolName,
        code: "ritual-not-ready",
        recoveryTier: "cold",
        detail: `inspect threw: ${String(cause)}`,
      },
      { projectRoot },
    );
    return deny(
      input,
      "ritual-not-ready",
      toolName,
      `Directive could not inspect the gated session ritual: ${String(cause)}. ` +
        formatRitualRecoveryInstruction("cold") +
        rootsNote,
    );
  }
  const actor = isSpawnTool(toolName) ? null : resolveMutationActor(input, environ);
  const occupancyGate = isSpawnTool(toolName)
    ? { allow: true, message: null as string | null, occupant: null }
    : evaluateOccupancyWriteGate(effectiveRoot, {
        sessionId: actor?.sessionId,
        // Payload-supported hosts must not fall back to a stale ambient owner.
        env: actor?.payloadAuthoritative === true ? {} : environ,
      });
  if (occupancyGate.occupant !== null && actor?.issue !== null && actor !== null) {
    const code: HookDecisionCode =
      actor.issue === "conflict" ? "occupancy-identity-conflict" : "occupancy-identity-unavailable";
    const detail =
      actor.message ??
      "The host did not supply a usable cooperative session/conversation identity.";
    emitSessionRitualBlockedProcessCost(
      {
        toolName,
        code,
        recoveryTier: ritual.recoveryTier === "rearm" ? "rearm" : "cold",
        detail,
      },
      { projectRoot },
    );
    return deny(
      input,
      code,
      toolName,
      `Directive denied ${toolName}: ${detail} A live occupancy lease exists for ` +
        `session ${occupancyGate.occupant.sessionId}; use an exact host-mediated lifecycle ` +
        "command or pass the matching --session-id explicitly." +
        rootsNote,
    );
  }
  if (!occupancyGate.allow && occupancyGate.message !== null) {
    const ritualNote = ritual.code !== 0 ? ` Also ritual-not-ready: ${ritual.message}` : "";
    emitSessionRitualBlockedProcessCost(
      {
        toolName,
        code: "occupancy-occupied",
        recoveryTier: ritual.recoveryTier === "rearm" ? "rearm" : "cold",
        detail: occupancyGate.message,
      },
      { projectRoot },
    );
    return deny(
      input,
      "occupancy-occupied",
      toolName,
      `Directive denied ${toolName}: ${occupancyGate.message}${ritualNote}${rootsNote}`,
    );
  }
  if (occupancyGate.occupant !== null && actor !== null) {
    const expectedOwner = actor.sessionId;
    const verifiedOwner = ritual.boundSessionId;
    const ritualOwnerMismatch =
      expectedOwner !== undefined &&
      (verifiedOwner !== undefined ? verifiedOwner !== expectedOwner : ritual.code === 0);
    if (ritualOwnerMismatch) {
      const detail =
        verifiedOwner === undefined
          ? "gated ritual verification returned ready without an exact bound owner"
          : `exact verified ritual owner ${verifiedOwner} differs from host/lease owner ${expectedOwner}`;
      emitSessionRitualBlockedProcessCost(
        {
          toolName,
          code: "occupancy-ritual-mismatch",
          recoveryTier: ritual.recoveryTier === "rearm" ? "rearm" : "cold",
          detail,
        },
        { projectRoot },
      );
      return deny(
        input,
        "occupancy-ritual-mismatch",
        toolName,
        `Directive denied ${toolName}: ${detail}. ` +
          "Run `deft session:start --rearm --session-id=<same-session-id>` when re-arm is eligible; " +
          "otherwise run `deft session:start --session-id=<same-session-id>` for a cold ceremony. " +
          "Intermediate lease/ritual mismatches fail closed." +
          rootsNote,
      );
    }
  }
  if (ritual.code !== 0) {
    // #2992: prefer re-arm recovery when age/compact stale; cold when bind invalid.
    const recoveryTier = ritual.recoveryTier === "rearm" ? "rearm" : "cold";
    // #2994: best-effort local process-cost; never changes deny verdict.
    emitSessionRitualBlockedProcessCost(
      {
        toolName,
        code: "ritual-not-ready",
        recoveryTier,
        detail: ritual.message,
      },
      { projectRoot },
    );
    return deny(
      input,
      "ritual-not-ready",
      toolName,
      `Directive denied ${toolName}: ${ritual.message} ${formatRitualRecoveryInstruction(recoveryTier)}` +
        rootsNote,
    );
  }

  // Narrow the cooperative file-gate race: authorization/scope checks can
  // take long enough for another session to transition the lease. Re-read
  // only occupancy immediately before each direct-write allow, while retaining
  // the exact ritual owner above (never adopt a later ritual file here).
  // #3599: the owner's lease is only kept alive here, on the last evaluation
  // before an allowed write, so the stamp records a write that really happened.
  let occupancyWarning: string | null = null;
  const recheckOccupancyBeforeWriteAllow = (): HookDecision | null => {
    if (actor === null) return null;
    const finalOccupancy = evaluateOccupancyWriteGate(effectiveRoot, {
      sessionId: actor.sessionId,
      env: actor.payloadAuthoritative ? {} : environ,
      refresh: true,
    });
    occupancyWarning = finalOccupancy.warning;
    if (finalOccupancy.occupant !== null && actor.issue !== null) {
      return deny(
        input,
        actor.issue === "conflict"
          ? "occupancy-identity-conflict"
          : "occupancy-identity-unavailable",
        toolName,
        `Directive denied ${toolName}: the live occupancy owner changed while mutation ` +
          "gates were running, and this hook has no unambiguous matching actor identity." +
          rootsNote,
      );
    }
    if (!finalOccupancy.allow && finalOccupancy.message !== null) {
      return deny(
        input,
        "occupancy-occupied",
        toolName,
        `Directive denied ${toolName}: occupancy changed while mutation gates were running. ` +
          finalOccupancy.message +
          rootsNote,
      );
    }
    if (
      finalOccupancy.occupant !== null &&
      actor.sessionId !== undefined &&
      ritual.boundSessionId !== actor.sessionId
    ) {
      return deny(
        input,
        "occupancy-ritual-mismatch",
        toolName,
        `Directive denied ${toolName}: final lease owner ${actor.sessionId} does not match ` +
          `the exact verified ritual owner ${ritual.boundSessionId ?? "<unbound>"}. ` +
          "Run `deft session:start --rearm --session-id=<same-session-id>` when re-arm is eligible; " +
          "otherwise run `deft session:start --session-id=<same-session-id>` for a cold ceremony." +
          rootsNote,
      );
    }
    return null;
  };
  const withOccupancyWarning = (message: string): string =>
    occupancyWarning === null ? message : `${message} ${occupancyWarning}`;

  if (options.proposedLifecycleExempt) {
    const writeTarget = hookWriteTargetPath(input.payload);
    if (isProposedLifecycleWrite(projectRoot, writeTarget)) {
      const relPath =
        writeTarget !== null ? toProjectRelativePosix(projectRoot, writeTarget) : null;
      // UAT still allows xbrief/proposed/** as evidence/defect capture (#2944).
      const authzDeny = authzForMutation(input, toolName, seams, {
        isDirectWrite: true,
        relPath,
        scopePath: null,
        runGit: dispatchGit,
      });
      if (authzDeny !== null) return authzDeny;
      const runtimeDeny = runtimeAuthorityForDirectWrite(input, toolName, seams, null);
      if (runtimeDeny !== null) return runtimeDeny;
      const occupancyDeny = recheckOccupancyBeforeWriteAllow();
      if (occupancyDeny !== null) return occupancyDeny;
      return {
        verdict: "allow",
        code: "write-propose-ready",
        event: input.event,
        host: input.host,
        toolName,
        projectRoot,
        message: withOccupancyWarning(
          `Directive write gate allowed ${toolName} for a proposed lifecycle xBRIEF ` +
            "(planning write; active scope not required).",
        ),
        scopePath: null,
      };
    }
  }

  let scope: ActiveScopeInspection;
  try {
    scope = (seams.inspectScope ?? inspectActiveScope)(projectRoot);
  } catch (cause) {
    scope = { ready: false, path: null, message: String(cause) };
  }
  if (!scope.ready) {
    const writeTarget = hookWriteTargetPath(input.payload);
    const relTarget =
      writeTarget !== null ? toProjectRelativePosix(projectRoot, writeTarget) : null;
    // Active-scope governs in-repo lifecycle work only. Outside-root Write/Edit
    // (agent memory, $TMPDIR, user config) skips the deny; null/unparseable
    // targets stay fail-closed. Spawn has no write target → still requires scope (#2885).
    // Lexical ../ + realpath re-entry guard (not bare startsWith(".."); not symlink aliases).
    const outsideRoot = writeTarget !== null && isOutsideProjectRootWrite(projectRoot, writeTarget);
    if (!outsideRoot || isSpawnTool(toolName)) {
      let proposedPathHint: string;
      if (isSpawnTool(toolName)) {
        // Multi-path recovery for implement-class spawns (#3080 AC4 / #3259 honesty).
        // Structural markers only — free-text prompt brackets are not sufficient.
        proposedPathHint =
          " Recovery: (1) Product implementation — run `deft scope:activate -- <path>` " +
          "for the approved xBRIEF, then re-run the pre-start_agent gate stack. " +
          "(2) Read-only research — spawn with structural `subagent_type`/`worker_role` explore. " +
          "(3) Ephemeral docs/local-dev — set structural tool fields " +
          "`worker_role`/`subagent_type` ∈ {ephemeral, docs, assist} (hosts that support them), " +
          "or set session assist (`DEFT_SESSION_POSTURE=assist` or `DEFT_HOOK_ASSIST=1`), " +
          "or run local-dev Shell (`docker compose` / `pnpm dev`) in the parent without a " +
          "lifecycle story. Free-text markers such as `[worker_role: ephemeral]` in the " +
          "prompt are NOT sufficient. Do not invent a fake scope only to satisfy this gate.";
      } else if (
        options.proposedLifecycleExempt &&
        relTarget !== null &&
        (relTarget.startsWith("xbrief/proposed/") || relTarget.startsWith("vbrief/proposed/"))
      ) {
        proposedPathHint =
          " For a new proposal under xbrief/proposed/, include a lifecycle artifact " +
          "filename (*.xbrief.json) in the Write/Edit payload so the gate can exempt " +
          "planning writes (#2625).";
      } else {
        proposedPathHint =
          " Recovery: run `deft scope:activate -- <path>` for the approved xBRIEF, " +
          (options.proposedLifecycleExempt
            ? "or Write a new proposal to xbrief/proposed/*.xbrief.json (planning exemption), " +
              "or for disposable research notes write under `.deft-scratch/` (or `temp/`) " +
              "with assist/ephemeral posture (`DEFT_SESSION_POSTURE=assist` or " +
              "`worker_role: assist` / ephemeral — see commands.md #1802 / #3080). " +
              "Do not invent a fake scope only to capture Obsidian/scratch notes."
            : "then re-run the pre-start_agent gate stack. " +
              "For disposable research notes only: write under `.deft-scratch/` with " +
              "assist posture (commands.md #1802) — do not fake `scope:activate` for notes.");
      }
      const denyCode = isSpawnTool(toolName) ? "spawn-not-ready" : "scope-not-ready";
      return deny(
        input,
        denyCode,
        toolName,
        `Directive denied ${toolName}: ${scope.message}${proposedPathHint}` +
          scopeNotReadyCoverageHint(toolName),
      );
    }
  }

  const allowCode = isSpawnTool(toolName) ? "spawn-ready" : "write-ready";
  // #1193: non-implement slash verbs must not authorize implement/spawn tooling.
  {
    const intent = evaluateIntentCeilingFromEnv("implement", input.environ ?? process.env);
    if (!intent.allowed) {
      return deny(input, "intent-ceiling-deny", toolName, intent.reason);
    }
  }
  if (!isSpawnTool(toolName)) {
    const writeTarget = hookWriteTargetPath(input.payload);
    const relPath = writeTarget !== null ? toProjectRelativePosix(projectRoot, writeTarget) : null;
    // Wave 1 authz (UAT lease + human-origin grant) before runtimeAuthority (#2944 / #2948 L1–L2).
    const authzDeny = authzForMutation(input, toolName, seams, {
      isDirectWrite: true,
      relPath,
      scopePath: scope.path,
      runGit: dispatchGit,
    });
    if (authzDeny !== null) return authzDeny;
    const runtimeDeny = runtimeAuthorityForDirectWrite(input, toolName, seams, scope.path);
    if (runtimeDeny !== null) return runtimeDeny;
    const occupancyDeny = recheckOccupancyBeforeWriteAllow();
    if (occupancyDeny !== null) return occupancyDeny;
  }
  return {
    verdict: "allow",
    code: allowCode,
    event: input.event,
    host: input.host,
    toolName,
    projectRoot,
    message: withOccupancyWarning(
      `Directive ${isSpawnTool(toolName) ? "spawn" : "write"} gate passed for ${toolName}.`,
    ),
    scopePath: scope.path,
  };
}

/**
 * Route recognized Shell dest-forms through inspectMutationGates, then push/merge.
 * Dest-form allow is kept when runtime authority has nothing classifiable.
 */
function decideShellDestFormsThenRuntimeAuthority(
  input: HookDispatchInput,
  toolName: string,
  seams: HookPolicySeams,
): HookDecision {
  const command = hookShellCommand(input.payload);
  let destAllow: HookDecision | null = null;
  let expansionDeny: HookDecision | null = null;
  // #3438 / #3594: opt-in. `off` (the default) leaves Shell exactly as it was
  // before this gate existed — unrecognized and fail-open — so landing the
  // classifier cannot deny anything a consumer runs today. `enforce` turns on
  // BOTH halves together: resolved dests through inspectMutationGates and
  // fail-closed for targets that cannot be proved. ⊗ Do not split those two:
  // enforcing only resolved dests would allow `cd x && rm y` while denying
  // `rm x/y`, and enforcing only fail-closed would deny the compound while
  // letting the in-scope simple form through unchecked.
  // An unreadable policy resolves to `off`, which is the no-new-denials
  // direction and matches the opt-in default rather than failing closed.
  const destFormsEnforced =
    loadRuntimeAuthorityPolicySafe(input, seams)?.shellDestForms === "enforce";
  if (command !== null && destFormsEnforced) {
    for (const dest of classifyProductDestForms(command)) {
      if (dest.expansion === true) {
        expansionDeny = deny(
          input,
          "scope-not-ready",
          toolName,
          `Directive denied ${toolName}: Shell dest-form target is not reconstructable ` +
            "(compound command, glob/variable, leading ~, or a git context option). Name a " +
            "concrete path in ONE simple command — split `cd x && rm y` into a single " +
            "`rm x/y`, or one tool call per command — or use Edit/Write. Only a single simple " +
            "command with an absolute dest is checked soundly; a relative dest assumes the " +
            "shell is at the project root. Everything else stays fail-closed (#3438).",
        );
        continue;
      }
      const destInput: HookDispatchInput = {
        ...input,
        payload: payloadWithInjectedWriteTarget(input.payload, dest.path),
      };
      const destDecision = inspectMutationGates(destInput, toolName, seams, {
        proposedLifecycleExempt: true,
      });
      if (destDecision.verdict === "deny") return destDecision;
      destAllow = destDecision;
    }
  }
  const runtime = decideShellOrMcpRuntimeAuthority(input, toolName, seams);
  if (runtime.verdict === "deny") return runtime;
  if (expansionDeny !== null) return expansionDeny;
  if (destAllow !== null && runtime.code === "shell-op-unclassifiable") {
    return destAllow;
  }
  return runtime;
}

const LIFECYCLE_EXECUTION_DIRECTORY_FIELDS = [
  "cwd",
  "workdir",
  "working_directory",
  "workingDirectory",
] as const;

function sameExecutionDirectory(left: string, right: string): boolean {
  if (process.platform === "win32") return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

function lifecycleExecutionRootCheck(
  payload: unknown,
  projectRoot: string,
  realpath: (path: string) => string,
  platform: NodeJS.Platform,
): { readonly aligned: boolean; readonly message: string } {
  const input = record(payload);
  if (input === null) {
    return { aligned: false, message: "the hook payload has no inspectable execution root" };
  }
  const expected = normalizeHookProjectRoot(projectRoot);
  const toolInput = toolInputRecord(input);
  const records = toolInput === null || toolInput === input ? [input] : [input, toolInput];
  for (const source of records) {
    for (const field of LIFECYCLE_EXECUTION_DIRECTORY_FIELDS) {
      if (!(field in source)) continue;
      const raw = source[field];
      if (typeof raw !== "string" || raw.trim().length === 0) {
        return {
          aligned: false,
          message: `execution-directory field ${field} is missing or invalid`,
        };
      }
      const trimmed = raw.trim();
      // Cursor can report a drive-only cwd (for example `C:`) while the
      // explicit/workspace-derived project root remains usable (#2787). Keep
      // this fence aligned with projectRootFromHookPayload: a drive-only value
      // is not a concrete execution directory and must not override that root.
      if (isWindowsDriveOnlyRoot(trimmed, platform)) continue;
      if (trimmed.replace(/\\/g, "/").split("/").includes("..")) {
        return {
          aligned: false,
          message: `execution-directory field ${field} contains parent traversal`,
        };
      }
      const candidate = isAbsolute(trimmed) ? trimmed : `${expected}${sep}${trimmed}`;
      let actual: string;
      let expectedReal: string;
      try {
        // Keep relative `..` segments intact until realpath resolution. Lexical
        // path.resolve would collapse `link/..` before observing that `link`
        // can be a symlink to a foreign tree.
        expectedReal = normalizeHookProjectRoot(realpath(expected));
        actual = normalizeHookProjectRoot(realpath(candidate));
      } catch (cause) {
        return {
          aligned: false,
          message: `execution-directory field ${field} could not be realpath-bound: ${String(cause)}`,
        };
      }
      if (!sameExecutionDirectory(actual, expectedReal)) {
        return {
          aligned: false,
          message:
            `execution-directory field ${field} resolves to ${actual}, not the hook project ` +
            `root ${expectedReal}`,
        };
      }
    }
  }
  return { aligned: true, message: "execution directory is project-root aligned" };
}

/**
 * Add the claim-time owner only after the existing shell decision allowed the
 * command. The host wire format must emit `allow` with updated input, so this
 * path is intentionally restricted by rewriteExactLifecycleCommand.
 */
function attachLifecycleIdentityRewrite(
  input: HookDispatchInput,
  toolName: string,
  decision: HookDecision,
  seams: HookPolicySeams,
): HookDecision {
  if (decision.verdict !== "allow") return decision;
  const lifecycle = inspectExactLifecycleCommand(input.payload);
  if (lifecycle === null) return decision;
  if (!lifecycle.requiresOwner) return decision;
  if (lifecycle.sessionIdStatus === "invalid") {
    return deny(
      input,
      "occupancy-identity-conflict",
      toolName,
      `Directive denied exact lifecycle command ${lifecycle.verb}: ` +
        "--session-id is empty, duplicated, or otherwise ambiguous.",
    );
  }
  const identity = resolveHookHostIdentity(input.host, input.payload);
  if (identity.status === "unsupported") return decision;
  if (identity.status !== "ok" || identity.sessionId === null) {
    const code: HookDecisionCode =
      identity.status === "conflict"
        ? "occupancy-identity-conflict"
        : "occupancy-identity-unavailable";
    return deny(
      input,
      code,
      toolName,
      `Directive denied exact lifecycle command ${lifecycle.verb}: ` +
        `${identity.message ?? "host payload identity is unavailable"}. ` +
        "Directive cannot bind the occupancy claim without a stable host owner; " +
        "manual callers must pass --session-id explicitly outside the host rewrite path.",
    );
  }
  const environmentId = (input.environ ?? process.env).DEFT_SESSION_ID?.trim();
  if (
    environmentId !== undefined &&
    environmentId.length > 0 &&
    environmentId !== identity.sessionId
  ) {
    return deny(
      input,
      "occupancy-identity-conflict",
      toolName,
      `Directive denied ${toolName}: host payload owner ${identity.sessionId} conflicts with ` +
        `DEFT_SESSION_ID ${environmentId}; refusing an auto-approved lifecycle rewrite.`,
    );
  }
  if (lifecycle.sessionIdStatus === "present" && lifecycle.sessionId !== identity.sessionId) {
    return deny(
      input,
      "occupancy-identity-conflict",
      toolName,
      `Directive denied ${toolName}: lifecycle command ${lifecycle.verb} names ` +
        `${lifecycle.sessionId ?? "<missing>"}, but the host payload owner is ` +
        `${identity.sessionId}.`,
    );
  }
  const sourceTask =
    !lifecycle.task ||
    (seams.runningInsideDeftRepo ?? runningInsideDeftRepo)(resolve(input.projectRoot));
  const executionRoot = lifecycleExecutionRootCheck(
    input.payload,
    input.projectRoot,
    seams.realpathLifecycleExecutionRoot ?? realpathSync,
    seams.lifecycleExecutionPlatform ?? process.platform,
  );
  if (!executionRoot.aligned) {
    return deny(
      input,
      "occupancy-identity-conflict",
      toolName,
      `Directive denied exact lifecycle command ${lifecycle.verb}: ${executionRoot.message}. ` +
        "Run the lifecycle command from the hook project root so policy, lease, and ritual " +
        "state target the same worktree.",
    );
  }
  const rewriteAllowed = lifecycle.rewriteSafe && sourceTask;
  if (lifecycle.sessionIdStatus === "absent" && !rewriteAllowed) {
    let reason: string;
    if (lifecycle.task && !sourceTask) {
      reason = "Task lifecycle rewrites are only trusted in the Directive source repository";
    } else {
      reason = "this argument shape is outside the narrowly auto-approved rewrite surface";
    }
    return deny(
      input,
      "occupancy-identity-unavailable",
      toolName,
      `Directive denied exact lifecycle command ${lifecycle.verb}: ${reason}. ` +
        `Re-run the command with --session-id=${identity.sessionId}; Directive will verify ` +
        "that explicit owner without auto-approving or replacing the command.",
    );
  }
  const rewrite = rewriteExactLifecycleCommand(input.payload, identity.sessionId);
  if (rewrite === null) return decision;
  if (rewrite.kind === "conflict") {
    return deny(
      input,
      "occupancy-identity-conflict",
      toolName,
      `Directive denied ${toolName}: ${rewrite.message} Host payload owner is ` +
        `${identity.sessionId}, but the command names ${rewrite.existingSessionId}.`,
    );
  }
  return { ...decision, updatedInput: rewrite.updatedInput };
}

/** Decide a normalized event using only the P0 direct-write policy. */
export function decideHook(input: HookDispatchInput, seams: HookPolicySeams = {}): HookDecision {
  const projectRoot = resolve(input.projectRoot);

  // #3039: local (untracked) `.deft-directive-disable` wins for enforcement
  // short-circuit (SessionStart / compact / PreToolUse). Deposit may remain.
  // Tracked/committed flags do NOT bypass gates (repo-controlled content must
  // not disable enforcement for clones) — doctor warns instead.
  // #3794: the kill-switch is pinned to payloadRoot. The flag is untracked, so
  // linked worktrees do not carry it; re-pointing would silently re-arm.
  {
    const detectKill = seams.detectDeftDirectiveDisable ?? detectDeftDirectiveDisable;
    const kill = detectKill(projectRoot);
    const killActive =
      seams.detectDeftDirectiveDisable !== undefined
        ? kill.active
        : isDeftDirectiveDisableActive(projectRoot);
    if (killActive) {
      const detectOptOut = seams.detectNoDeftDirective ?? detectNoDeftDirective;
      const optOut = detectOptOut(projectRoot);
      const message = formatDeftDirectiveDisableMessage({
        permanentOptOutAlsoPresent: optOut.present,
        trackedByGit: false,
      });
      return {
        verdict: "allow",
        code: input.event === "session.start" ? "session-start-disabled" : "directive-disabled",
        event: input.event,
        host: input.host,
        toolName: null,
        projectRoot,
        message,
        scopePath: null,
      };
    }
  }

  if (input.event === "session.compact") {
    try {
      const result = (seams.markCompactStale ?? markRitualStaleAfterCompact)(projectRoot);
      if (!result.changed) {
        return {
          verdict: "allow",
          code: "session-compact-noop",
          event: input.event,
          host: input.host,
          toolName: null,
          projectRoot,
          // Soft checklist still surfaces after compact even when ritual was absent (#3171).
          message: appendSoftAgentsRebindToMessage(result.message),
          scopePath: null,
        };
      }
      return {
        verdict: "allow",
        code: "session-compact-rearm",
        event: input.event,
        host: input.host,
        toolName: null,
        projectRoot,
        message: appendSoftAgentsRebindToMessage(result.message),
        scopePath: null,
      };
    } catch (cause) {
      return {
        verdict: "allow",
        code: "session-compact-rearm-degraded",
        event: input.event,
        host: input.host,
        toolName: null,
        projectRoot,
        message: appendSoftAgentsRebindToMessage(
          "Directive compact re-arm bookkeeping failed on its non-blocking path: " +
            `${String(cause)}`,
        ),
        scopePath: null,
      };
    }
  }

  if (input.event === "session.start") {
    // #2926: root `.no-deft-directive` wins — skip host SessionStart bookkeeping.
    const detectOptOut = seams.detectNoDeftDirective ?? detectNoDeftDirective;
    const optOut = detectOptOut(projectRoot);
    if (optOut.present) {
      const message = optOut.inconsistent
        ? `${NO_DEFT_DIRECTIVE_DISABLED_MESSAGE}. ${NO_DEFT_DIRECTIVE_INCONSISTENT_MESSAGE}`
        : NO_DEFT_DIRECTIVE_DISABLED_MESSAGE;
      return {
        verdict: "allow",
        code: "session-start-disabled",
        event: input.event,
        host: input.host,
        toolName: null,
        projectRoot,
        message,
        scopePath: null,
      };
    }
    try {
      const result = (seams.sessionStart ?? runSessionStartHookWrite)(projectRoot);
      if (result.code !== 0) {
        const detail = (result.stderr || result.stdout).trim().replace(/\s+/g, " ").slice(0, 400);
        return {
          verdict: "allow",
          code: "session-start-degraded",
          event: input.event,
          host: input.host,
          toolName: null,
          projectRoot,
          // Best-effort soft cue on SessionStart (Codex gap + resume/amnesia) (#3171).
          message: appendSoftAgentsRebindToMessage(
            `Directive SessionStart bookkeeping reported exit ${result.code} on its non-blocking path` +
              `${detail.length > 0 ? `: ${detail}` : "."}`,
          ),
          scopePath: null,
        };
      }
    } catch (cause) {
      return {
        verdict: "allow",
        code: "session-start-degraded",
        event: input.event,
        host: input.host,
        toolName: null,
        projectRoot,
        message: appendSoftAgentsRebindToMessage(
          `Directive SessionStart bookkeeping failed on its non-blocking path: ${String(cause)}`,
        ),
        scopePath: null,
      };
    }
    return {
      verdict: "allow",
      code: "session-start",
      event: input.event,
      host: input.host,
      toolName: null,
      projectRoot,
      // Soft AGENTS re-bind on SessionStart without requiring a write tool (#3171 / #2769).
      message: appendSoftAgentsRebindToMessage(
        "SessionStart bookkeeping completed on a non-blocking path.",
      ),
      scopePath: null,
    };
  }

  const toolName = hookToolName(input.payload, input.host);
  if (toolName === null) {
    // stdin-empty is a host-integration failure; keep it distinct from invalid-input
    // so agents can retry without treating it as a policy refusal (#2864).
    const missingCode: HookDecisionCode = input.payloadContext?.stdinEmpty
      ? "stdin-empty"
      : "invalid-input";
    return deny(
      input,
      missingCode,
      null,
      missingToolNameMessage({
        host: input.host,
        payload: input.payload,
        context: input.payloadContext,
      }),
    );
  }
  const environ = input.environ ?? process.env;
  const readOnly = isReadOnlyHookContext(input.payload, environ);
  if (readOnly && isDirectWriteTool(toolName)) {
    return deny(
      input,
      "read-only-deny",
      toolName,
      `Directive denied ${toolName}: read-only explore posture blocks direct writes. ` +
        'Use Grok `default_capability_mode = "read-only"` for role-based explore agents, ' +
        "or set explore subagent_type / DEFT_HOOK_READ_ONLY=1 when the harness supports it.",
    );
  }

  if (isSpawnTool(toolName)) {
    if (readOnly && !isExploreSpawn(input.payload)) {
      return deny(
        input,
        "read-only-deny",
        toolName,
        `Directive denied ${toolName}: read-only posture blocks implementation sub-agent spawns. ` +
          "Use subagent_type explore for read-only research spawns.",
      );
    }
    if (isExploreSpawn(input.payload)) {
      return {
        verdict: "allow",
        code: "spawn-explore-ready",
        event: input.event,
        host: input.host,
        toolName,
        projectRoot,
        message: `Directive allowed explore ${toolName} spawn without implementation gates.`,
        scopePath: null,
      };
    }
    // Ephemeral/docs/assist (+ session assist env #3259): non-lifecycle spawn;
    // no active xBRIEF. Does not authorize push/merge/deploy — shell/MCP matchers.
    if (isEphemeralSpawn(input.payload, environ)) {
      return {
        verdict: "allow",
        code: "spawn-ephemeral-ready",
        event: input.event,
        host: input.host,
        toolName,
        projectRoot,
        message:
          `Directive allowed ephemeral ${toolName} spawn without active-xBRIEF ` +
          "implementation gates (non-lifecycle assist/docs posture).",
        scopePath: null,
      };
    }
    return inspectMutationGates(input, toolName, seams, { proposedLifecycleExempt: false });
  }

  // Shell dest-forms (#3438): recognized product mutations share inspectMutationGates
  // with Edit/Write (assist/scratch, proposed lifecycle, file_scope). Push/merge stay
  // on runtimeAuthority (#2711). Non-dest unclassifiable shell (git status) fail-open.
  if (isShellTool(toolName)) {
    const decision = decideShellDestFormsThenRuntimeAuthority(input, toolName, seams);
    return attachLifecycleIdentityRewrite(input, toolName, decision, seams);
  }

  // Classifiable MCP: enforce scopes.push / scopes.merge (#2711).
  // Route bare push/merge MCP names (merge_pull_request, git_push, …) even when
  // isMcpTool is false — classifyMcpTool is the gate (dispatcher-side, no tools↔policy cycle).
  if (isMcpTool(toolName) || classifyMcpTool(toolName, hookMcpArgsText(input.payload)) !== null) {
    return decideShellOrMcpRuntimeAuthority(input, toolName, seams);
  }

  if (!isDirectWriteTool(toolName)) {
    return {
      verdict: "allow",
      code: "not-direct-write",
      event: input.event,
      host: input.host,
      toolName,
      projectRoot,
      message: `${toolName} is outside the P0 direct-write/spawn/shell enforcement slice.`,
      scopePath: null,
    };
  }

  return inspectMutationGates(input, toolName, seams, { proposedLifecycleExempt: true });
}

/**
 * Soft AGENTS re-bind text for host injection when decision carries soft path (#3171).
 * Prefer the checklist portion of the decision message; fall back to SoT formatter.
 */
function softAgentsRebindWireText(decision: HookDecision): string | null {
  if (!decisionCarriesSoftAgentsRebind({ event: decision.event, code: decision.code })) {
    return null;
  }
  if (decision.message.includes("Soft AGENTS re-bind checklist:")) {
    return decision.message;
  }
  return formatSoftAgentsRebindChecklist();
}

/**
 * Render host-facing hook output.
 *
 * Cursor deposits use `failClosed: true` with a tool.before timeout above the
 * gated-ritual / live agent-hook readiness budget
 * (`CURSOR_TOOL_BEFORE_TIMEOUT_SECONDS` in init-deposit/agent-hooks; #3246).
 * Cursor treats empty/null stdout (or a host timeout kill) as a hook failure
 * and blocks the tool — so Cursor allows must emit explicit
 * `{"permission":"allow"}` within the deposit timeout. Other hosts keep empty
 * allow so the host permission flow is unchanged — except session.start /
 * session.compact soft re-bind injection (#3171), which surfaces checklist
 * text without a write tool.
 *
 * Cursor stdout always includes `code` (stable machine-readable decision code)
 * so agents can distinguish policy denials from host-integration failures
 * without parsing English (#2864). Exit status still does not encode the
 * verdict — see hook-dispatch `run()` exit-code contract.
 */
export function renderHostDecision(host: HookHost, decision: HookDecision): string {
  if (decision.verdict === "allow") {
    if (decision.event === "tool.before" && decision.updatedInput !== undefined) {
      if (host === "cursor") {
        return JSON.stringify({
          permission: "allow",
          code: decision.code,
          updated_input: decision.updatedInput,
        });
      }
      if (host === "claude" || host === "codex") {
        return JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            updatedInput: decision.updatedInput,
          },
        });
      }
    }
    const soft = softAgentsRebindWireText(decision);
    if (host === "cursor") {
      if (decision.event === "session.start" && soft !== null) {
        // Cursor sessionStart injects additional_context into the conversation.
        return JSON.stringify({
          permission: "allow",
          code: decision.code,
          additional_context: soft,
        });
      }
      if (decision.event === "session.compact" && soft !== null) {
        // Cursor preCompact is observational; user_message surfaces the soft cue.
        // Hard re-arm still ran via bookkeeping; agent path also gets SessionStart on resume.
        return JSON.stringify({
          user_message: soft,
          code: decision.code,
        });
      }
      return JSON.stringify({ permission: "allow", code: decision.code });
    }
    if (
      soft !== null &&
      (decision.event === "session.start" || decision.event === "session.compact")
    ) {
      if (host === "claude" || host === "codex") {
        const hookEventName = decision.event === "session.start" ? "SessionStart" : "PostCompact";
        return JSON.stringify({
          hookSpecificOutput: {
            hookEventName,
            additionalContext: soft,
          },
        });
      }
      if (host === "grok") {
        return JSON.stringify({
          decision: "allow",
          reason: soft,
          additional_context: soft,
        });
      }
    }
    return "";
  }
  switch (host) {
    case "claude":
    case "codex":
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: decision.message,
        },
      });
    case "grok":
      return JSON.stringify({ decision: "deny", reason: decision.message });
    case "cursor":
      return JSON.stringify({
        permission: "deny",
        user_message: decision.message,
        agent_message: decision.message,
        code: decision.code,
      });
  }
}
