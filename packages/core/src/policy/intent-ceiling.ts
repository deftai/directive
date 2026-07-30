/**
 * Slash-command intent containment (#1193 / extends #810).
 *
 * When a session inherits a slash command as its verb, that verb is the *only*
 * authorized intent for the session. Non-implement verbs must not authorize
 * implement / push / PR / merge / deploy tool paths.
 *
 * Provenance: set `DEFT_SESSION_SLASH_VERB` (e.g. `/github-issue`, `github-issue`,
 * `/build`) for the session, or pass `sessionVerb` explicitly to pure evaluators.
 */

/** Env var carrying the session's slash-command verb (#1193). */
export const ENV_SESSION_SLASH_VERB = "DEFT_SESSION_SLASH_VERB";

/**
 * Free-text action verbs that authorize implementation under #810.
 * Parallel list for slash forms lives in IMPLEMENT_SLASH_VERBS.
 */
export const FREE_TEXT_IMPLEMENT_VERBS = [
  "build",
  "implement",
  "ship",
  "swarm",
  "run agents",
  "start agent",
] as const;

/**
 * Slash-command stems that authorize implementation (#1193 R1).
 * Matched after normalizing `/prefix` and `:namespace` forms.
 */
export const IMPLEMENT_SLASH_VERBS = new Set([
  "build",
  "implement",
  "ship",
  "ship-hotfix",
  "swarm",
  "start-agent",
  "start_agent",
  "run-agents",
  "run_agents",
]);

/**
 * Explicit non-implement slash stems — always contained.
 * Unknown stems default to non-implement (fail closed for lifecycle escalation).
 */
export const NON_IMPLEMENT_SLASH_VERBS = new Set([
  "github-issue",
  "github_issue",
  "issue",
  "triage",
  "refine",
  "refinement",
  "discuss",
  "research",
  "probe",
  "glossary",
  "sync",
  "continue",
  "checkpoint",
  "feedback",
  "article-review",
  "cost",
  "setup",
  "interview",
  "map",
  "yolo",
  "speckit",
  "change",
]);

/** Lifecycle ops gated by the intent ceiling. */
export const INTENT_CEILING_OPS = ["implement", "push", "pr", "merge", "deploy"] as const;

export type IntentCeilingOp = (typeof INTENT_CEILING_OPS)[number];

export type IntentCeilingCode =
  | "intent-allow-no-slash"
  | "intent-allow-implement-verb"
  | "intent-deny-non-implement"
  | "intent-deny-unknown-slash";

export interface IntentCeilingDecision {
  readonly allowed: boolean;
  readonly code: IntentCeilingCode;
  readonly reason: string;
  /** Normalized slash stem (without leading `/`), or null when no slash provenance. */
  readonly sessionVerb: string | null;
  readonly requestedOp: IntentCeilingOp;
}

/**
 * Normalize a slash command or free-text verb to a comparable stem.
 * `/deft:directive:github-issue` → `github-issue`; `/build` → `build`.
 */
export function normalizeSessionVerb(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  let s = raw.trim().toLowerCase();
  if (s.length === 0) return null;
  // Strip leading slashes.
  while (s.startsWith("/")) s = s.slice(1);
  // Drop product namespaces: deft:directive:github-issue → github-issue
  if (s.includes(":")) {
    const parts = s.split(":").filter((p) => p.length > 0);
    s = parts[parts.length - 1] ?? s;
  }
  // Normalize underscores to hyphens for allowlist matching.
  s = s.replace(/_/g, "-");
  return s.length > 0 ? s : null;
}

/** True when the normalized stem authorizes implementation. */
export function isImplementSlashVerb(stem: string | null): boolean {
  if (stem === null) return false;
  if (IMPLEMENT_SLASH_VERBS.has(stem)) return true;
  // Free-text multi-word forms already hyphenated by normalize (run agents → not here).
  return false;
}

/** True when the stem is an explicitly known non-implement command. */
export function isNonImplementSlashVerb(stem: string | null): boolean {
  if (stem === null) return false;
  return NON_IMPLEMENT_SLASH_VERBS.has(stem);
}

export interface EvaluateIntentCeilingInput {
  readonly sessionVerb?: string | null;
  readonly requestedOp: IntentCeilingOp;
}

/**
 * Pure intent-ceiling evaluator (#1193 R1).
 *
 * - No slash verb → allow (free-text #810 action-verb remains agent/AGENTS gate).
 * - Implement slash verb → allow all lifecycle ops.
 * - Non-implement / unknown slash verb → deny implement/push/pr/merge/deploy.
 */
export function evaluateIntentCeiling(input: EvaluateIntentCeilingInput): IntentCeilingDecision {
  const stem = normalizeSessionVerb(input.sessionVerb ?? null);
  const op = input.requestedOp;

  if (stem === null) {
    return {
      allowed: true,
      code: "intent-allow-no-slash",
      reason: "No slash-command session verb; free-text #810 action-verb rules apply.",
      sessionVerb: null,
      requestedOp: op,
    };
  }

  if (isImplementSlashVerb(stem)) {
    return {
      allowed: true,
      code: "intent-allow-implement-verb",
      reason: `Slash verb '/${stem}' authorizes implementation lifecycle ops.`,
      sessionVerb: stem,
      requestedOp: op,
    };
  }

  const knownNon = isNonImplementSlashVerb(stem);
  const code: IntentCeilingCode = knownNon
    ? "intent-deny-non-implement"
    : "intent-deny-unknown-slash";
  return {
    allowed: false,
    code,
    reason:
      `Slash-command intent ceiling (#1193): session verb '/${stem}' does not authorize ` +
      `${op}. Non-implement verbs terminate at their named outcome; file a follow-up issue ` +
      `instead of escalating to implement/push/PR/merge/deploy. ` +
      `Implement verbs: /build, /ship, /ship-hotfix, /swarm, /implement.`,
    sessionVerb: stem,
    requestedOp: op,
  };
}

/** Read session slash verb from the environment. */
export function readSessionSlashVerbFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  return normalizeSessionVerb(env[ENV_SESSION_SLASH_VERB] ?? null);
}

/**
 * Evaluate intent ceiling for a lifecycle op using env-backed session verb.
 * Convenience for preflight / hooks / merge gates.
 */
export function evaluateIntentCeilingFromEnv(
  requestedOp: IntentCeilingOp,
  env: NodeJS.ProcessEnv = process.env,
): IntentCeilingDecision {
  return evaluateIntentCeiling({
    sessionVerb: readSessionSlashVerbFromEnv(env),
    requestedOp,
  });
}

/**
 * Map classifiable shell/MCP lifecycle signals onto intent-ceiling ops.
 * Returns null when the tool path is not a gated lifecycle op.
 */
export function intentOpFromShellSignals(signals: {
  readonly isPush?: boolean;
  readonly isMerge?: boolean;
  readonly isPr?: boolean;
  readonly isDeploy?: boolean;
  readonly isImplement?: boolean;
}): IntentCeilingOp | null {
  if (signals.isDeploy) return "deploy";
  if (signals.isMerge) return "merge";
  if (signals.isPr) return "pr";
  if (signals.isPush) return "push";
  if (signals.isImplement) return "implement";
  return null;
}
