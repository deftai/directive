/**
 * Ephemeral session posture (#2180).
 *
 * Conversational posture is agent-context state — not authority derived from
 * `.deft/ritual-state.json`. Fresh or cleared contexts default to read-only;
 * gates run fresh only at mutation boundaries.
 *
 * Vocabulary aligned with #2176 (`SessionPosture`: `read-only` | `mutation`).
 */

/** Live agent posture — never persisted as repo authority. */
export type DirectivePosture = "read-only" | "mutation";

/** Default for fresh or manually cleared contexts (#2180). */
export const DEFAULT_POSTURE: DirectivePosture = "read-only";

/** Env override for deterministic gates / CLI (`read-only` | `mutation`). */
export const ENV_SESSION_POSTURE = "DEFT_SESSION_POSTURE";

/**
 * Ritual-state contract (#2180 / #1348 narrowed):
 * diagnostic evidence only — not proof of user intent or mutation posture.
 */
export const RITUAL_STATE_CONTRACT = "diagnostic-only" as const;

/** Action-verb directives that establish mutation intent (#810 / #2180). */
export const MUTATION_INTENT_VERBS = [
  "build",
  "implement",
  "ship",
  "swarm",
  "run agents",
  "start agent",
  "start_agent",
  "edit",
  "commit",
  "push",
  "open pr",
  "release",
  "scope:promote",
  "scope:activate",
  "scope:complete",
  "drive-to",
] as const;

export type MutationIntentVerb = (typeof MUTATION_INTENT_VERBS)[number];

export interface StructuredHandoff {
  readonly posture: DirectivePosture;
  readonly source: "plan" | "compaction" | "dispatch" | "allocation-context";
  readonly mutationIntent: boolean;
}

export interface ResolvePostureInput {
  readonly envPosture?: string | undefined;
  readonly handoffText?: string | null;
  readonly explicitPosture?: DirectivePosture | null;
  /** Gated tier implies a mutation boundary when posture is otherwise unset. */
  readonly tier?: "quick" | "gated";
}

function normalisePosture(raw: string | undefined | null): DirectivePosture | null {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "read-only" || value === "readonly") {
    return "read-only";
  }
  // Accept legacy "mutating" alias from early #2180 drafts.
  if (value === "mutation" || value === "mutating") {
    return "mutation";
  }
  return null;
}

/** Ritual-state must never be treated as posture authority (#2180). */
export function ritualStateIsPostureAuthority(): boolean {
  return false;
}

/** Detect explicit mutation intent from free-form operator or dispatch text. */
export function detectMutationIntent(text: string): boolean {
  const lower = text.toLowerCase();
  for (const verb of MUTATION_INTENT_VERBS) {
    // Require a non-hyphen / non-word char before the verb so hyphenated
    // compounds (e.g. "rebuild") do not false-positive on short verbs.
    const escaped = verb.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?:^|[^\\w-])${escaped}(?:$|[^\\w-])`, "i");
    if (pattern.test(lower)) {
      return true;
    }
  }
  if (/(?:^|[^\w-])drive-to:\s*merge-ready(?:$|[^\w-])/i.test(text)) {
    return true;
  }
  if (/\b(implement|ship)\s+\/\s*(implement|ship)\b/i.test(text)) {
    return true;
  }
  return false;
}

/** Parse structured handoff markers from plan / compaction / dispatch envelopes. */
export function parseStructuredHandoff(text: string | null | undefined): StructuredHandoff | null {
  if (!text || text.trim().length === 0) {
    return null;
  }

  const dispatchKind = text.match(/dispatch_kind:\s*(swarm-cohort|solo)/i)?.[1]?.toLowerCase();
  if (dispatchKind === "swarm-cohort" || dispatchKind === "solo") {
    const mutationIntent = detectMutationIntent(text);
    return {
      posture: mutationIntent ? "mutation" : "read-only",
      source: "allocation-context",
      mutationIntent,
    };
  }

  if (/##\s*structured handoff/i.test(text) || /handoff_kind:/i.test(text)) {
    const postureMatch = text
      .match(/posture:\s*(read-only|mutation|mutating)/i)?.[1]
      ?.toLowerCase();
    const intentTrue = /mutation_intent:\s*true\b/i.test(text);
    const intentFalse = /mutation_intent:\s*false\b/i.test(text);
    const source = /compaction/i.test(text) ? "compaction" : "plan";

    // Explicit structural flags win over free-form verb heuristics (#2180 SLizard).
    if (postureMatch === "read-only" || intentFalse) {
      return {
        posture: "read-only",
        source,
        mutationIntent: false,
      };
    }
    if (postureMatch === "mutation" || postureMatch === "mutating" || intentTrue) {
      return {
        posture: "mutation",
        source,
        mutationIntent: true,
      };
    }

    const mutationIntent = detectMutationIntent(text);
    return {
      posture: mutationIntent ? "mutation" : "read-only",
      source,
      mutationIntent,
    };
  }

  if (detectMutationIntent(text)) {
    return {
      posture: "mutation",
      source: "dispatch",
      mutationIntent: true,
    };
  }

  return null;
}

/**
 * Resolve ephemeral posture for the current agent context.
 * Precedence: explicit > env > structured handoff > tier default > read-only.
 * Never reads `.deft/ritual-state.json`.
 */
export function resolveSessionPosture(input: ResolvePostureInput = {}): DirectivePosture {
  if (input.explicitPosture) {
    return input.explicitPosture;
  }
  const fromEnv = normalisePosture(input.envPosture);
  if (fromEnv) {
    return fromEnv;
  }
  const handoff = parseStructuredHandoff(input.handoffText);
  if (handoff) {
    return handoff.posture;
  }
  if (input.tier === "gated") {
    return "mutation";
  }
  return DEFAULT_POSTURE;
}

/** Message when read-only posture skips ritual-state authority checks. */
export function readOnlyPostureMessage(tier: string): string {
  return (
    `OK read-only posture — session ritual ${tier} tier not required ` +
    `(ritual-state is diagnostic-only; run \`deft session:start\` at mutation boundaries).`
  );
}
