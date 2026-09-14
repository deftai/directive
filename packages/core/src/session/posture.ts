import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { containedRemove, containedWrite } from "../fs/contained-write.js";

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
export type DirectivePosture = "read-only" | "mutation" | "assist" | "requirements";

/** Default for fresh or manually cleared contexts (#2180). */
export const DEFAULT_POSTURE: DirectivePosture = "read-only";

/** Env override for deterministic gates / CLI (`read-only` | `mutation`). */
export const ENV_SESSION_POSTURE = "DEFT_SESSION_POSTURE";

/** Closed token set this module owns. Printed on unknown-token refusal (#4444). */
export const CLOSED_SESSION_POSTURE_TOKENS = [
  "read-only",
  "mutation",
  "assist",
  "requirements",
] as const;

export const ASSIST_POSTURE_ALIASES = [
  "assist",
  "ephemeral",
  "docs",
  "research",
  "research-notes",
  "research_notes",
  "scratch",
] as const;
export const REQUIREMENTS_DEFAULT_ALLOW_PATHS = [
  "docs/**",
  "specs/**",
  "README.md",
  "README",
  "REQUIREMENTS.md",
  "xbrief/proposed/**",
  "vbrief/proposed/**",
] as const;
export const REQUIREMENTS_DEFAULT_DENY_PATHS = [
  "**/AGENTS.md",
  "**/main.md",
  "**/SKILL.md",
  "content/commands.md",
  "content/contracts/**",
  "content/templates/**",
  "packages/**",
  "cmd/**",
  "src/**",
] as const;
export const REQUIREMENTS_UPGRADE_PATH =
  "Run deft session:start (mutation posture) with an active xBRIEF for product-code writes.";
export const UNKNOWN_POSTURE_TOKEN_PREFIX = "unknown session posture token";

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

export interface ParsedSessionPosture {
  readonly token: DirectivePosture | null;
  readonly raw: string;
  readonly error: string | null;
}

function normalizePostureToken(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s]/g, "-");
}

function closedSetHelp(): string {
  return (
    "closed set: " +
    CLOSED_SESSION_POSTURE_TOKENS.join("|") +
    " (assist aliases: " +
    ASSIST_POSTURE_ALIASES.join(", ") +
    "). Owner: packages/core/src/session/posture.ts."
  );
}

export function unknownPostureTokenMessage(raw: string): string {
  return UNKNOWN_POSTURE_TOKEN_PREFIX + " " + JSON.stringify(raw) + ". " + closedSetHelp();
}

/** Parse a trusted-producer token (CLI argv or DEFT_SESSION_POSTURE env). Empty is unset. Unknown tokens refuse. */
export function parseSessionPostureToken(raw: string | undefined | null): ParsedSessionPosture {
  const value = (raw ?? "").trim();
  if (value.length === 0) {
    return { token: null, raw: value, error: null };
  }
  const normalized = normalizePostureToken(value);
  if (normalized === "read-only" || normalized === "readonly") {
    return { token: "read-only", raw: value, error: null };
  }
  if (normalized === "mutation" || normalized === "mutating") {
    return { token: "mutation", raw: value, error: null };
  }
  if (ASSIST_POSTURE_ALIASES.some((alias) => normalizePostureToken(alias) === normalized)) {
    return { token: "assist", raw: value, error: null };
  }
  if (normalized === "requirements") {
    return { token: "requirements", raw: value, error: null };
  }
  return { token: null, raw: value, error: unknownPostureTokenMessage(value) };
}

function normalisePosture(raw: string | undefined | null): DirectivePosture | null {
  return parseSessionPostureToken(raw).token;
}

/** Env-only requirements classification -- never payload fields (#4444 trusted producer). */
export function isRequirementsPosture(environ: NodeJS.ProcessEnv = process.env): boolean {
  return parseSessionPostureToken(environ[ENV_SESSION_POSTURE]).token === "requirements";
}

export const SESSION_POSTURE_RELPATH = [".deft", "session-posture.json"] as const;
export const SESSION_POSTURE_PRODUCER = "session:start";

export function sessionPosturePath(projectRoot: string): string {
  return join(resolve(projectRoot), ...SESSION_POSTURE_RELPATH);
}

export function persistTrustedSessionPosture(
  projectRoot: string,
  token: DirectivePosture,
  sessionId: string,
): string {
  const owner = sessionId.trim();
  if (owner.length === 0) {
    throw new Error("requirements posture persist requires occupancy session id");
  }
  const parsed = parseSessionPostureToken(token);
  if (parsed.token === null || parsed.error !== null) {
    throw new Error(parsed.error ?? unknownPostureTokenMessage(token));
  }
  const payload = {
    schemaVersion: 1,
    posture: parsed.token,
    producer: SESSION_POSTURE_PRODUCER,
    sessionId: owner,
  };
  const target = sessionPosturePath(projectRoot);
  containedWrite({
    root: resolve(projectRoot),
    target,
    data: JSON.stringify(payload) + "\n",
    mode: "replace",
  });
  return target;
}

export function clearPersistedSessionPosture(projectRoot: string): void {
  try {
    containedRemove({ root: resolve(projectRoot), target: sessionPosturePath(projectRoot) });
  } catch {
    // already clear
  }
}

export function readPersistedSessionPosture(projectRoot: string): string | null {
  return readPersistedSessionPostureRecord(projectRoot)?.token ?? null;
}

export function readPersistedSessionPostureRecord(
  projectRoot: string,
): { token: DirectivePosture; sessionId: string } | null {
  const path = sessionPosturePath(projectRoot);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      posture?: unknown;
      producer?: unknown;
      sessionId?: unknown;
    };
    if (raw.producer !== SESSION_POSTURE_PRODUCER) return null;
    if (typeof raw.posture !== "string") return null;
    if (typeof raw.sessionId !== "string" || raw.sessionId.trim().length === 0) return null;
    const parsed = parseSessionPostureToken(raw.posture);
    if (parsed.token === null || parsed.error !== null) return null;
    return { token: parsed.token, sessionId: raw.sessionId.trim() };
  } catch {
    return null;
  }
}

/** Env wins; else ritual-adjacent session:start file bound to the live occupant. Payload fields stay untrusted. */
export function overlayTrustedSessionPosture(
  projectRoot: string,
  environ: NodeJS.ProcessEnv,
  occupantSessionId?: string | null,
): NodeJS.ProcessEnv {
  const existing = environ[ENV_SESSION_POSTURE];
  if (typeof existing === "string" && existing.trim().length > 0) {
    return environ;
  }
  const occupant = occupantSessionId?.trim() ?? "";
  if (occupant.length === 0) return environ;
  const persisted = readPersistedSessionPostureRecord(projectRoot);
  if (persisted === null) return environ;
  if (persisted.sessionId !== occupant) return environ;
  return { ...environ, [ENV_SESSION_POSTURE]: persisted.token };
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

/** Requirements posture skips gated ritual and story-start; occupancy still required (#4444). */
export function requirementsPostureMessage(): string {
  return "OK requirements posture -- tracked docs/specs/proposed xBRIEF writes skip gated ritual and story-start; occupancy still required. Product-code paths need mutation session:start.";
}
