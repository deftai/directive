import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import { MAX_LINE_CHARS } from "../triage/welcome/constants.js";
import { evaluateHealth, type HealthReport, healthHistoryPath } from "./health.js";

/** Repeat-suppression window for the budgeted eval session nudge (#1703 / #1279 parity). */
export const EVAL_READBACK_SUPPRESSION_HOURS = 4;

export const EVAL_READBACK_HISTORY_REL = join(".deft-cache", "eval-readback-history.jsonl");
export const EVAL_READBACK_HISTORY_SCHEMA = "deft.eval.readback.v1";

export interface SessionEvalReadbackResult {
  readonly line: string | null;
  readonly suppressed: boolean;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= 3) {
    return text.slice(0, maxChars);
  }
  return `${text.slice(0, maxChars - 3)}...`;
}

function parseJsonObjectOrNull(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // malformed history line
  }
  return null;
}

function readHealthHistoryRows(projectRoot: string): HealthReport[] {
  const path = healthHistoryPath(projectRoot);
  if (path === null || !existsSync(path)) {
    return [];
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const rows: HealthReport[] = [];
  for (const line of text.split("\n")) {
    const stripped = line.trim();
    if (stripped.length === 0) {
      continue;
    }
    try {
      rows.push(JSON.parse(stripped) as HealthReport);
    } catch {
      // skip malformed ledger rows
    }
  }
  return rows;
}

function readbackHistoryPath(projectRoot: string): string {
  return resolve(projectRoot, EVAL_READBACK_HISTORY_REL);
}

function readLastReadbackRecord(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) {
    return null;
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return null;
  }
  const last = lines[lines.length - 1];
  if (last === undefined) {
    return null;
  }
  return parseJsonObjectOrNull(last);
}

function parseHistoryEmittedAt(record: Record<string, unknown>): Date | null {
  const raw = record.emitted_at;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return null;
  }
  let candidate = raw.trim();
  if (candidate.endsWith("Z")) {
    candidate = `${candidate.slice(0, -1)}+00:00`;
  }
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Stable nudge key for debounce — score + contradiction ids. */
export function evalReadbackNudgeKey(report: HealthReport): string {
  const contradictionIds = report.contradictions
    .map((c) => c.id)
    .sort()
    .join(",");
  return `eval-health:${report.score}:${contradictionIds}`;
}

/** True when the same eval nudge was read back within the suppression window. */
export function shouldSuppressEvalReadback(
  nudgeKey: string,
  historyFile: string,
  options: { now?: Date } = {},
): boolean {
  const prior = readLastReadbackRecord(historyFile);
  if (prior === null) {
    return false;
  }
  const emittedAt = parseHistoryEmittedAt(prior);
  if (emittedAt === null) {
    return false;
  }
  const now = options.now ?? new Date();
  const ageMs = now.getTime() - emittedAt.getTime();
  if (ageMs < 0 || ageMs >= EVAL_READBACK_SUPPRESSION_HOURS * 3_600_000) {
    return false;
  }
  return prior.nudge_key === nudgeKey;
}

function appendEvalReadbackHistory(
  projectRoot: string,
  nudgeKey: string,
  line: string,
  options: { now?: Date } = {},
): void {
  const path = readbackHistoryPath(projectRoot);
  const record = {
    schema: EVAL_READBACK_HISTORY_SCHEMA,
    emitted_at: (options.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z"),
    nudge_key: nudgeKey,
    line,
  };
  try {
    // #2980 wave C: product write sink routes through containedWrite.
    containedWrite({
      root: resolve(projectRoot),
      target: path,
      data: `${JSON.stringify(record)}\n`,
      mode: "append",
    });
  } catch {
    // observability only (containment refusals included — outer caller may swallow)
  }
}

function failedGateCount(report: HealthReport): number {
  return report.gates.filter((g) => !g.skipped && !g.pass).length;
}

/** Whether the current health report warrants a session-start advisory nudge (#2336). */
export function shouldNudgeEvalHealth(
  report: HealthReport,
  previous: HealthReport | null,
): boolean {
  if (report.contradictions.length > 0) {
    return true;
  }
  if (previous !== null && report.score < previous.score) {
    return true;
  }
  if (previous === null && report.score < 100 && failedGateCount(report) > 0) {
    return true;
  }
  return false;
}

export function formatEvalHealthSessionLine(
  report: HealthReport,
  previous: HealthReport | null,
): string {
  if (report.contradictions.length > 0) {
    const first = report.contradictions[0];
    const summary = first?.summary ?? "contradictory gate detected";
    return (
      `[eval] Framework health ${report.score}/100 — contradictory gate ${first?.id ?? "unknown"}: ` +
      `${summary.replace(/\r?\n/g, " ")} — run \`task eval:health\` for detail.`
    );
  }
  if (previous !== null && report.score < previous.score) {
    return (
      `[eval] Framework health dropped ${previous.score}->${report.score}/100 — ` +
      "run `task eval:health` for gate detail."
    );
  }
  const failed = failedGateCount(report);
  return (
    `[eval] Framework health ${report.score}/100 (${failed} gate${failed === 1 ? "" : "s"} failing) — ` +
    "run `task eval:health` for detail."
  );
}

export interface RenderSessionEvalReadbackOptions {
  readonly now?: Date;
  readonly maxChars?: number;
  readonly writeHistory?: boolean;
  readonly evaluate?: (projectRoot: string) => { report: HealthReport | null };
}

/** Budgeted session eval one-liner — silent when healthy or debounced (#1703 / #2336). */
export function renderSessionEvalReadback(
  projectRoot: string,
  options: RenderSessionEvalReadbackOptions = {},
): SessionEvalReadbackResult {
  try {
    const root = resolve(projectRoot);
    const priorRows = readHealthHistoryRows(root);
    const previous = priorRows.length > 0 ? (priorRows[priorRows.length - 1] ?? null) : null;

    const evaluateFn =
      options.evaluate ??
      ((cwd: string) => {
        const result = evaluateHealth({ projectRoot: cwd, persist: true });
        return { report: result.report };
      });
    const { report } = evaluateFn(root);
    if (report === null) {
      return { line: null, suppressed: false };
    }

    if (!shouldNudgeEvalHealth(report, previous)) {
      return { line: null, suppressed: false };
    }

    const nudgeKey = evalReadbackNudgeKey(report);
    const hist = readbackHistoryPath(root);
    if (shouldSuppressEvalReadback(nudgeKey, hist, { now: options.now })) {
      return { line: null, suppressed: true };
    }

    const maxChars = options.maxChars ?? MAX_LINE_CHARS;
    const line = truncate(formatEvalHealthSessionLine(report, previous), maxChars);
    if (options.writeHistory !== false) {
      appendEvalReadbackHistory(root, nudgeKey, line, { now: options.now });
    }
    return { line, suppressed: false };
  } catch {
    return { line: null, suppressed: false };
  }
}

/** Emit the eval session readback line when present. Returns the line or null. */
export function emitSessionEvalReadback(
  projectRoot: string,
  options: {
    output?: (line: string) => void;
    now?: Date;
    writeHistory?: boolean;
    evaluate?: (projectRoot: string) => { report: HealthReport | null };
  } = {},
): string | null {
  const result = renderSessionEvalReadback(projectRoot, options);
  if (result.line === null) {
    return null;
  }
  const out = options.output ?? ((line: string) => process.stdout.write(`${line}\n`));
  out(result.line);
  return result.line;
}
