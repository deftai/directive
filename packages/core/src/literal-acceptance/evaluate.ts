/**
 * Evaluate literal acceptance-command gate from an xBRIEF plan or path (#3267).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  captureLiteralAcceptanceCommandsDetailed,
  formatRejectedLedger,
  isProseDerivedRejection,
  readStoredLiteralAcceptanceDetailed,
} from "./capture.js";
import { runLiteralAcceptanceCommands } from "./run.js";
import type {
  LiteralAcceptanceCommand,
  LiteralAcceptanceGateResult,
  LiteralAcceptanceRunner,
  RejectedLiteralCommand,
} from "./types.js";

export interface EvaluateLiteralAcceptanceOptions {
  readonly projectRoot?: string;
  readonly runner?: LiteralAcceptanceRunner;
  /**
   * When true and the plan has no stored commands, re-scan Overview/Description
   * narratives for stated commands (intake recovery). Default true.
   */
  readonly captureFromNarratives?: boolean;
  /** Quiet success (empty message on pass). */
  readonly quiet?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function planOf(data: Record<string, unknown>): Record<string, unknown> | null {
  return asRecord(data.plan);
}

/** Resolved literal-AC view: executable commands plus the blocking / advisory ledgers. */
export interface ResolvedLiteralAcceptance {
  readonly commands: readonly LiteralAcceptanceCommand[];
  /** Safety-rejected entries that block completion. */
  readonly rejected: readonly RejectedLiteralCommand[];
  /**
   * Prose/fence/inline-derived rejections demoted to advisory (#3484 / #3511).
   * Reported, never blocking. Structured-field rejections stay on `rejected`.
   */
  readonly advisoryRejected: readonly RejectedLiteralCommand[];
  /** Prompt lines skipped inside a transcript-shaped fence (#3511). */
  readonly transcriptPromptSkipped: number;
}

/**
 * Prose-derived rejections are advisory (#3484 / #3511). A scraper misread must
 * not block completion, whether or not the plan states structured commands —
 * blocking on a capture the extractor itself rejected is backwards. Rejections
 * from structured fields (`swarm.verify_commands`, plan items, explicit metadata)
 * keep blocking — those are real commands the author asked for.
 */
function partitionRejected(rejected: readonly RejectedLiteralCommand[]): {
  blocking: RejectedLiteralCommand[];
  advisory: RejectedLiteralCommand[];
} {
  const blocking: RejectedLiteralCommand[] = [];
  const advisory: RejectedLiteralCommand[] = [];
  for (const r of rejected) {
    if (isProseDerivedRejection(r)) advisory.push(r);
    else blocking.push(r);
  }
  return { blocking, advisory };
}

/**
 * Resolve commands + rejected ledger.
 * Stored first; when captureFromNarratives is true (default), also re-scan narratives
 * and merge any newly stated commands so stored entries cannot hide AC updates
 * (Greptile conf residual).
 */
export function resolveLiteralAcceptanceDetailed(
  plan: Record<string, unknown>,
  options: { readonly captureFromNarratives?: boolean } = {},
): ResolvedLiteralAcceptance {
  const raw = resolveRawLiteralAcceptance(plan, options);
  const split = partitionRejected(raw.rejected);
  return {
    commands: raw.commands,
    rejected: split.blocking,
    advisoryRejected: split.advisory,
    transcriptPromptSkipped: raw.transcriptPromptSkipped,
  };
}

