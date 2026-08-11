/**
 * Evaluate literal acceptance-command gate from an xBRIEF plan or path (#3267).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  captureLiteralAcceptanceCommands,
  readStoredLiteralAcceptanceCommands,
} from "./capture.js";
import { runLiteralAcceptanceCommands } from "./run.js";
import type {
  LiteralAcceptanceCommand,
  LiteralAcceptanceGateResult,
  LiteralAcceptanceRunner,
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
 * Resolve commands: stored first; optional narrative re-capture when empty.
 */
export function resolveLiteralAcceptanceCommands(
  plan: Record<string, unknown>,
  options: { readonly captureFromNarratives?: boolean } = {},
): LiteralAcceptanceCommand[] {
  const stored = readStoredLiteralAcceptanceCommands(plan);
  if (stored.length > 0) {
    return stored;
  }
  if (options.captureFromNarratives === false) {
    return [];
  }
  const narratives = asRecord(plan.narratives);
  if (narratives === null) {
    return [];
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
  if (parts.length === 0) return [];
  return captureLiteralAcceptanceCommands(parts.join("\n\n"));
}

/**
 * Evaluate from an in-memory plan object.
 */
export function evaluateLiteralAcceptanceFromPlan(
  plan: Record<string, unknown>,
  options: EvaluateLiteralAcceptanceOptions = {},
): LiteralAcceptanceGateResult {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const commands = resolveLiteralAcceptanceCommands(plan, {
    captureFromNarratives: options.captureFromNarratives,
  });
  const result = runLiteralAcceptanceCommands(commands, {
    projectRoot,
    runner: options.runner,
  });
  if (options.quiet === true && result.ok) {
    return { ...result, message: "" };
  }
  return result;
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
