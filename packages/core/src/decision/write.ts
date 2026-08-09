/**
 * decision:write — create a lightweight structured decision record (#1396).
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { ContainedWriteError, containedWrite } from "../fs/contained-write.js";
import { ProjectionContainmentError } from "../fs/projection-containment.js";
import { resolveProjectRoot } from "../scope/project-context.js";
import {
  DECISIONS_DIR_REL,
  type DecisionRecord,
  decisionFilename,
  formatDecisionValidationErrors,
  normalizeTimestamp,
  slugifyDecision,
  validateDecisionRecord,
} from "./schema.js";

export type DecisionWriteOutcome = "written" | "error-bad-args" | "error-config" | "error-io";

export interface DecisionWriteInput {
  readonly decision?: string;
  readonly governingRule?: string | { description: string; path?: string; rfc2119?: string };
  readonly alternatives?: readonly (string | { option: string; whyNot?: string })[];
  readonly whyWinner?: string;
  readonly confidence?: string;
  readonly scope?: string | readonly string[];
  readonly revisitTrigger?: string;
  readonly id?: string;
  readonly timestamp?: string;
  readonly tags?: readonly string[];
  readonly relatedIssues?: readonly number[];
  /** Absolute or project-relative path to a JSON body file (full or partial record). */
  readonly bodyFile?: string;
  /** Force standalone under xbrief/decisions/ even when --scope is set (still links). */
  readonly standalone?: boolean;
  readonly projectRoot?: string | null;
  readonly dryRun?: boolean;
  readonly json?: boolean;
}

export interface DecisionWriteResult {
  readonly outcome: DecisionWriteOutcome;
  readonly exitCode: 0 | 1 | 2;
  readonly path: string | null;
  readonly scopePath: string | null;
  readonly record: DecisionRecord | null;
  readonly message: string;
}

function loadBodyFile(bodyFile: string, projectRoot: string): Record<string, unknown> {
  const abs = resolve(bodyFile.startsWith(".") ? join(projectRoot, bodyFile) : bodyFile);
  const text = readFileSync(abs, "utf8");
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("body file must contain a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function mergeInput(options: DecisionWriteInput, projectRoot: string): Record<string, unknown> {
  let base: Record<string, unknown> = {};
  if (options.bodyFile !== undefined && options.bodyFile.trim().length > 0) {
    base = loadBodyFile(options.bodyFile.trim(), projectRoot);
  }

  const out: Record<string, unknown> = { ...base };
  if (options.decision !== undefined) out.decision = options.decision;
  if (options.governingRule !== undefined) out.governingRule = options.governingRule;
  if (options.alternatives !== undefined) out.alternativesConsidered = options.alternatives;
  if (options.whyWinner !== undefined) out.whyWinner = options.whyWinner;
  if (options.confidence !== undefined) out.confidence = options.confidence;
  if (options.revisitTrigger !== undefined) out.revisitTrigger = options.revisitTrigger;
  if (options.id !== undefined) out.id = options.id;
  if (options.timestamp !== undefined) out.timestamp = options.timestamp;
  if (options.tags !== undefined) out.tags = options.tags;
  if (options.relatedIssues !== undefined) out.relatedIssues = options.relatedIssues;

  if (options.scope !== undefined) {
    const scopes = Array.isArray(options.scope) ? options.scope : [options.scope];
    out.activeScopeRefs = scopes.map((s) => s.replace(/\\/g, "/"));
  }

  return out;
}

/**
 * Append a pointer line to plan.narratives.Decisions on a scope xBRIEF without
 * removing existing narratives (validators accept unknown narrative keys as strings).
 */
export function appendScopeDecisionPointer(
  projectRoot: string,
  scopeRelPath: string,
  decisionRelPath: string,
  decisionSummary: string,
): void {
  const scopeAbs = resolve(projectRoot, scopeRelPath);
  if (!existsSync(scopeAbs)) {
    throw new Error(`scope xBRIEF not found: ${scopeRelPath}`);
  }
  const raw = readFileSync(scopeAbs, "utf8");
  const doc: unknown = JSON.parse(raw);
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(`invalid scope xBRIEF JSON: ${scopeRelPath}`);
  }
  const plan = (doc as Record<string, unknown>).plan;
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) {
    throw new Error(`scope xBRIEF missing plan: ${scopeRelPath}`);
  }
  const narrativesRaw = (plan as Record<string, unknown>).narratives;
  const narratives: Record<string, unknown> =
    narrativesRaw !== null && typeof narrativesRaw === "object" && !Array.isArray(narrativesRaw)
      ? { ...(narrativesRaw as Record<string, unknown>) }
      : {};

  const pointer = `- ${decisionRelPath} — ${decisionSummary}`;
  const existing =
    typeof narratives.Decisions === "string" ? (narratives.Decisions as string).trim() : "";
  if (existing.includes(decisionRelPath)) {
    return;
  }
  narratives.Decisions = existing.length > 0 ? `${existing}\n${pointer}` : pointer;
  (plan as Record<string, unknown>).narratives = narratives;

  const data = `${JSON.stringify(doc, null, 2)}\n`;
  containedWrite({
    root: resolve(projectRoot),
    target: scopeAbs,
    data,
    mode: "replace",
  });
}