function resolveRawLiteralAcceptance(
  plan: Record<string, unknown>,
  options: { readonly captureFromNarratives?: boolean } = {},
): {
  readonly commands: readonly LiteralAcceptanceCommand[];
  readonly rejected: readonly RejectedLiteralCommand[];
  readonly transcriptPromptSkipped: number;
} {
  const stored = readStoredLiteralAcceptanceDetailed(plan);
  if (options.captureFromNarratives === false) {
    return stored;
  }
  const narratives = asRecord(plan.narratives);
  if (narratives === null) {
    return stored;
  }
  const parts: string[] = [];
  for (const key of [
    "Overview",
    "Description",
    "Acceptance",
    "UserStory",
    "ImplementationPlan",
    "AcceptanceJustification",
  ]) {
    if (typeof narratives[key] === "string") {
      parts.push(narratives[key] as string);
    }
  }
  if (parts.length === 0) return stored;
  const captured = captureLiteralAcceptanceCommandsDetailed(parts.join("\n\n"));

  // Merge commands: keep stored (richer context) first; add narrative captures by
  // composite key (command+cwd+exit) so new stated lines are not suppressed.
  const cmdKey = (c: LiteralAcceptanceCommand): string => {
    const cwd =
      c.cwd !== null && c.cwd !== undefined && c.cwd.trim().length > 0 ? c.cwd.trim() : "";
    const exit = typeof c.expectedExitCode === "number" ? c.expectedExitCode : 0;
    return `${c.command}\0${cwd}\0${exit}`;
  };
  const seen = new Set(stored.commands.map(cmdKey));
  const commands = [...stored.commands];
  for (const c of captured.commands) {
    const k = cmdKey(c);
    if (seen.has(k)) continue;
    // Also skip pure command-string dupes already stored (any cwd) so narrative
    // re-capture does not invent a second null-cwd twin of an explicit row.
    if (commands.some((s) => s.command === c.command)) continue;
    seen.add(k);
    commands.push(c);
  }

  const rejectedSeen = new Set(stored.rejected.map((r) => `${r.command}\0${r.reason}`));
  const rejected = [...stored.rejected];
  for (const r of captured.rejected) {
    const k = `${r.command}\0${r.reason}`;
    if (rejectedSeen.has(k)) continue;
    rejectedSeen.add(k);
    rejected.push(r);
  }
  return {
    commands,
    rejected,
    transcriptPromptSkipped: captured.transcriptPromptSkipped,
  };
}

/**
 * Resolve commands: stored first; optional narrative re-capture when empty.
 */
export function resolveLiteralAcceptanceCommands(
  plan: Record<string, unknown>,
  options: { readonly captureFromNarratives?: boolean } = {},
): LiteralAcceptanceCommand[] {
  return [...resolveLiteralAcceptanceDetailed(plan, options).commands];
}

/**
 * Marker that opens the #3484 advisory block. Consumers strip from here to the end
 * before any free-text inspection of a literal-AC message: the block quotes refusal
 * reasons that were explicitly demoted and must not be read back as blocking (#3497).
 */
export const LITERAL_ACCEPTANCE_ADVISORY_MARKER = "Literal acceptance advisory (#3484):";

/** Render the #3484 advisory block (reported, never blocking). */
export function formatLiteralAcceptanceAdvisory(
  advisory: readonly RejectedLiteralCommand[],
): string {
  if (advisory.length === 0) return "";
  return (
    `${LITERAL_ACCEPTANCE_ADVISORY_MARKER} ${advisory.length} ` +
    `prose/fence-derived capture(s) were safety-rejected but do NOT block — ` +
    `the extractor is not confident these are stated acceptance commands (#3511).\n` +
    formatRejectedLedger(advisory)
  );
}

/** Append the #3484 advisory block to a message tail. */
export function appendLiteralAcceptanceAdvisory(
  message: string,
  advisory: readonly RejectedLiteralCommand[],
): string {
  const block = formatLiteralAcceptanceAdvisory(advisory);
  if (block.length === 0) return message;
  return message.length > 0 ? `${message}\n${block}` : block;
}

/**
 * Drop the #3484 advisory block from a rendered message.
 * The block is always the tail, so an index cut is exact.
 */
export function stripLiteralAcceptanceAdvisory(message: string): string {
  const at = message.indexOf(LITERAL_ACCEPTANCE_ADVISORY_MARKER);
  return at === -1 ? message : message.slice(0, at);
}

