/**
 * plan.acceptance schema helpers (#3284).
 *
 * Captures stated acceptance.commands at intake; empty requires none_stated:true.
 * Interoperates with #3267 plan.metadata.literal_acceptance_commands.
 */

import {
  attachLiteralAcceptanceCommands,
  type LiteralAcceptanceCommand,
  readStoredLiteralAcceptanceCommands,
} from "../literal-acceptance/index.js";
import { readAcceptanceClauses, serializeAcceptanceClauses } from "../verify-ac/clauses.js";
import {
  type AcceptanceCommand,
  type AcSourceRung,
  PLAN_ACCEPTANCE_KEY,
  type PlanAcceptance,
} from "./types.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function coerceCommands(raw: unknown): AcceptanceCommand[] {
  if (!Array.isArray(raw)) return [];
  const out: AcceptanceCommand[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      const command = entry.trim();
      if (command.length > 0) out.push({ command });
      continue;
    }
    const rec = asRecord(entry);
    if (rec === null) continue;
    const command = rec.command ?? rec.cmd ?? rec.shell;
    if (!isNonEmptyString(command)) continue;
    out.push({
      command: command.trim(),
      cwd: isNonEmptyString(rec.cwd) ? rec.cwd.trim() : null,
      expectedStdout: isNonEmptyString(rec.expectedStdout)
        ? rec.expectedStdout
        : isNonEmptyString(rec.expected_stdout)
          ? rec.expected_stdout
          : null,
      expectedExitCode:
        typeof rec.expectedExitCode === "number"
          ? rec.expectedExitCode
          : typeof rec.expected_exit_code === "number"
            ? rec.expected_exit_code
            : 0,
    });
  }
  return out;
}

function isAcSourceRung(value: unknown): value is AcSourceRung {
  return value === "stated" || value === "derived" || value === "project_floor";
}

/** Validation errors for a plan.acceptance object (empty list = valid). */
export function validatePlanAcceptance(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  const rec = asRecord(value);
  if (rec === null) {
    return ["plan.acceptance must be an object"];
  }
  const errors: string[] = [];
  if ("commands" in rec && rec.commands !== undefined && !Array.isArray(rec.commands)) {
    errors.push("plan.acceptance.commands must be an array");
  }
  if (
    "none_stated" in rec &&
    rec.none_stated !== undefined &&
    typeof rec.none_stated !== "boolean"
  ) {
    errors.push("plan.acceptance.none_stated must be a boolean");
  }
  if ("source_rung" in rec && rec.source_rung !== undefined && !isAcSourceRung(rec.source_rung)) {
    errors.push('plan.acceptance.source_rung must be "stated" | "derived" | "project_floor"');
  }
  if ("clauses" in rec && rec.clauses !== undefined && !Array.isArray(rec.clauses)) {
    errors.push("plan.acceptance.clauses must be an array");
  }
  if (Array.isArray(rec.clauses)) {
    rec.clauses.forEach((entry, index) => {
      const row = asRecord(entry);
      if (row === null) {
        errors.push(`plan.acceptance.clauses[${index}] must be an object`);
        return;
      }
      const text = isNonEmptyString(row.text) ? row.text.trim() : "";
      if (text.length === 0) {
        errors.push(`plan.acceptance.clauses[${index}].text must be a non-empty string`);
      }
    });
  }
  const commands = coerceCommands(rec.commands);
  const noneStated = rec.none_stated === true;
  if (commands.length === 0 && !noneStated) {
    errors.push(
      "plan.acceptance.commands is empty but none_stated is not true — " +
        "empty acceptance is only allowed with an explicit none_stated: true marker (#3284)",
    );
  }
  if (commands.length > 0 && noneStated && rec.source_rung === "stated") {
    errors.push(
      "plan.acceptance: none_stated:true with source_rung:stated is contradictory " +
        "(use source_rung:derived when commands are agent-authored under none_stated)",
    );
  }
  return errors;
}

/**
 * Read plan.acceptance when present; otherwise synthesize from #3267
 * literal_acceptance_commands / empty+none_stated.
 */
export function readPlanAcceptance(
  plan: Record<string, unknown> | null | undefined,
): PlanAcceptance {
  if (plan === null || plan === undefined) {
    return { commands: [], none_stated: true, source_rung: "project_floor" };
  }
  const raw = plan[PLAN_ACCEPTANCE_KEY];
  if (raw !== null && raw !== undefined) {
    const rec = asRecord(raw);
    if (rec !== null) {
      const commands = coerceCommands(rec.commands);
      const noneStated =
        rec.none_stated === true || (commands.length === 0 && rec.none_stated !== false);
      let sourceRung: AcSourceRung = isAcSourceRung(rec.source_rung)
        ? rec.source_rung
        : commands.length > 0
          ? "stated"
          : "project_floor";
      if (noneStated && commands.length > 0 && sourceRung === "stated") {
        sourceRung = "derived";
      }
      if (noneStated && commands.length === 0) {
        sourceRung = isAcSourceRung(rec.source_rung) ? rec.source_rung : "project_floor";
      }
      const clauses = readAcceptanceClauses(rec);
      return {
        commands,
        none_stated: noneStated,
        source_rung: sourceRung,
        derived_reason: isNonEmptyString(rec.derived_reason)
          ? rec.derived_reason
          : isNonEmptyString(rec.derivedReason)
            ? rec.derivedReason
            : null,
        ...(clauses.length > 0 ? { clauses } : {}),
      };
    }
  }

  // Fallback: #3267 metadata ledger.
  const literal = readStoredLiteralAcceptanceCommands(plan);
  if (literal.length > 0) {
    return {
      commands: literal.map(literalToAcceptance),
      none_stated: false,
      source_rung: "stated",
      derived_reason: null,
    };
  }
  return {
    commands: [],
    none_stated: true,
    source_rung: "project_floor",
    derived_reason: "no plan.acceptance and no literal_acceptance_commands (#3284 floor)",
  };
}