/** Write a validated decision record to disk (standalone + optional scope pointer). */
export function runDecisionWrite(options: DecisionWriteInput): DecisionWriteResult {
  const projectRootRaw = resolveProjectRoot(options.projectRoot ?? undefined);
  if (projectRootRaw === null) {
    return {
      outcome: "error-config",
      exitCode: 2,
      path: null,
      scopePath: null,
      record: null,
      message:
        "Error: could not resolve project root. Pass --project-root or run from a directive repo.\n",
    };
  }
  const projectRoot = resolve(projectRootRaw);

  let merged: Record<string, unknown>;
  try {
    merged = mergeInput(options, projectRoot);
  } catch (err) {
    return {
      outcome: "error-bad-args",
      exitCode: 2,
      path: null,
      scopePath: null,
      record: null,
      message: `Error: failed to load body file: ${err instanceof Error ? err.message : String(err)}\n`,
    };
  }

  const validated = validateDecisionRecord(merged);
  if (!validated.ok || validated.record === undefined) {
    return {
      outcome: "error-bad-args",
      exitCode: 2,
      path: null,
      scopePath: null,
      record: null,
      message: `Error: invalid decision record:\n${formatDecisionValidationErrors(validated.errors)}\n`,
    };
  }

  const record = validated.record;
  const filename = decisionFilename(record.id, record.timestamp);
  const relPath = join(DECISIONS_DIR_REL, filename).replace(/\\/g, "/");
  const absPath = resolve(projectRoot, relPath);

  const recordOut: DecisionRecord = {
    ...record,
    path: relPath,
  };

  if (options.dryRun) {
    return {
      outcome: "written",
      exitCode: 0,
      path: relPath,
      scopePath: record.activeScopeRefs[0] ?? null,
      record: recordOut,
      message: `[dry-run] would write ${relPath}\n`,
    };
  }

  try {
    mkdirSync(dirname(absPath), { recursive: true });
    const data = `${JSON.stringify(
      {
        schemaVersion: recordOut.schemaVersion,
        id: recordOut.id,
        decision: recordOut.decision,
        governingRule: recordOut.governingRule,
        alternativesConsidered: recordOut.alternativesConsidered,
        whyWinner: recordOut.whyWinner,
        confidence: recordOut.confidence,
        activeScopeRefs: recordOut.activeScopeRefs,
        timestamp: recordOut.timestamp,
        revisitTrigger: recordOut.revisitTrigger,
        ...(recordOut.tags !== undefined ? { tags: recordOut.tags } : {}),
        ...(recordOut.relatedIssues !== undefined
          ? { relatedIssues: recordOut.relatedIssues }
          : {}),
      },
      null,
      2,
    )}\n`;

    containedWrite({
      root: projectRoot,
      target: absPath,
      data,
      mode: existsSync(absPath) ? "replace" : "create",
    });

    let scopePath: string | null = null;
    if (record.activeScopeRefs.length > 0 && options.standalone !== true) {
      const scopeRel = record.activeScopeRefs[0] as string;
      try {
        appendScopeDecisionPointer(projectRoot, scopeRel, relPath, record.decision);
        scopePath = scopeRel;
      } catch (err) {
        return {
          outcome: "error-io",
          exitCode: 2,
          path: relPath,
          scopePath: null,
          record: recordOut,
          message:
            `[deft decision] Wrote ${relPath} but failed to attach scope pointer: ` +
            `${err instanceof Error ? err.message : String(err)}\n`,
        };
      }
    }

    const scopeNote = scopePath !== null ? ` (linked from ${scopePath})` : "";
    return {
      outcome: "written",
      exitCode: 0,
      path: relPath,
      scopePath,
      record: recordOut,
      message: `[deft decision] Wrote ${relPath}${scopeNote}\n`,
    };
  } catch (err) {
    if (err instanceof ContainedWriteError || err instanceof ProjectionContainmentError) {
      return {
        outcome: "error-io",
        exitCode: 2,
        path: null,
        scopePath: null,
        record: recordOut,
        message: `Error: contained write refused: ${err.message}\n`,
      };
    }
    return {
      outcome: "error-io",
      exitCode: 2,
      path: null,
      scopePath: null,
      record: recordOut,
      message: `Error: write failed: ${err instanceof Error ? err.message : String(err)}\n`,
    };
  }
}