function appendRejectedNote(message: string, rejected: readonly RejectedLiteralCommand[]): string {
  const ledger = formatRejectedLedger(rejected);
  if (ledger.length === 0) return message;
  if (message.length === 0) return ledger;
  return `${message}\n${ledger}`;
}

/**
 * Evaluate from an in-memory plan object.
 */
export function evaluateLiteralAcceptanceFromPlan(
  plan: Record<string, unknown>,
  options: EvaluateLiteralAcceptanceOptions = {},
): LiteralAcceptanceGateResult {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const resolved = resolveLiteralAcceptanceDetailed(plan, {
    captureFromNarratives: options.captureFromNarratives,
  });
  const result = runLiteralAcceptanceCommands(resolved.commands, {
    projectRoot,
    runner: options.runner,
  });
  // Rejected stated commands are fail-closed for completion (#3267 Greptile conf residual).
  // A safety-rejected shell-shaped acceptance line is not "optional diagnostic" — operators
  // must promote a safe alternative or remove the stated command from the task statement.
  let ok = result.ok;
  let code = result.code;
  let message = appendRejectedNote(result.message, resolved.rejected);
  if (resolved.rejected.length > 0) {
    ok = false;
    if (code === 0) code = 1;
    const ledger = formatRejectedLedger(resolved.rejected);
    message =
      `Literal acceptance-command gate FAILED (#3267): ${resolved.rejected.length} ` +
      `safety-rejected stated command(s) block completion until resolved ` +
      `(promote a safe alternative or remove from the task statement).\n` +
      ledger +
      (result.message.length > 0 ? `\n${result.message}` : "");
  }
  // Prose/fence-derived rejections (#3484 / #3511) are reported, never blocking.
  if (resolved.advisoryRejected.length > 0) {
    message = appendLiteralAcceptanceAdvisory(message, resolved.advisoryRejected);
  }
  const withRejected: LiteralAcceptanceGateResult = {
    ...result,
    ok,
    code,
    rejected: resolved.rejected,
    advisoryRejected: resolved.advisoryRejected,
    transcriptPromptSkipped: resolved.transcriptPromptSkipped,
    message,
  };
  if (options.quiet === true && withRejected.ok) {
    return { ...withRejected, message: "" };
  }
  return withRejected;
}

/**
 * Evaluate from an xBRIEF JSON file path.
 */
export function evaluateLiteralAcceptanceFromPath(
  xbriefPath: string,
  options: EvaluateLiteralAcceptanceOptions = {},
): LiteralAcceptanceGateResult {
  const abs = resolve(xbriefPath);
  if (!existsSync(abs)) {
    return {
      ok: false,
      code: 2,
      message: `Literal acceptance-command gate: xBRIEF not found: ${abs}`,
      commands: [],
      runs: [],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8"));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: 2,
      message: `Literal acceptance-command gate: unreadable xBRIEF (${msg}): ${abs}`,
      commands: [],
      runs: [],
    };
  }
  const data = asRecord(parsed);
  if (data === null) {
    return {
      ok: false,
      code: 2,
      message: `Literal acceptance-command gate: xBRIEF top-level is not an object: ${abs}`,
      commands: [],
      runs: [],
    };
  }
  const plan = planOf(data);
  if (plan === null) {
    return {
      ok: false,
      code: 2,
      message: `Literal acceptance-command gate: xBRIEF missing plan object: ${abs}`,
      commands: [],
      runs: [],
    };
  }
  return evaluateLiteralAcceptanceFromPlan(plan, options);
}

/**
 * Pure ceremony-dial contract helper: literal AC run is required at every depth
 * including rapid/minimal (#3267 / #3214 / #3156).
 */
export function isLiteralAcceptanceRequiredAtCeremonyDepth(
  _depth: string | null | undefined,
): boolean {
  // Verification depth is constant — dial never skips this check.
  return true;
}
