/**
 * Design-critique run-posture front door (#4072).
 *
 * Session-local execution posture chosen before mutation-capable session
 * start. Not a second ingest switch and not a third occupancy concept.
 * Closed tokens only; missing or `ingest` asks. Direct means
 * `session:start --read-only` (or release). Ingest stays `issue:ingest`
 * after the completed-arc record.
 */
export const ARC_RUN_POSTURES = ["direct", "checkout"] as const;

export type ArcRunPosture = (typeof ARC_RUN_POSTURES)[number];

export type RunPostureAskReason = "missing-token" | "ingest-is-not-posture" | "ambiguous";

export type RunPostureParse =
  | { kind: "resolved"; posture: ArcRunPosture }
  | { kind: "ask"; reason: RunPostureAskReason };

/** Published closed tokens that resolve to `direct`. */
export const DIRECT_RUN_POSTURE_TOKENS = [
  "direct",
  "forge-only",
  "github-only",
  "github only",
  "no worktrees",
] as const;

/** Published closed token that resolves to `checkout`. */
export const CHECKOUT_RUN_POSTURE_TOKENS = ["checkout"] as const;

export const DIRECT_SESSION_START = "session:start --read-only";

export const DIRECT_POSTING_PATH = "gh issue comment --body-file -";

export const ARC_MODE_FIELD = "arc-mode:";

export type DirectDispatchViolation =
  | "occupancy-claim"
  | "worktree-add"
  | "issue-ingest"
  | "mutation-session-start";

export type DirectDispatchVerdict =
  | { ok: true }
  | { ok: false; violations: readonly DirectDispatchViolation[] };

const DIRECT_TOKEN_RE = /\b(?:direct|forge-only|github-only|github[ \t]+only|no[ \t]+worktrees)\b/i;
const CHECKOUT_TOKEN_RE = /\bcheckout\b/i;
const INGEST_TOKEN_RE = /\bingest\b/i;
const DISPATCH_SHA_RE = /^[0-9a-f]{7,40}$/i;

/**
 * Parse an operator utterance for the run-posture closed set.
 * Yolo is not a posture token. `ingest` is not a front-door mode.
 */
export function parseOperatorRunPosture(utterance: string): RunPostureParse {
  const hasDirect = DIRECT_TOKEN_RE.test(utterance);
  const hasCheckout = CHECKOUT_TOKEN_RE.test(utterance);
  const hasIngest = INGEST_TOKEN_RE.test(utterance);
  if ((hasDirect && hasCheckout) || (hasDirect && hasIngest) || (hasCheckout && hasIngest)) {
    return { kind: "ask", reason: "ambiguous" };
  }
  if (hasDirect) {
    return { kind: "resolved", posture: "direct" };
  }
  if (hasCheckout) {
    return { kind: "resolved", posture: "checkout" };
  }
  if (hasIngest) {
    return { kind: "ask", reason: "ingest-is-not-posture" };
  }
  return { kind: "ask", reason: "missing-token" };
}

/** Stop 1 record line. Never writes `arc-mode: ingest`. */
export function arcModeRecordLine(posture: ArcRunPosture): string {
  return `arc-mode: ${posture}`;
}

/** True when the value is a hex pin, not a moving branch ref. */
export function isDispatchShaPin(value: string): boolean {
  return DISPATCH_SHA_RE.test(value.trim());
}

/**
 * SHA-pinned read root for direct critics. Refuses a moving branch ref.
 */
export function pinnedShowCommand(sha: string): string {
  const pin = sha.trim();
  if (!isDispatchShaPin(pin)) {
    throw new Error("dispatch SHA must be a hex pin, not a moving ref");
  }
  return `git show ${pin}:`;
}

/**
 * Fixture over parent-claimed actions for a direct dispatch. Does not observe
 * live occupancy or GitHub, matching `evaluatePanelSeatComposition`.
 */
export function evaluateDirectDispatch(input: {
  posture: ArcRunPosture;
  occupancyClaimed: boolean;
  worktreeAdd: boolean;
  issueIngest: boolean;
  sessionPosture: "read-only" | "mutation";
}): DirectDispatchVerdict {
  if (input.posture !== "direct") {
    return { ok: true };
  }
  const violations: DirectDispatchViolation[] = [];
  if (input.occupancyClaimed) {
    violations.push("occupancy-claim");
  }
  if (input.worktreeAdd) {
    violations.push("worktree-add");
  }
  if (input.issueIngest) {
    violations.push("issue-ingest");
  }
  if (input.sessionPosture === "mutation") {
    violations.push("mutation-session-start");
  }
  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}