export interface DecisionWriteCliArgs {
  decision?: string;
  governingRule?: string;
  governingPath?: string;
  governingRfc?: string;
  alternatives?: string[];
  whyWinner?: string;
  confidence?: string;
  scope?: string[];
  revisitTrigger?: string;
  id?: string;
  timestamp?: string;
  tags?: string[];
  relatedIssues?: number[];
  bodyFile?: string;
  standalone?: boolean;
  dryRun?: boolean;
  json?: boolean;
  projectRoot?: string;
  error?: string;
}

/** Parse argv for decision:write. */
export function parseDecisionWriteArgs(argv: readonly string[]): DecisionWriteCliArgs {
  const out: DecisionWriteCliArgs = {};
  const positionals: string[] = [];

  const takeValue = (i: number, flag: string, eqPrefix: string): [string | undefined, number] => {
    const arg = argv[i] as string;
    if (arg === flag) {
      return [argv[i + 1], i + 1];
    }
    if (arg.startsWith(eqPrefix)) {
      return [arg.slice(eqPrefix.length), i];
    }
    return [undefined, i];
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--standalone") out.standalone = true;
    else if (arg === "--decision" || arg.startsWith("--decision=")) {
      const [v, ni] = takeValue(i, "--decision", "--decision=");
      out.decision = v;
      i = ni;
    } else if (arg === "--governing-rule" || arg.startsWith("--governing-rule=")) {
      const [v, ni] = takeValue(i, "--governing-rule", "--governing-rule=");
      out.governingRule = v;
      i = ni;
    } else if (arg === "--governing-path" || arg.startsWith("--governing-path=")) {
      const [v, ni] = takeValue(i, "--governing-path", "--governing-path=");
      out.governingPath = v;
      i = ni;
    } else if (arg === "--governing-rfc" || arg.startsWith("--governing-rfc=")) {
      const [v, ni] = takeValue(i, "--governing-rfc", "--governing-rfc=");
      out.governingRfc = v;
      i = ni;
    } else if (arg === "--alternative" || arg.startsWith("--alternative=")) {
      const [v, ni] = takeValue(i, "--alternative", "--alternative=");
      if (v !== undefined) {
        out.alternatives = [...(out.alternatives ?? []), v];
      }
      i = ni;
    } else if (arg === "--why-winner" || arg.startsWith("--why-winner=")) {
      const [v, ni] = takeValue(i, "--why-winner", "--why-winner=");
      out.whyWinner = v;
      i = ni;
    } else if (arg === "--confidence" || arg.startsWith("--confidence=")) {
      const [v, ni] = takeValue(i, "--confidence", "--confidence=");
      out.confidence = v;
      i = ni;
    } else if (arg === "--scope" || arg.startsWith("--scope=")) {
      const [v, ni] = takeValue(i, "--scope", "--scope=");
      if (v !== undefined) {
        out.scope = [...(out.scope ?? []), v];
      }
      i = ni;
    } else if (arg === "--revisit-trigger" || arg.startsWith("--revisit-trigger=")) {
      const [v, ni] = takeValue(i, "--revisit-trigger", "--revisit-trigger=");
      out.revisitTrigger = v;
      i = ni;
    } else if (arg === "--id" || arg.startsWith("--id=")) {
      const [v, ni] = takeValue(i, "--id", "--id=");
      out.id = v;
      i = ni;
    } else if (arg === "--timestamp" || arg.startsWith("--timestamp=")) {
      const [v, ni] = takeValue(i, "--timestamp", "--timestamp=");
      out.timestamp = v;
      i = ni;
    } else if (arg === "--tag" || arg.startsWith("--tag=")) {
      const [v, ni] = takeValue(i, "--tag", "--tag=");
      if (v !== undefined) out.tags = [...(out.tags ?? []), v];
      i = ni;
    } else if (arg === "--related-issue" || arg.startsWith("--related-issue=")) {
      const [v, ni] = takeValue(i, "--related-issue", "--related-issue=");
      if (v !== undefined && /^\d+$/.test(v.trim())) {
        out.relatedIssues = [...(out.relatedIssues ?? []), Number(v.trim())];
      }
      i = ni;
    } else if (arg === "--body-file" || arg.startsWith("--body-file=")) {
      const [v, ni] = takeValue(i, "--body-file", "--body-file=");
      out.bodyFile = v;
      i = ni;
    } else if (arg === "--project-root" || arg.startsWith("--project-root=")) {
      const [v, ni] = takeValue(i, "--project-root", "--project-root=");
      out.projectRoot = v;
      i = ni;
    } else if (arg.startsWith("-")) {
      return { ...out, error: `unrecognized argument: ${arg}` };
    } else {
      positionals.push(arg);
    }
  }

  if ((out.decision === undefined || out.decision.trim().length === 0) && positionals.length > 0) {
    out.decision = positionals.join(" ");
  }
  return out;
}

