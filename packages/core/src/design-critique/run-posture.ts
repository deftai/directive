/**
 * Design-critique run-posture front door (#4072 / #4296).
 *
 * Session-local execution posture chosen before mutation-capable session
 * start. Not a second ingest switch and not a third occupancy concept.
 * Closed tokens only; missing or `ingest` asks. GitHub-only means no-ingest,
 * not no-worktree. Direct tokens resolve to `no-ingest`. Ingest stays
 * `issue:ingest` after the completed-arc record.
 */
import { type EnsureArcDestInput, type EnsureArcDestResult, ensureArcDest } from "./arc-dest.js";

export const ARC_RUN_POSTURES = ["no-ingest", "checkout"] as const;

export type ArcRunPosture = (typeof ARC_RUN_POSTURES)[number];

export type RunPostureAskReason = "missing-token" | "ingest-is-not-posture" | "ambiguous";

export type RunPostureParse =
  | { kind: "resolved"; posture: ArcRunPosture }
  | { kind: "ask"; reason: RunPostureAskReason };

/** Published closed tokens that resolve to `no-ingest` (github-only, not no-worktree). */
export const DIRECT_RUN_POSTURE_TOKENS = [
  "direct",
  "directly",
  "forge-only",
  "github-only",
  "github only",
  "on github",
  "no worktrees",
  "no-ingest",
  "no ingest",
] as const;

/** Published closed token that resolves to `checkout`. */
export const CHECKOUT_RUN_POSTURE_TOKENS = ["checkout"] as const;

export const DIRECT_SESSION_START = "session:start --read-only";

export const DIRECT_POSTING_PATH = "gh issue comment --body-file -";

export const ARC_MODE_FIELD = "arc-mode:";

export const NO_INGEST_ARC_MODE = "no-ingest";

export type DirectDispatchViolation = "occupancy-claim" | "issue-ingest" | "mutation-session-start";

export type DirectDispatchVerdict =
  | { ok: true }
  | { ok: false; violations: readonly DirectDispatchViolation[] };

const NO_INGEST_TOKEN_RE =
  /\b(?:direct|directly|forge-only|github-only|github[ \t]+only|on[ \t]+github|no[ \t]+worktrees|no-ingest|no[ \t]+ingest)\b/i;
const CHECKOUT_TOKEN_RE = /\bcheckout\b/i;
/** Bare `ingest` only. `no-ingest` / `no ingest` are github-only tokens. */
const INGEST_TOKEN_RE = /(?<!no[ \t-])\bingest\b/i;
const DISPATCH_SHA_RE = /^[0-9a-f]{7,40}$/i;

/**
 * Parse an operator utterance for the run-posture closed set.
 * Yolo is not a posture token. `ingest` is not a front-door mode.
 * GitHub-only closed tokens resolve to `no-ingest`, not no-worktree.
 */
export function parseOperatorRunPosture(utterance: string): RunPostureParse {
  const hasNoIngest = NO_INGEST_TOKEN_RE.test(utterance);
  const hasCheckout = CHECKOUT_TOKEN_RE.test(utterance);
  const hasIngest = INGEST_TOKEN_RE.test(utterance);
  if ((hasNoIngest && hasCheckout) || (hasNoIngest && hasIngest) || (hasCheckout && hasIngest)) {
    return { kind: "ask", reason: "ambiguous" };
  }
  if (hasNoIngest) {
    return { kind: "resolved", posture: "no-ingest" };
  }
  if (hasCheckout) {
    return { kind: "resolved", posture: "checkout" };
  }
  if (hasIngest) {
    return { kind: "ask", reason: "ingest-is-not-posture" };
  }
  return { kind: "ask", reason: "missing-token" };
}

/**
 * Host-facing run-posture resolver (#4202). Consumes parseOperatorRunPosture.
 * On grok-bot detect, missing-token defaults to no-ingest. Checkout tokens still
 * win. Does not clone the parser and does not implement grok-bot detect.
 */
export function resolveArcRunPostureForHost(input: {
  utterance: string;
  grokBotDetected: boolean;
}): RunPostureParse {
  const parsed = parseOperatorRunPosture(input.utterance);
  if (parsed.kind === "resolved") {
    return parsed;
  }
  if (input.grokBotDetected && parsed.reason === "missing-token") {
    return { kind: "resolved", posture: "no-ingest" };
  }
  return parsed;
}

/** Stop 1 record line. Never writes `arc-mode: ingest`. Emits parser posture. */
export function arcModeRecordLine(posture: ArcRunPosture): string {
  return `arc-mode: ${posture}`;
}

/**
 * Parent Stop 1 dest step (#4296). Fetches origin/<default> (or PR head), creates
 * or verifies the dest, and emits the parser arc-mode plus dest pin lines.
 */
export function prepareGithubOnlyDest(input: EnsureArcDestInput): {
  dest: EnsureArcDestResult;
  record: string;
} {
  const dest = ensureArcDest(input);
  return {
    dest,
    record: [
      arcModeRecordLine("no-ingest"),
      `dest: ${dest.destPath}`,
      `origin-ref: ${dest.originRef}`,
      `dispatch-sha: ${dest.dispatchSha}`,
    ].join("\n"),
  };
}

/** True when the value is a hex pin, not a moving branch ref. */
export function isDispatchShaPin(value: string): boolean {
  return DISPATCH_SHA_RE.test(value.trim());
}

/**
 * SHA-pinned read root for github-only critics. Refuses a moving branch ref.
 */
export function pinnedShowCommand(sha: string): string {
  const pin = sha.trim();
  if (!isDispatchShaPin(pin)) {
    throw new Error("dispatch SHA must be a hex pin, not a moving ref");
  }
  return `git show ${pin}:`;
}

/**
 * Fixture over parent-claimed actions for a github-only (no-ingest) dispatch.
 * Worktree-add is not a violation: github-only means no-ingest, not no-worktree.
 * Parent-unclaimed (`occupancyClaimed: false`) is its own MUST.
 * Does not observe live occupancy or GitHub, matching `evaluatePanelSeatComposition`.
 */
export function evaluateDirectDispatch(input: {
  posture: ArcRunPosture;
  occupancyClaimed: boolean;
  worktreeAdd: boolean;
  issueIngest: boolean;
  sessionPosture: "read-only" | "mutation";
}): DirectDispatchVerdict {
  if (input.posture !== "no-ingest") {
    return { ok: true };
  }
  void input.worktreeAdd;
  const violations: DirectDispatchViolation[] = [];
  if (input.occupancyClaimed) {
    violations.push("occupancy-claim");
  }
  if (input.issueIngest) {
    violations.push("issue-ingest");
  }
  if (input.sessionPosture === "mutation") {
    violations.push("mutation-session-start");
  }
  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}
