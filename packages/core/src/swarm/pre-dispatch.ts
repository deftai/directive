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

import { isAbsolute, normalize, resolve } from "node:path";
import {
  type AttemptTrigger,
  activeAttempts,
  beginAttempt,
  completeAttemptOnDisk,
  type DeliveryAttemptRecord,
  evaluatePreDispatch,
  loadOrCreateUnitLedger,
  loadUnitLedger,
  markBlocked,
  type PreDispatchDecision,
  saveUnitLedger,
  withUnitLock,
} from "../delivery-attempt/index.js";
import { EXIT_CONFIG_ERROR, EXIT_GATE_FAILED, EXIT_OK } from "./constants.js";
import { runText } from "./subprocess.js";

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
  };
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

function runBegin(input: SwarmPreDispatchInput): SwarmPreDispatchResult {
  const { scopeId, targetId, workflowId } = unitFields(input);
  const sourceRevision = resolveSourceRevision(input.projectRoot, input.sourceRevision);
  const trigger: AttemptTrigger = input.trigger ?? "automatic";

  // Exclusive lock → reload → evaluate → begin+save (same decision under lock;
  // no stale preview decision on the success path).
  try {
    return withUnitLock(input.projectRoot, scopeId, targetId, workflowId, () => {
      const current = loadOrCreateUnitLedger(input.projectRoot, {
        scopeId,
        targetId,
        workflowId,
        now: input.now,
      });
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
        return baseResult(input, "begin", {
          exitCode: EXIT_GATE_FAILED,
          decision: decision.decision,
          reason: decision.reason,
          activeAttemptIds: activeAttempts(current).map((a) => a.attemptId),
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
      return baseResult(input, "begin", {
        exitCode: EXIT_OK,
        decision: decision.decision,
        reason: `allowed; attempt ${attempt.attemptId} begun`,
        attempt,
        activeAttemptIds: [attempt.attemptId],
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

  try {
    const next = completeAttemptOnDisk(input.projectRoot, {
      scopeId,
      targetId,
      workflowId,
      attemptId: input.attemptId,
      externalRunId: input.externalRunId ?? null,
      status,
      now: input.now,
    });
    const closed =
      next.attempts.find((a) => a.attemptId === input.attemptId) ??
      next.attempts.filter((a) => a.endedAt !== null).at(-1) ??
      null;
    return baseResult(input, action, {
      exitCode: EXIT_OK,
      decision: null,
      reason: `attempt ${closed?.attemptId ?? "?"} marked ${status}`,
      attempt: closed,
      activeAttemptIds: activeAttempts(next).map((a) => a.attemptId),
    });
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
  if (result.exitCode === EXIT_GATE_FAILED && result.decision === "DENY_DUPLICATE_ACTIVE") {
    lines.push(
      "  hint: do not spawn; resume the live leaf, or takeover = cancel then pre-dispatch begin",
    );
  }
  return lines.join("\n");
}