/** CLI entry for decision:write. */
export function decisionWriteMain(argv: readonly string[]): number {
  const args = parseDecisionWriteArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`decision:write: ${args.error}\n`);
    return 2;
  }

  const governingRule =
    args.governingRule !== undefined
      ? {
          description: args.governingRule,
          path: args.governingPath,
          rfc2119: args.governingRfc,
        }
      : undefined;

  const result = runDecisionWrite({
    decision: args.decision,
    governingRule,
    alternatives: args.alternatives,
    whyWinner: args.whyWinner,
    confidence: args.confidence,
    scope: args.scope,
    revisitTrigger: args.revisitTrigger,
    id: args.id,
    timestamp: args.timestamp ?? normalizeTimestamp(),
    tags: args.tags,
    relatedIssues: args.relatedIssues,
    bodyFile: args.bodyFile,
    standalone: args.standalone,
    dryRun: args.dryRun,
    json: args.json,
    projectRoot: args.projectRoot,
  });

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          outcome: result.outcome,
          exit_code: result.exitCode,
          path: result.path,
          scope_path: result.scopePath,
          record: result.record,
          message: result.message.trim(),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(result.message);
  }

  return result.exitCode;
}

/** Relative path helper for tests. */
export function relativeToProject(projectRoot: string, absPath: string): string {
  return relative(projectRoot, absPath).replace(/\\/g, "/");
}

export { slugifyDecision };
