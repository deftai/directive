/**
 * Evaluate literal acceptance-command gate from an xBRIEF plan or path (#3267).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  captureLiteralAcceptanceCommandsDetailed,
  formatRejectedLedger,
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

/**
 * Resolve commands + rejected ledger: stored first; optional narrative re-capture when empty.
 */
export function resolveLiteralAcceptanceDetailed(
  plan: Record<string, unknown>,
  options: { readonly captureFromNarratives?: boolean } = {},
): {
  readonly commands: readonly LiteralAcceptanceCommand[];
  readonly rejected: readonly RejectedLiteralCommand[];
} {
  const stored = readStoredLiteralAcceptanceDetailed(plan);
  if (stored.commands.length > 0 || stored.rejected.length > 0) {
    // When commands exist, still return any persisted rejected ledger.
    if (stored.commands.length > 0) {
      return stored;
    }
  }
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
  // Merge rejected ledgers (stored + narrative capture).
  const rejectedSeen = new Set(stored.rejected.map((r) => `${r.command}\0${r.reason}`));
  const rejected = [...stored.rejected];
  for (const r of captured.rejected) {
    const k = `${r.command}\0${r.reason}`;
    if (rejectedSeen.has(k)) continue;
    rejectedSeen.add(k);
    rejected.push(r);
  }
  return { commands: captured.commands, rejected };
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
  const withRejected: LiteralAcceptanceGateResult = {
    ...result,
    rejected: resolved.rejected,
    message: appendRejectedNote(result.message, resolved.rejected),
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