function literalToAcceptance(cmd: LiteralAcceptanceCommand): AcceptanceCommand {
  return {
    command: cmd.command,
    cwd: cmd.cwd ?? null,
    expectedStdout: cmd.expectedStdout ?? null,
    expectedExitCode: cmd.expectedExitCode ?? 0,
  };
}

function acceptanceToLiteral(
  cmd: AcceptanceCommand,
  source: LiteralAcceptanceCommand["source"],
): LiteralAcceptanceCommand {
  return {
    command: cmd.command,
    cwd: cmd.cwd ?? null,
    expectedStdout: cmd.expectedStdout ?? null,
    expectedExitCode: cmd.expectedExitCode ?? 0,
    source,
    sourceSpan: "plan.acceptance.commands",
  };
}

/** Attach a validated PlanAcceptance onto plan.acceptance + mirror to #3267 metadata. */
export function attachPlanAcceptance(
  plan: Record<string, unknown>,
  acceptance: PlanAcceptance,
): Record<string, unknown> {
  const errors = validatePlanAcceptance(acceptance);
  if (errors.length > 0) {
    throw new Error(`attachPlanAcceptance: ${errors.join("; ")}`);
  }
  const serializable: Record<string, unknown> = {
    commands: acceptance.commands.map((c) => {
      const row: Record<string, unknown> = { command: c.command };
      if (c.cwd) row.cwd = c.cwd;
      if (c.expectedStdout) row.expectedStdout = c.expectedStdout;
      if (typeof c.expectedExitCode === "number" && c.expectedExitCode !== 0) {
        row.expectedExitCode = c.expectedExitCode;
      }
      return row;
    }),
    none_stated: acceptance.none_stated,
    source_rung: acceptance.source_rung,
  };
  if (acceptance.derived_reason) {
    serializable.derived_reason = acceptance.derived_reason;
  }
  if (acceptance.clauses !== undefined && acceptance.clauses.length > 0) {
    serializable.clauses = serializeAcceptanceClauses(acceptance.clauses);
  }

  let next: Record<string, unknown> = {
    ...plan,
    [PLAN_ACCEPTANCE_KEY]: serializable,
  };

  // Mirror executable commands into #3267 ledger for verify:literal-ac interoperability.
  if (acceptance.commands.length > 0) {
    const source =
      acceptance.source_rung === "stated" ? ("task_statement" as const) : ("explicit" as const);
    // derived / floor commands are agent-authored → executable source=explicit
    const literalSource =
      acceptance.source_rung === "stated" ? ("task_statement" as const) : ("explicit" as const);
    void source;
    next = attachLiteralAcceptanceCommands(
      next,
      acceptance.commands.map((c) => acceptanceToLiteral(c, literalSource)),
    );
  }
  return next;
}

/**
 * Build plan.acceptance from intake capture (#3284).
 * Stated commands → none_stated:false, source_rung:stated.
 * No stated commands → none_stated:true, source_rung:project_floor (until agent derives).
 */
export function buildAcceptanceFromIntakeCapture(
  capturedCommands: readonly AcceptanceCommand[],
): PlanAcceptance {
  if (capturedCommands.length === 0) {
    return {
      commands: [],
      none_stated: true,
      source_rung: "project_floor",
      derived_reason:
        "no shell acceptance commands stated in task text; floor until agent derives AC (#3284 ladder)",
    };
  }
  return {
    commands: capturedCommands,
    none_stated: false,
    source_rung: "stated",
    derived_reason: null,
  };
}

/** Stamp plan.acceptance from existing literal capture after issue ingest. */
export function stampAcceptanceFromLiteralCapture(
  plan: Record<string, unknown>,
): Record<string, unknown> {
  const literal = readStoredLiteralAcceptanceCommands(plan);
  const acceptance = buildAcceptanceFromIntakeCapture(literal.map(literalToAcceptance));
  // Avoid re-mirroring task_statement into verify_commands (ingest strips those).
  const serializable: Record<string, unknown> = {
    commands: acceptance.commands.map((c) => {
      const row: Record<string, unknown> = { command: c.command };
      if (c.cwd) row.cwd = c.cwd;
      if (c.expectedStdout) row.expectedStdout = c.expectedStdout;
      if (typeof c.expectedExitCode === "number" && c.expectedExitCode !== 0) {
        row.expectedExitCode = c.expectedExitCode;
      }
      return row;
    }),
    none_stated: acceptance.none_stated,
    source_rung: acceptance.source_rung,
  };
  if (acceptance.derived_reason) {
    serializable.derived_reason = acceptance.derived_reason;
  }
  return {
    ...plan,
    [PLAN_ACCEPTANCE_KEY]: serializable,
  };
}
