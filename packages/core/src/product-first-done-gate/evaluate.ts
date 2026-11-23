/**
 * evaluate verify:ac — product-first acceptance gate (#3284).
 *
 * Runs plan.acceptance.commands (or #3267 literal ledger) via the shared
 * literal-acceptance runner. Records source_rung in the result message.
 * Project floor with empty commands is a soft pass only when a suite floor
 * exists (suite gates own the floor inside full `task check`). With no suite
 * floor, empty resolution is soft_empty — not a green run (#3334).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  emitAcceptanceStampFromPlan,
  MISSING_AMBIGUITY_ATTESTATION_CAUSE,
  stampedAmbiguityAttestationError,
} from "../intake/clause-derivation.js";
import {
  fetchPlanAdmittedSourceText,
  fetchSpecPathLiveIdentities,
  readSpecPathSourceRecord,
  SPEC_PATH_SOURCE_KEY,
  type SpecPathLiveIdentities,
  type SpecPathSourceRecord,
} from "../intake/spec-path-source.js";
import {
  ACCEPTANCE_CWD_DEPENDENCY_REFUSAL_ID,
  appendLiteralAcceptanceAdvisory,
  type EvaluateLiteralAcceptanceOptions,
  evaluateAcceptanceCommandRecord,
  findUnpromotedCaptureOnlyCommands,
  formatRejectedLedger,
  formatUnpromotedCaptureOnlyRecord,
  isExecutableLiteralSource,
  isInlineProseMention,
  isNoopRefusalReason,
  isSafetyRefusalRun,
  type LiteralAcceptanceCommand,
  type LiteralAcceptanceGateResult,
  type RejectedLiteralCommand,
  readNotAcceptanceCommands,
  readStoredLiteralAcceptanceCommands,
  resolveLiteralAcceptanceDetailed,
  runLiteralAcceptanceCommands,
  stripLiteralAcceptanceAdvisory,
  UNPROMOTED_CAPTURE_REMEDY,
} from "../literal-acceptance/index.js";
import {
  evaluateSmallChangeLaneGate,
  type SmallChangeLaneGateOverrides,
} from "../policy/small-change-lane.js";
import { formatDeclaredRefusal } from "../refusal-declarations/print.js";
import {
  type AcceptanceRunSummaryOutcome,
  ENV_RUN_SUMMARY_PATH,
  RunSummaryEmitter,
} from "../run-summary/index.js";
import { maybeBankOnAcPass } from "../session/ac-pass-banking.js";
import {
  collisionAwareOracleRelPath,
  resolveAcReuse,
  resolveScopeIdForAcReuse,
  snapshotFromReuseFields,
} from "../session/ac-pass-reuse.js";
import { defaultGitRunner, gitHead } from "../session/git.js";
import { hashProductState } from "../session/product-state-hash.js";
import {
  type AcServedFrom,
  resolveVerifyAcSessionId,
  writeVerifyAcSessionCache,
} from "../session/verify-ac-session-cache.js";
import {
  type ClauseWalkResult,
  countUnverifiedAdjudicableClauses,
  evaluateStatementSentenceCoverage,
  formatClauseWalkMessage,
  readDeclaredArtifactScope,
  UNMAPPED_STATEMENT_SENTENCE_CAUSE,
  walkAcceptanceClauses,
} from "../verify-ac/clauses.js";
import { annotateUnchangedSinceEntry } from "../verify-ac/entry-baseline-note.js";
import {
  emitVerifyAcAttempts,
  evaluateProductOracleIntegrity,
  mergeOracleVerdict,
} from "../verify-ac/evaluate.js";
import {
  evaluateRequirementSourcesStaleness,
  writeRequirementSourcesAutofixToXbrief,
} from "../verify-ac/requirement-sources.js";
import {
  digestAdmittedSourceSentences,
  extractAdmittedSourceIdentitiesWithVersion,
  readAdmittedSourceDigest,
  readAdmittedSourceExtractor,
  readAdmittedSourceSentences,
  readPlanAcceptance,
  STATEMENT_SENTENCE_NARRATIVE_KEYS,
  stampAcceptanceFromLiteralCapture,
  validatePlanAcceptance,
} from "./acceptance.js";
import {
  type AcceptanceLedgerEntry,
  acceptanceLedgersEqual,
  clauseWalkBlocks,
  formatAcceptanceVerdict,
  readAcceptanceLedger,
  relabelVerifyAcPassLead,
  resolveAcceptanceGateProfile,
  resolveAcceptanceVerdict,
} from "./acceptance-resolver.js";
import {
  formatSoftEmptyMessage,
  formatTranscriptEmptyMessage,
  isEmptyAcResolution,
  projectHasSuiteFloor,
  type VerifyAcResolution,
} from "./empty-resolution.js";
import type { AcSourceRung, PlanAcceptance } from "./types.js";

export interface VerifyAcResult extends LiteralAcceptanceGateResult {
  readonly sourceRung: AcSourceRung;
  readonly noneStated: boolean;
  readonly acceptance: PlanAcceptance;
  readonly resolution: VerifyAcResolution;
  readonly resolvedCommandCount: number;
  readonly clauseOutcomes?: readonly ClauseWalkResult[];
  readonly clauseWalked?: boolean;
  /** Clauses left out of the walk because a grant stamped them this run (#6644). */
  readonly clauseGranted?: number;
  /** How the result was obtained (#3387). */
  readonly servedFrom?: AcServedFrom;
  /** Config-error cause when resolution is config (#3559). */
  readonly cause?: string;
  /**
   * Clauses that are neither existence nor quoted-token claims.
   * Present when the brief carries a sentence list (#3550).
   */
  readonly behavioralClauseCount?: number;
  /** Sentences that are neither a clause nor an explicit confession (#3550). */
  readonly unmappedSentenceCount?: number;
  /** Reuse-gate miss cause when servedFrom is executed (#3558). */
  readonly missReason?: string;
  /** Workspace requirement_sources re-hashed this walk (#3920). */
  readonly sourcesRechecked?: number;
  /** Workspace requirement_sources whose digest changed this walk (#3920). */
  readonly sourcesChanged?: number;
}

/** A clause a grant stamped in this scope:complete run (#6644). */
export interface GrantedClauseNote {
  readonly id: number;
  readonly disposition: string;
  readonly reason: string;
}

export interface EvaluateVerifyAcOptions extends EvaluateLiteralAcceptanceOptions {
  /**
   * Clauses stamped from an acceptance-disposition grant in this run (#6644).
   * Only scope:complete passes it, from applyAcceptanceDispositionGrants. The
   * clause walk leaves them out of its counts; the sentence floor and the
   * admitted-source identity check still read the brief as before.
   */
  readonly grantedClauses?: readonly GrantedClauseNote[];
  /**
   * Completion-only floor record (#7047). Only the scope:complete walk passes
   * it, when its first walk would refuse zero-verified on a clause-bearing brief
   * with no effective command. The record joins the resolved contract like any
   * other record: safety, the blocking refusal, the reuse identity and the bank
   * ledger all see it. It is never written to the brief.
   */
  readonly completionFloorRecord?: LiteralAcceptanceCommand;
  /**
   * When true, missing xBRIEF / no active scope is exit 0 (check composition).
   * Default false for standalone done-gate use. Multi-active path selection for
   * check composition lives in resolveSoftMissingAcTargets (#4285); this flag
   * does not soft-green past stated AC for the selected story (#3284).
   */
  readonly softMissingXbrief?: boolean;
  /**
   * Check-graph mode (#3284): used by `task check` via `--soft-missing-xbrief`.
   * - Unpromoted capture-only (task_statement) commands do not fail the graph
   *   (promotion remains a done-gate / scope:complete concern via verify:ac standalone).
   * - Executable command failures still fail closed (product-first).
   * - Safety-rejected ledger still fails closed.
   * - Multi-active composition selects one story via DEFT_ACTIVE_SCOPE / path (#4285).
   */
  readonly checkIntegrated?: boolean;
  /** Allow task_statement sources to execute (tests / explicit promote). */
  readonly allowTaskStatement?: boolean;
  /**
   * When false, skip AC-pass banking after executable pass (#3285).
   * Default true — first green executable AC banks a finalize checkpoint.
   */
  readonly bankOnPass?: boolean;
  /** Optional scope id override for the bank ledger (default plan.id / path). */
  readonly bankScopeId?: string | null;
  /**
   * Injected run-summary JSONL for product-oracle integrity (#3322).
   * Undefined → read DEFT_RUN_SUMMARY_PATH / default dest; null → skip disk.
   */
  readonly runSummaryText?: string | null;
  /** When false, skip #3322 oracle integrity. Default true. */
  readonly applyOracleIntegrity?: boolean;
  /** Env seam for run-summary dest resolution (#3322 / #3334). */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Inject suite-floor detection (tests). Default: framework source has a
   * suite floor; consumer projects do not (#3334).
   */
  readonly hasSuiteFloor?: boolean;
  /**
   * When true, skip the acceptance run-summary emit so the path helper can
   * emit after the #3285 bank checkpoint.
   */
  readonly skipAcceptanceEmit?: boolean;
  /**
   * Raw plan.acceptance as observed on the brief (#3355). Distinct from the
   * synthesized floor: stamp only when the plan actually carries a block.
   */
  readonly observedAcceptance?: unknown;
  /**
   * Active scope key for product-oracle check_id namespacing (#3337).
   * Prefer plan.id; path stem when id is missing. Multi-active verify:ac
   * under one session must not share a single global `verify:ac` check id.
   */
  readonly oracleScopeKey?: string | null;
  /**
   * Reuse a matching #3285 bank / same-session cache (#3387).
   * - auto (default): cache then bank
   * - bank: complete walk — bank only
   * - never: always execute
   */
  readonly reuseMode?: "auto" | "bank" | "never";
  readonly sessionId?: string | null;
  readonly productPaths?: readonly string[];
  /**
   * Merge-base / HEAD copy of the admitted-source pin (#5055). Tests inject;
   * production may resolve via git show of the brief. Null means "looked up, absent".
   */
  readonly admittedSourceMergeBase?: {
    readonly sentences: readonly string[];
    readonly digest?: string | null;
    /**
     * Where the git pin came from (#6333). `head` is the branch-only fallback
     * and is not proof that the brief is on the merge base. Omitted = merge-base.
     */
    readonly source?: "merge-base" | "head";
  } | null;
  /**
   * True when the brief (same basename, any lifecycle folder) is on the merge
   * base (#6333 item 5). Path evaluation probes git; tests inject.
   */
  readonly briefOnMergeBase?: boolean;
  /**
   * Live identities of a recorded Spec-path brief (#6333 item 4): the cited
   * lean resolved through the completed-arc record of the source issue. The
   * default reads the thread over REST. Tests inject.
   */
  readonly fetchSpecPathLiveIdentities?: (record: SpecPathSourceRecord) => SpecPathLiveIdentities;
  /**
   * Live admitted-source text at the ingest-recorded revision (#5055).
   * Body-normative: origin issue body. Spec-path: Bound-remedy harvest (not the
   * refused raw body). Returned failure on outage — do not skip. Tests inject.
   */
  readonly fetchAdmittedSourceText?: () =>
    | { readonly ok: true; readonly text: string }
    | { readonly ok: false; readonly reason: string };
  /**
   * Absolute or project-relative xBRIEF path (#5055). When set, plan evaluation
   * recovers the admitted-source pin from merge-base / HEAD the same way as
   * evaluateVerifyAcFromPath — so scope:complete cannot skip missing-pin recovery.
   */
  readonly xbriefPath?: string | null;
  /**
   * Persist requirement_sources autofix restamp (#3920). Path helper writes the
   * xBRIEF; tests may inject. Default: in-memory plan only.
   */
  readonly persistRequirementSourcesAutofix?: (plan: Record<string, unknown>) => void;
  /**
   * Small-change lane recheck (#6204). scope:complete passes the delivered
   * commit so the walk measures the delivered diff. Tests inject depth / bound.
   */
  readonly smallChangeLane?: SmallChangeLaneGateOverrides;
  /** Internal: stamped by evaluateVerifyAcFromPlan after the #3920 re-hash. */
  readonly requirementSourcesTelemetry?: {
    readonly sourcesRechecked: number;
    readonly sourcesChanged: number;
    readonly autofixMessage?: string;
  };
}

/** Cause when an admitted-source identity left the inspected clause set (#5055). */
export const ADMITTED_SOURCE_IDENTITY_REMOVED_CAUSE = "admitted_source_identity_removed" as const;
/** Cause when the working-tree pin digest disagrees with live REST / merge-base (#5055). */
export const ADMITTED_SOURCE_DIGEST_MISMATCH_CAUSE = "admitted_source_digest_mismatch" as const;
/** Cause when digest comparison cannot reach live REST / forge (#5055). */
export const ADMITTED_SOURCE_DIGEST_UNAVAILABLE_CAUSE =
  "admitted_source_digest_unavailable" as const;
/**
 * Cause when a Spec-path brief that is not on the merge base has no source
 * record (#6333 item 5). The message names the re-ingest command.
 */
export const SPEC_PATH_SOURCE_RECORD_MISSING_CAUSE = "spec_path_source_record_missing" as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function captureFromNarrativesFlag(options: EvaluateVerifyAcOptions): boolean | undefined {
  return options.captureFromNarratives ?? (options.checkIntegrated === true ? false : undefined);
}

function ledgerEntriesFromCommands(
  commands: readonly {
    command: string;
    cwd?: string | null;
    expectedExitCode?: number;
    expectedStdout?: string | null;
  }[],
): AcceptanceLedgerEntry[] {
  return commands.map((c) => ({
    command: c.command,
    cwd: c.cwd ?? null,
    expectedExitCode: c.expectedExitCode ?? 0,
    expectedStdout: c.expectedStdout ?? null,
  }));
}

const CHECK_GRAPH_WRAPPERS = new Set(["task", "deft", "directive"]);
const PACKAGE_RUNNERS = new Set(["npm", "pnpm", "yarn", "npx", "bun"]);

/**
 * Command that would re-enter the containing check graph (#4798).
 * Contextual: only refused when verify:ac is check-integrated.
 * Does not globally denylist `task check` for standalone done-gate use.
 */
export function checkGraphReentryCommand(command: string): string | null {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let end = 0;
  while (end < trimmed.length && trimmed[end] !== " " && trimmed[end] !== "\t") {
    end += 1;
  }
  const first = trimmed.slice(0, end).toLowerCase();
  const rest = trimmed.slice(end).trim();
  let subEnd = 0;
  while (subEnd < rest.length && rest[subEnd] !== " " && rest[subEnd] !== "\t") {
    subEnd += 1;
  }
  const sub = rest.slice(0, subEnd).toLowerCase();
  if (CHECK_GRAPH_WRAPPERS.has(first) && (sub === "check" || sub === "verify:ac")) {
    return first + " " + sub;
  }
  if (PACKAGE_RUNNERS.has(first)) {
    const parts = rest.split(/\s+/).filter(Boolean);
    let i = 0;
    if ((parts[i] || "").toLowerCase() === "run") {
      i += 1;
    }
    const script = (parts[i] || "").toLowerCase();
    if (script === "check" || script === "verify:ac") {
      return first + (i > 0 ? " run " : " ") + script;
    }
  }
  if (first === "verify:ac") {
    return "verify:ac";
  }
  return null;
}

function checkIntegratedCycleRefuse(
  commands: readonly LiteralAcceptanceCommand[],
  projectRoot: string,
): LiteralAcceptanceGateResult | null {
  const hits: { command: LiteralAcceptanceCommand; reentry: string }[] = [];
  for (const command of commands) {
    const reentry = checkGraphReentryCommand(command.command);
    if (reentry !== null) {
      hits.push({ command, reentry });
    }
  }
  if (hits.length === 0) {
    return null;
  }
  const rejected: RejectedLiteralCommand[] = hits.map((hit) => ({
    command: hit.command.command,
    reason:
      "check-integrated cycle refuse (#4798): " +
      JSON.stringify(hit.command.command) +
      " re-enters the containing check graph (" +
      hit.reentry +
      "). Do not spawn.",
    sourceSpan: hit.command.sourceSpan ?? null,
  }));
  const runs = hits.map((hit) => {
    const reason =
      rejected.find((row) => row.command === hit.command.command)?.reason ??
      "check-integrated cycle refuse";
    return {
      command: hit.command.command,
      cwd: projectRoot,
      exitCode: 2,
      stdout: "",
      stderr: reason,
      ok: false,
      detail: "refused: " + reason,
    };
  });
  const lead = rejected[0]?.reason ?? "check-integrated cycle refuse (#4798)";
  return {
    ok: false,
    code: 1,
    message: "verify:ac FAILED (#3284): " + lead,
    commands: [...commands],
    runs,
    rejected,
  };
}

/** Refusal table ids of the #6886 warnings (warn mode). */
export const ACCEPTANCE_RECORD_ACTIVATE_REFUSAL_ID = "acceptance-record-activate";
export const ACCEPTANCE_CWD_GRAMMAR_REFUSAL_ID = "acceptance-cwd-grammar";

/** A record whose cwd is outside the plain relative-path grammar (warning only). */
export interface AcceptanceCwdWarning {
  readonly command: string;
  readonly cwd: string;
  readonly reason: string;
  readonly sourceSpan: string | null;
}

/** The one non-executing acceptance record list (#6886 item 4). */
export interface AcceptanceCommandRecords {
  /** Admitted records: the literal ledger, then filtered plan.acceptance.commands. */
  readonly commands: readonly LiteralAcceptanceCommand[];
  /** Records verify:ac refuses before any run (structured refusals). */
  readonly blocking: readonly RejectedLiteralCommand[];
  /** Prose-derived refusals, inline mentions and not-command dispositions (never block). */
  readonly advisory: readonly RejectedLiteralCommand[];
  readonly cwdWarnings: readonly AcceptanceCwdWarning[];
  /** Capture-only records with no promoted peer; verify:ac refuses them before any run. */
  readonly unpromoted: readonly LiteralAcceptanceCommand[];
  readonly transcriptPromptSkipped: number;
}

/**
 * One record list for scope:activate, xbrief:activate and verify:ac (#6886
 * item 4). Never runs a command. Reads the literal ledger through
 * `resolveLiteralAcceptanceDetailed` with the completion profile's options
 * unless the caller passes its own, so inline mentions and "not a command"
 * dispositions move to advisory exactly as verify:ac moves them. Adds the
 * `plan.acceptance.commands` records that pass `statedAcceptanceCommands`
 * (source `explicit`). Applies the one record rule to every record. Execution
 * grouping stays in `runLiteralAcceptanceCommands`.
 */
export function resolveAcceptanceCommandRecords(
  plan: Record<string, unknown>,
  options: {
    readonly captureFromNarratives?: boolean;
    /** Transient completion floor record (#7047); passes the same record rule. */
    readonly completionFloorRecord?: LiteralAcceptanceCommand;
  } = {},
): AcceptanceCommandRecords {
  const captureFromNarratives =
    options.captureFromNarratives ?? resolveAcceptanceGateProfile("complete").captureFromNarratives;
  const detailed = resolveLiteralAcceptanceDetailed(plan, { captureFromNarratives });
  const candidates: LiteralAcceptanceCommand[] = [...detailed.commands];
  if (asRecord(plan.acceptance) !== null) {
    for (const c of statedAcceptanceCommands(readPlanAcceptance(plan), plan)) {
      candidates.push({
        command: c.command,
        cwd: c.cwd ?? null,
        expectedStdout: c.expectedStdout ?? null,
        expectedExitCode: c.expectedExitCode ?? 0,
        source: "explicit",
        sourceSpan: "plan.acceptance.commands",
      });
    }
  }
  if (options.completionFloorRecord !== undefined) {
    candidates.push(options.completionFloorRecord);
  }
  const blocking: RejectedLiteralCommand[] = [];
  const blockingSeen = new Set<string>();
  const block = (row: RejectedLiteralCommand): void => {
    const key = `${row.command}\0${row.reason}`;
    if (blockingSeen.has(key)) return;
    blockingSeen.add(key);
    blocking.push(row);
  };
  for (const row of detailed.rejected) {
    block(row);
  }
  const commands: LiteralAcceptanceCommand[] = [];
  const cwdWarnings: AcceptanceCwdWarning[] = [];
  const cwdSeen = new Set<string>();
  for (const record of candidates) {
    const verdict = evaluateAcceptanceCommandRecord(record);
    if (!verdict.command.ok) {
      block({
        command: record.command,
        reason: verdict.command.reason ?? "unsafe command",
        sourceSpan: record.sourceSpan ?? null,
      });
      continue;
    }
    if (verdict.cwd.refused === true) {
      // #7223: a dependency or dot-folder cwd is refused before any run.
      block({
        command: record.command,
        reason: formatDeclaredRefusal({
          id: ACCEPTANCE_CWD_DEPENDENCY_REFUSAL_ID,
          detail: `acceptance command ${JSON.stringify(record.command)} has cwd ${JSON.stringify(String(record.cwd ?? "").trim())}: ${verdict.cwd.reason ?? ""}`,
        }).line,
        sourceSpan: record.sourceSpan ?? null,
      });
      continue;
    }
    commands.push(record);
    if (!verdict.cwd.ok) {
      const cwd = String(record.cwd ?? "").trim();
      const key = `${record.command}\0${cwd}`;
      if (cwdSeen.has(key)) continue;
      cwdSeen.add(key);
      cwdWarnings.push({
        command: record.command,
        cwd,
        reason: verdict.cwd.reason ?? "",
        sourceSpan: record.sourceSpan ?? null,
      });
    }
  }
  return {
    commands,
    blocking,
    advisory: detailed.advisoryRejected,
    cwdWarnings,
    unpromoted: findUnpromotedCaptureOnlyCommands(commands),
    transcriptPromptSkipped: detailed.transcriptPromptSkipped,
  };
}

/** The one cwd-grammar warning line, printed by activation and verify:ac alike. */
export function formatAcceptanceCwdWarningLine(warning: AcceptanceCwdWarning): string {
  return formatDeclaredRefusal({
    id: ACCEPTANCE_CWD_GRAMMAR_REFUSAL_ID,
    detail: `acceptance command ${JSON.stringify(warning.command)} has cwd ${JSON.stringify(warning.cwd)}: ${warning.reason}`,
  }).line;
}

/**
 * Activation warnings (#6886 item 6): one line per record verify:ac would
 * refuse before any run, per unpromoted capture and per cwd-grammar miss, each
 * with verify:ac's reason text. Activation never refuses on them.
 */
export function formatAcceptanceActivationWarnings(records: AcceptanceCommandRecords): string[] {
  const lines: string[] = [];
  for (const row of records.blocking) {
    const span =
      row.sourceSpan !== null && row.sourceSpan !== undefined ? ` @${row.sourceSpan}` : "";
    lines.push(
      formatDeclaredRefusal({
        id: ACCEPTANCE_RECORD_ACTIVATE_REFUSAL_ID,
        detail: `verify:ac would refuse ${JSON.stringify(row.command)}${span} before any run: ${row.reason}`,
      }).line,
    );
  }
  for (const c of records.unpromoted) {
    lines.push(
      formatDeclaredRefusal({
        id: ACCEPTANCE_RECORD_ACTIVATE_REFUSAL_ID,
        detail:
          `verify:ac would refuse the capture-only record ${formatUnpromotedCaptureOnlyRecord(c)} ` +
          `before any run: it has no agent-promoted peer. ${UNPROMOTED_CAPTURE_REMEDY.replace(/\n/g, " ")}`,
      }).line,
    );
  }
  for (const warning of records.cwdWarnings) {
    lines.push(formatAcceptanceCwdWarningLine(warning));
  }
  return lines;
}

function appendLines(message: string, lines: readonly string[]): string {
  if (lines.length === 0) return message;
  const block = lines.join("\n");
  return message.length > 0 ? `${message}\n${block}` : block;
}

/**
 * verify:ac over the one record list (#6886 item 5). A refused record stops the
 * run before anything is spawned. It keeps the existing refusal exit (1) and
 * its safety-rejected verdict (#3615); exit 2 stays the config / run-time
 * containment exit. Otherwise one `runLiteralAcceptanceCommands` call decides
 * what runs.
 */
function runAcceptanceCommandRecords(
  records: AcceptanceCommandRecords,
  options: {
    readonly projectRoot: string;
    readonly runner?: EvaluateVerifyAcOptions["runner"];
    readonly allowTaskStatement?: boolean;
  },
): LiteralAcceptanceGateResult {
  const warnings = records.cwdWarnings.map(formatAcceptanceCwdWarningLine);
  if (records.blocking.length > 0) {
    const message =
      `Literal acceptance-command gate FAILED (#3267): ${records.blocking.length} ` +
      `safety-rejected stated command(s) block completion until resolved ` +
      `(record a safe alternative only after reading it and confirming it runs only this ` +
      `repository's own tests, or remove it from the task statement); nothing was run (#6886).\n` +
      formatRejectedLedger(records.blocking);
    return {
      ok: false,
      code: 1,
      message: appendLiteralAcceptanceAdvisory(appendLines(message, warnings), records.advisory),
      commands: records.commands,
      runs: [],
      rejected: records.blocking,
      advisoryRejected: records.advisory,
      transcriptPromptSkipped: records.transcriptPromptSkipped,
    };
  }
  const run = runLiteralAcceptanceCommands(records.commands, {
    projectRoot: options.projectRoot,
    runner: options.runner,
    allowTaskStatement: options.allowTaskStatement,
  });
  return {
    ...run,
    rejected: run.rejected ?? [],
    advisoryRejected: records.advisory,
    transcriptPromptSkipped: records.transcriptPromptSkipped,
    message: appendLiteralAcceptanceAdvisory(appendLines(run.message, warnings), records.advisory),
  };
}

function resolveExecutableAcceptanceContract(
  plan: Record<string, unknown>,
  captureFromNarratives: boolean | undefined,
  completionFloorRecord?: LiteralAcceptanceCommand,
): {
  readonly commands: LiteralAcceptanceCommand[];
  readonly rejected: readonly RejectedLiteralCommand[];
  readonly records: AcceptanceCommandRecords;
} {
  const records = resolveAcceptanceCommandRecords(plan, {
    captureFromNarratives,
    ...(completionFloorRecord !== undefined ? { completionFloorRecord } : {}),
  });
  return { commands: [...records.commands], rejected: records.blocking, records };
}

function resolvedContractForHash(
  plan: Record<string, unknown>,
  options: EvaluateVerifyAcOptions,
): AcceptanceLedgerEntry[] {
  return ledgerEntriesFromCommands(
    resolveExecutableAcceptanceContract(
      plan,
      captureFromNarrativesFlag(options),
      options.completionFloorRecord,
    ).commands,
  );
}

function coerceSnapshotCommands(raw: readonly unknown[]): LiteralAcceptanceCommand[] {
  const out: LiteralAcceptanceCommand[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim().length > 0) {
      out.push({
        command: item.trim(),
        cwd: null,
        expectedStdout: null,
        expectedExitCode: 0,
        source: "verify_commands",
        sourceSpan: "bank.commands",
      });
      continue;
    }
    const rec = asRecord(item);
    if (rec === null || typeof rec.command !== "string" || rec.command.trim().length === 0) {
      continue;
    }
    const sourceRaw = typeof rec.source === "string" ? rec.source : "verify_commands";
    const source = isExecutableLiteralSource(sourceRaw)
      ? (sourceRaw as LiteralAcceptanceCommand["source"])
      : "verify_commands";
    out.push({
      command: rec.command.trim(),
      cwd: typeof rec.cwd === "string" ? rec.cwd : null,
      expectedStdout: typeof rec.expectedStdout === "string" ? rec.expectedStdout : null,
      expectedExitCode: typeof rec.expectedExitCode === "number" ? rec.expectedExitCode : 0,
      source,
      sourceSpan: typeof rec.sourceSpan === "string" ? rec.sourceSpan : "bank.commands",
    });
  }
  return out;
}

function tryReuseVerifyAc(
  plan: Record<string, unknown>,
  acceptance: PlanAcceptance,
  options: EvaluateVerifyAcOptions,
  projectRoot: string,
  contract: {
    readonly commands: readonly LiteralAcceptanceCommand[];
    readonly rejected: readonly RejectedLiteralCommand[];
  },
): VerifyAcResult | null {
  const mode = options.reuseMode ?? "auto";
  if (mode === "never") return null;
  if (contract.rejected.length > 0) return null;
  const currentLedger = ledgerEntriesFromCommands(contract.commands);
  const reuse = resolveAcReuse({
    projectRoot,
    plan,
    scopeId: options.bankScopeId,
    sessionId: options.sessionId,
    env: options.env,
    productPaths: options.productPaths,
    allowCache: mode === "auto",
    allowBank: true,
    resolvedAcceptanceContract: currentLedger,
    oracleScopeKey: options.oracleScopeKey,
  });
  if (reuse.kind === "miss") return null;

  if (reuse.kind === "cache") {
    const snap = reuse.cache.snapshot;
    const cachedAcceptance = readPlanAcceptance({ acceptance: snap.acceptance });
    return {
      ok: snap.ok,
      code: snap.code,
      message: options.quiet
        ? ""
        : snap.message.includes("served_from=")
          ? snap.message
          : `${snap.message} served_from=cache`,
      commands: snap.commands as VerifyAcResult["commands"],
      runs: snap.runs as VerifyAcResult["runs"],
      rejected: snap.rejected as VerifyAcResult["rejected"],
      sourceRung: acceptance.source_rung,
      noneStated: acceptance.none_stated,
      acceptance: cachedAcceptance.commands.length > 0 ? cachedAcceptance : acceptance,
      resolution: "verified-pass",
      resolvedCommandCount: snap.resolvedCommandCount,
      servedFrom: "cache",
    };
  }

  if (!Array.isArray(reuse.bank.runs)) return null;
  if (Array.isArray(reuse.bank.commands)) {
    const minted = coerceSnapshotCommands(reuse.bank.commands);
    if (!acceptanceLedgersEqual(currentLedger, readAcceptanceLedger(reuse.bank.commands))) {
      return null;
    }
    return {
      ok: true,
      code: 0,
      message: options.quiet
        ? ""
        : `verify:ac passed (#3284) served_from=bank [rung=${acceptance.source_rung}]`,
      commands: minted,
      runs: reuse.bank.runs as VerifyAcResult["runs"],
      sourceRung: acceptance.source_rung,
      noneStated: acceptance.none_stated,
      acceptance,
      resolution: "verified-pass",
      resolvedCommandCount: minted.length,
      servedFrom: "bank",
    };
  }

  const commandCount = acceptance.commands.length;
  if (commandCount === 0) return null;
  return {
    ok: true,
    code: 0,
    message: options.quiet
      ? ""
      : `verify:ac passed (#3284) served_from=bank [rung=${acceptance.source_rung}]`,
    commands: acceptance.commands.map((c) => ({
      command: c.command,
      cwd: c.cwd ?? null,
      expectedStdout: c.expectedStdout ?? null,
      expectedExitCode: c.expectedExitCode ?? 0,
      source: "explicit" as const,
      sourceSpan: "plan.acceptance.commands",
    })),
    runs: reuse.bank.runs as VerifyAcResult["runs"],
    sourceRung: acceptance.source_rung,
    noneStated: acceptance.none_stated,
    acceptance,
    resolution: "verified-pass",
    resolvedCommandCount: commandCount,
    servedFrom: "bank",
  };
}

function persistVerifyAcSessionCache(
  result: VerifyAcResult,
  options: EvaluateVerifyAcOptions,
  projectRoot: string,
  plan: Record<string, unknown>,
): void {
  if (!result.ok || result.resolution !== "verified-pass") return;
  // #6644: a walk with a granted set is a scope:complete result; verify:ac must not reuse it.
  if ((options.grantedClauses?.length ?? 0) > 0) return;
  const sessionId = resolveVerifyAcSessionId(options.env, options.sessionId);
  const resolvedScope = resolveScopeIdForAcReuse(plan, options.bankScopeId, {
    oracleScopeKey: options.oracleScopeKey,
  });
  if (sessionId === null || resolvedScope === null) return;
  const hashed = hashProductState({
    projectRoot,
    plan,
    productPaths: options.productPaths,
    resolvedAcceptanceContract: resolvedContractForHash(plan, options),
  });
  if (!hashed.complete) return;
  try {
    writeVerifyAcSessionCache({
      projectRoot,
      sessionId,
      scopeId: resolvedScope,
      productStateHash: hashed.digest,
      snapshot: snapshotFromReuseFields({
        ok: result.ok,
        code: result.code === 2 ? 2 : result.code === 1 ? 1 : 0,
        message: result.message,
        commands: result.commands,
        runs: result.runs,
        rejected: result.rejected,
        sourceRung: result.sourceRung,
        noneStated: result.noneStated,
        acceptance: result.acceptance,
        resolution: result.resolution,
        resolvedCommandCount: result.resolvedCommandCount,
      }),
    });
  } catch {
    // fail-open: missing cache must not fail a green run
  }
}

/**
 * Locate an active brief path for plan.id so plan-only readers can recover the
 * admitted-source pin from git (#5055). Prefer a unique match; never pick an
 * arbitrary peer when multiple active briefs share the same id.
 */
function findActiveBriefPathForPlan(
  projectRoot: string,
  plan: Record<string, unknown>,
): string | null {
  const planId = typeof plan.id === "string" && plan.id.trim() ? plan.id.trim() : null;
  if (planId === null) {
    return null;
  }
  const matches: string[] = [];
  for (const dirName of ["xbrief", "vbrief"] as const) {
    const active = join(projectRoot, dirName, "active");
    if (!existsSync(active)) {
      continue;
    }
    let names: string[] = [];
    try {
      names = readdirSync(active)
        .filter((n) => n.endsWith(".xbrief.json") || n.endsWith(".vbrief.json"))
        .sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const abs = join(active, name);
      try {
        const parsed = JSON.parse(readFileSync(abs, "utf8")) as unknown;
        const root = asRecord(parsed);
        const briefPlan = asRecord(root?.plan);
        if (briefPlan !== null && briefPlan.id === planId) {
          matches.push(abs);
        }
      } catch {
        // Skip unreadable peers; recovery is best-effort.
      }
    }
  }
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

/**
 * Resolve git admitted-source pin for plan evaluation (#5055).
 * Prefer options.xbriefPath; else a unique active/ match by plan.id. Ambiguous
 * id matches fail closed (no peer pin) — callers must pass xbriefPath.
 */
function resolveAdmittedSourceGitPin(
  plan: Record<string, unknown>,
  options: EvaluateVerifyAcOptions,
  projectRoot: string,
):
  | {
      readonly sentences: readonly string[];
      readonly digest: string | null;
      readonly source?: "merge-base" | "head";
    }
  | null
  | undefined {
  // Explicit null = looked up, absent — do not scan active/ again (#5055).
  if (options.admittedSourceMergeBase !== undefined) {
    // Options allow omitted digest; callers require string | null (#5055 / PR #5062).
    return options.admittedSourceMergeBase === null
      ? null
      : {
          sentences: options.admittedSourceMergeBase.sentences,
          digest: options.admittedSourceMergeBase.digest ?? null,
          // #6333: keep the pin's origin so a HEAD fallback is never read as the merge base.
          ...(options.admittedSourceMergeBase.source !== undefined
            ? { source: options.admittedSourceMergeBase.source }
            : {}),
        };
  }
  const hinted =
    typeof options.xbriefPath === "string" && options.xbriefPath.trim().length > 0
      ? resolve(projectRoot, options.xbriefPath.trim())
      : findActiveBriefPathForPlan(projectRoot, plan);
  if (hinted === null) {
    return undefined;
  }
  return loadAdmittedSourceFromGit(projectRoot, hinted);
}

/**
 * #6333 item 5: merge-base probe for a Spec-path plan evaluated by path hint
 * (scope:complete passes xbriefPath). An injected git pin keeps its own source.
 */
function resolveBriefOnMergeBase(
  plan: Record<string, unknown>,
  options: EvaluateVerifyAcOptions,
  projectRoot: string,
  gitPin?: { readonly source?: "merge-base" | "head" } | null,
): boolean | undefined {
  // #6609 item 7: a body-route brief whose only git pin is the HEAD fallback
  // also needs the merge-base probe, so its pin can be compared with the live body.
  const headPin = gitPin?.source === "head";
  if (!(planIsSpecPath(plan) || headPin) || options.admittedSourceMergeBase !== undefined) {
    return undefined;
  }
  const hinted =
    typeof options.xbriefPath === "string" && options.xbriefPath.trim().length > 0
      ? resolve(projectRoot, options.xbriefPath.trim())
      : findActiveBriefPathForPlan(projectRoot, plan);
  return hinted === null ? undefined : isBriefOnMergeBase(projectRoot, hinted);
}

/**
 * Evaluate product AC from an in-memory plan.
 */
export function evaluateVerifyAcFromPlan(
  planInput: Record<string, unknown>,
  options: EvaluateVerifyAcOptions = {},
): VerifyAcResult {
  const projectRootEarly = resolve(options.projectRoot ?? process.cwd());
  // #6204: a small-change lane brief is rechecked against its bound first.
  // No lane marker → no-op. Refusal names the one lane-exit remediation.
  const lane = evaluateSmallChangeLaneGate(planInput, {
    ...options.smallChangeLane,
    projectRoot: projectRootEarly,
    gate: "verify:ac",
    briefPath:
      typeof options.xbriefPath === "string" && options.xbriefPath.trim().length > 0
        ? resolve(projectRootEarly, options.xbriefPath.trim())
        : null,
  });
  if (!lane.ok) {
    const laneAcceptance = readPlanAcceptance(planInput);
    return applyOracle(
      {
        ok: false,
        code: 1,
        message: options.quiet === true ? "" : lane.message,
        commands: [],
        runs: [],
        sourceRung: laneAcceptance.source_rung,
        noneStated: laneAcceptance.none_stated,
        acceptance: laneAcceptance,
        resolution: "fail",
        resolvedCommandCount: 0,
      },
      options,
      planInput,
    );
  }
  // Completion / path walks pass xbriefPath — default a persist callback so
  // autofix restamps reach disk and mutate the caller's plan (#3920 Greptile).
  let persistAutofix = options.persistRequirementSourcesAutofix;
  const hintedPath =
    typeof options.xbriefPath === "string" && options.xbriefPath.trim().length > 0
      ? resolve(projectRootEarly, options.xbriefPath.trim())
      : null;
  if (persistAutofix === undefined && hintedPath !== null) {
    persistAutofix = (next) => {
      for (const key of Object.keys(planInput)) {
        delete planInput[key];
      }
      Object.assign(planInput, next);
      writeRequirementSourcesAutofixToXbrief(hintedPath, planInput, projectRootEarly);
    };
  }
  const sourcesVerdict = evaluateRequirementSourcesStaleness(planInput, projectRootEarly, {
    writePlan: persistAutofix,
  });
  if (!sourcesVerdict.ok) {
    const quiet = options.quiet === true;
    return applyOracle(
      {
        ok: false,
        code: 1,
        message: quiet
          ? ""
          : `${sourcesVerdict.message}\n  Remediation: ${sourcesVerdict.remediation}`,
        commands: [],
        runs: [],
        sourceRung: readPlanAcceptance(planInput).source_rung,
        noneStated: readPlanAcceptance(planInput).none_stated,
        acceptance: readPlanAcceptance(planInput),
        resolution: "fail",
        resolvedCommandCount: 0,
        sourcesRechecked: sourcesVerdict.sources_rechecked,
        sourcesChanged: sourcesVerdict.sources_changed,
      },
      options,
      planInput,
    );
  }
  const plan = sourcesVerdict.plan;
  const planId = typeof plan.id === "string" && plan.id.trim() ? plan.id.trim() : null;
  const admittedSourceMergeBase = resolveAdmittedSourceGitPin(plan, options, projectRootEarly);
  const briefOnMergeBase =
    options.briefOnMergeBase ??
    resolveBriefOnMergeBase(plan, options, projectRootEarly, admittedSourceMergeBase);
  const optionsWithScope: EvaluateVerifyAcOptions = {
    ...options,
    ...(briefOnMergeBase !== undefined ? { briefOnMergeBase } : {}),
    oracleScopeKey: options.oracleScopeKey?.trim() || planId || null,
    bankScopeId: options.bankScopeId?.trim() || planId || options.bankScopeId,
    observedAcceptance:
      options.observedAcceptance !== undefined ? options.observedAcceptance : plan.acceptance,
    ...(admittedSourceMergeBase !== undefined ? { admittedSourceMergeBase } : {}),
    requirementSourcesTelemetry: {
      sourcesRechecked: sourcesVerdict.sources_rechecked,
      sourcesChanged: sourcesVerdict.sources_changed,
      ...(sourcesVerdict.kind === "autofixed" && sourcesVerdict.message.length > 0
        ? { autofixMessage: sourcesVerdict.message }
        : {}),
    },
  };
  const acceptance = readPlanAcceptance(plan);
  const schemaErrors = validatePlanAcceptance(plan.acceptance ?? acceptance);
  // Only hard-fail schema when an explicit plan.acceptance object exists.
  // Non-noop stamp refusals stay on the per-command safety-reject path (#3615).
  // A schema-config stop would mis-label the remedy and skip safe peers.
  const schemaBlocks =
    plan.acceptance !== undefined &&
    schemaErrors.some((error) => error.startsWith("plan.acceptance") || isNoopRefusalReason(error));
  if (schemaBlocks) {
    const noop = schemaErrors.some((error) => isNoopRefusalReason(error));
    return applyOracle(
      {
        ok: false,
        code: noop ? 1 : 2,
        message: noop
          ? `verify:ac rejected-noop (#3396): ${schemaErrors.join("; ")}`
          : `verify:ac config error (#3284): ${schemaErrors.join("; ")}`,
        commands: [],
        runs: [],
        sourceRung: acceptance.source_rung,
        noneStated: acceptance.none_stated,
        acceptance,
        resolution: noop ? "rejected-noop" : "config",
        resolvedCommandCount: 0,
      },
      optionsWithScope,
      plan,
    );
  }

  const projectRoot = resolve(optionsWithScope.projectRoot ?? process.cwd());

  const attestationError = stampedAmbiguityAttestationError(
    optionsWithScope.observedAcceptance !== undefined
      ? optionsWithScope.observedAcceptance
      : plan.acceptance,
  );
  if (attestationError !== null) {
    return applyOracle(
      {
        ok: false,
        code: 2,
        message: optionsWithScope.quiet === true ? "" : attestationError.message,
        commands: [],
        runs: [],
        sourceRung: acceptance.source_rung,
        noneStated: acceptance.none_stated,
        acceptance,
        resolution: "config",
        resolvedCommandCount: 0,
        cause: attestationError.cause ?? MISSING_AMBIGUITY_ATTESTATION_CAUSE,
      },
      optionsWithScope,
      plan,
    );
  }

  const contract = resolveExecutableAcceptanceContract(
    plan,
    captureFromNarrativesFlag(optionsWithScope),
    optionsWithScope.completionFloorRecord,
  );
  // #6886 item 5: a refused record stops verify:ac before anything runs.
  if (contract.records.blocking.length > 0) {
    return applyOracle(
      annotate(
        runAcceptanceCommandRecords(contract.records, { projectRoot }),
        acceptance,
        optionsWithScope.quiet,
      ),
      optionsWithScope,
      plan,
    );
  }
  // Check-integrated verify:ac must not spawn an acceptance command that re-enters
  // task check / verify:ac (#4798). Standalone done-gate still may run task check.
  // --allow-vbrief-drift is release mismatch-policy only; it does not authorize
  // executing drifted leftover AC while this gate sits first.
  if (optionsWithScope.checkIntegrated === true) {
    const cycle = checkIntegratedCycleRefuse(contract.commands, projectRoot);
    if (cycle !== null) {
      return applyOracle(
        annotate(cycle, acceptance, optionsWithScope.quiet),
        optionsWithScope,
        plan,
      );
    }
  }
  const reused = tryReuseVerifyAc(plan, acceptance, optionsWithScope, projectRoot, contract);
  if (reused !== null) {
    return applyOracle(reused, optionsWithScope, plan);
  }

  // One record list, one run (#6886 items 4-5): the literal ledger and the
  // filtered plan.acceptance.commands run through one runLiteralAcceptanceCommands
  // call, whose promotion matching and execution-key grouping decide what runs.
  // A plan record is no longer skipped because a metadata record ran.
  const base = runAcceptanceCommandRecords(contract.records, {
    projectRoot,
    runner: optionsWithScope.runner,
    allowTaskStatement: optionsWithScope.allowTaskStatement,
  });

  // Check composition: mid-story unpromoted capture-only may soft-pass so the
  // framework graph is not deadlocked before agents promote peers.
  // Greptile P1 #3284: safety-rejected stated commands NEVER soft-pass — they
  // block product verification until a safe alternative is promoted.
  if (optionsWithScope.checkIntegrated === true && !base.ok && base.runs.length === 0) {
    const hasRejected = (base.rejected?.length ?? 0) > 0;
    if (hasRejected) {
      return applyOracle(
        annotate(base, acceptance, optionsWithScope.quiet),
        optionsWithScope,
        plan,
      );
    }
    // The run refuses capture-only records exactly when the shared list has
    // unpromoted ones; the message is not sniffed (cwd warning lines name
    // `verify:ac --capture-only`).
    const unpromoted =
      contract.records.unpromoted.length > 0 ||
      (base.commands.length > 0 && base.commands.every((c) => c.source === "task_statement"));
    if (unpromoted || base.commands.length === 0) {
      return applyOracle(
        {
          ok: true,
          code: 0,
          message: optionsWithScope.quiet
            ? ""
            : `verify:ac advisory (#3284 check-integrated): no executable AC peers yet ` +
              `(capture-only / empty). Done-gate standalone verify:ac still requires promotion. ` +
              `[rung=${acceptance.source_rung}]\n` +
              base.message,
          commands: base.commands,
          runs: [],
          rejected: base.rejected,
          sourceRung: acceptance.source_rung,
          noneStated: acceptance.none_stated,
          acceptance,
          resolution: classifyResolution({
            ok: true,
            code: 0,
            runsLength: 0,
            commandCount: base.commands.length,
            rejectedCount: base.rejected?.length ?? 0,
          }),
          resolvedCommandCount: base.commands.length,
        },
        optionsWithScope,
        plan,
      );
    }
  }

  return applyOracle(annotate(base, acceptance, optionsWithScope.quiet), optionsWithScope, plan);
}

function hasNonDefaultAcceptanceContext(command: PlanAcceptance["commands"][number]): boolean {
  const cwd = command.cwd !== undefined && command.cwd !== null && String(command.cwd).trim();
  const stdout =
    command.expectedStdout !== undefined &&
    command.expectedStdout !== null &&
    String(command.expectedStdout).length > 0;
  const exit = typeof command.expectedExitCode === "number" && command.expectedExitCode !== 0;
  return Boolean(cwd) || stdout || exit;
}

function hasStructuredAcceptancePeer(plan: Record<string, unknown>, command: string): boolean {
  return readStoredLiteralAcceptanceCommands(plan).some(
    (c) => c.command === command && isExecutableLiteralSource(c.source),
  );
}

/**
 * True when a plan.acceptance.commands row is only an ingest copy of an inline
 * prose mention (or an operator not-command disposition) and has no structured
 * peer. Independently authored rows — promoted verify_commands, or a command
 * with its own cwd/expectedStdout/exit — still run (#3721 Greptile).
 */
function isInlineScrapedAcceptanceCommand(
  plan: Record<string, unknown>,
  command: PlanAcceptance["commands"][number],
): boolean {
  if (hasNonDefaultAcceptanceContext(command)) return false;
  if (hasStructuredAcceptancePeer(plan, command.command)) return false;
  if (readNotAcceptanceCommands(plan).has(command.command)) return true;
  return hasStoredInlineMention(plan, command.command);
}

/**
 * True when the stored literal ledger has an inline-mention row for `command`.
 * Reads the raw rows: a mention that the command grammar refuses is still a
 * mention, and its plan.acceptance copy is dropped, not run (GHSA-mq3j-2229-p7xx).
 */
function hasStoredInlineMention(plan: Record<string, unknown>, command: string): boolean {
  const metadata = asRecord(plan.metadata);
  const rows = metadata?.literal_acceptance_commands ?? metadata?.literalAcceptanceCommands;
  if (!Array.isArray(rows)) return false;
  return rows.some((row) => {
    const rec = asRecord(row);
    if (rec === null || typeof rec.command !== "string" || rec.command.trim() !== command.trim()) {
      return false;
    }
    return isInlineProseMention({
      source: typeof rec.source === "string" ? rec.source : undefined,
      sourceSpan: typeof rec.sourceSpan === "string" ? rec.sourceSpan : null,
    });
  });
}

/** plan.acceptance.commands minus ingest-copied inline mentions (#3721). */
function statedAcceptanceCommands(
  acceptance: PlanAcceptance,
  plan: Record<string, unknown>,
): PlanAcceptance["commands"] {
  return acceptance.commands.filter((c) => !isInlineScrapedAcceptanceCommand(plan, c));
}

function classifyResolution(input: {
  readonly ok: boolean;
  readonly code: number;
  readonly runsLength: number;
  readonly commandCount: number;
  readonly rejectedCount: number;
  readonly resolution?: VerifyAcResolution;
}): VerifyAcResolution {
  if (input.resolution !== undefined) {
    return input.resolution;
  }
  if (input.code === 2) {
    return "config";
  }
  if (!input.ok) {
    return "fail";
  }
  if (input.runsLength > 0) {
    return "verified-pass";
  }
  if (isEmptyAcResolution(input)) {
    return "empty-pass";
  }
  return "empty-pass";
}

function applyEmptyFloorPolicy(
  result: VerifyAcResult,
  options: EvaluateVerifyAcOptions,
): VerifyAcResult {
  if (
    !isEmptyAcResolution({
      ok: result.ok,
      code: result.code,
      runsLength: result.runs.length,
      commandCount: Math.max(result.commands.length, result.acceptance.commands.length),
      rejectedCount: result.rejected?.length ?? 0,
      resolution: result.resolution,
      clauseCount: Math.max(
        result.acceptance.clauses?.length ?? 0,
        result.clauseOutcomes?.length ?? 0,
      ),
    })
  ) {
    return result;
  }
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const suiteFloor = options.hasSuiteFloor ?? projectHasSuiteFloor(projectRoot);
  const skippedPrompts = result.transcriptPromptSkipped ?? 0;
  if (suiteFloor && skippedPrompts > 0) {
    return {
      ...result,
      ok: false,
      code: 1,
      message: options.quiet === true ? "" : formatTranscriptEmptyMessage(result.acceptance),
      resolution: "fail",
      resolvedCommandCount: 0,
    };
  }
  if (suiteFloor) {
    return {
      ...result,
      resolution: "empty-pass",
      resolvedCommandCount: 0,
    };
  }
  return {
    ...result,
    ok: false,
    code: 1,
    message: formatSoftEmptyMessage(result.acceptance),
    resolution: "soft_empty",
    resolvedCommandCount: 0,
  };
}

function acceptanceOutcomeOf(result: VerifyAcResult): AcceptanceRunSummaryOutcome {
  if (result.resolution === "verified-pass") return "verified-pass";
  if (result.resolution === "empty-pass") return "empty-pass";
  if (result.resolution === "soft_empty") return "soft_empty";
  if (result.resolution === "fail") return "fail";
  if (result.resolution === "config") return "config-error";
  if (result.resolution === "rejected-noop") return "rejected-noop";
  return "soft-missing";
}

function emitAcceptanceObservedStamp(options: EvaluateVerifyAcOptions, projectRoot: string): void {
  if (options.env === undefined) {
    return;
  }
  const dest = options.env[ENV_RUN_SUMMARY_PATH];
  if (dest === undefined || dest.trim().length === 0) {
    return;
  }
  emitAcceptanceStampFromPlan(projectRoot, { acceptance: options.observedAcceptance }, options.env);
}

function emitAcceptanceOutcome(
  result: VerifyAcResult,
  options: EvaluateVerifyAcOptions,
  projectRoot: string,
): void {
  if (options.env === undefined) {
    return;
  }
  const dest = options.env[ENV_RUN_SUMMARY_PATH];
  if (dest === undefined || dest.trim().length === 0) {
    return;
  }
  try {
    const emitter = new RunSummaryEmitter({
      projectRoot,
      sessionId: options.sessionId,
      env: options.env,
      component: "verify-ac",
    });
    emitter.emitAcceptance({
      resolved_command_count: result.resolvedCommandCount,
      outcome: acceptanceOutcomeOf(result),
      source_rung: result.sourceRung,
      none_stated: result.noneStated,
      clause_count: result.clauseOutcomes?.length,
      clause_outcomes: result.clauseOutcomes?.map((row) => ({
        id: row.id,
        outcome: row.outcome,
      })),
      served_from: result.servedFrom ?? "executed",
      ...(result.cause !== undefined ? { cause: result.cause } : {}),
      ...(result.behavioralClauseCount !== undefined
        ? { behavioral_clause_count: result.behavioralClauseCount }
        : {}),
      ...(result.unmappedSentenceCount !== undefined
        ? { unmapped_sentence_count: result.unmappedSentenceCount }
        : {}),
      ...(result.sourcesRechecked !== undefined
        ? { sources_rechecked: result.sourcesRechecked }
        : {}),
      ...(result.sourcesChanged !== undefined ? { sources_changed: result.sourcesChanged } : {}),
      miss_reason: (result.servedFrom ?? "executed") === "executed" ? result.missReason : undefined,
    });
  } catch {
    // fail-open
  }
}

/** Outcome on every terminal path; stamp from observed plan.acceptance (#3355). */
function emitAcceptanceTelemetry(
  result: VerifyAcResult,
  options: EvaluateVerifyAcOptions,
  projectRoot: string,
): void {
  emitAcceptanceObservedStamp(options, projectRoot);
  emitAcceptanceOutcome(result, options, projectRoot);
}

/**
 * CLI-only early returns that never reach evaluate still emit an acceptance
 * outcome so field streams see config-error / soft-missing (#3355).
 */
export function emitVerifyAcTerminalOutcome(input: {
  readonly projectRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly outcome: AcceptanceRunSummaryOutcome;
  readonly sourceRung?: AcSourceRung;
  readonly noneStated?: boolean;
}): void {
  emitAcceptanceOutcome(
    {
      ok:
        input.outcome !== "config-error" &&
        input.outcome !== "fail" &&
        input.outcome !== "rejected-noop",
      code:
        input.outcome === "config-error"
          ? 2
          : input.outcome === "fail" || input.outcome === "rejected-noop"
            ? 1
            : 0,
      message: "",
      commands: [],
      runs: [],
      sourceRung: input.sourceRung ?? "project_floor",
      noneStated: input.noneStated ?? true,
      acceptance: {
        commands: [],
        none_stated: input.noneStated ?? true,
        source_rung: input.sourceRung ?? "project_floor",
      },
      resolution:
        input.outcome === "config-error"
          ? "config"
          : input.outcome === "soft-missing"
            ? "skipped"
            : input.outcome === "fail"
              ? "fail"
              : input.outcome === "rejected-noop"
                ? "rejected-noop"
                : input.outcome === "soft_empty"
                  ? "soft_empty"
                  : input.outcome === "verified-pass"
                    ? "verified-pass"
                    : "empty-pass",
      resolvedCommandCount: 0,
    },
    { projectRoot: input.projectRoot, env: input.env },
    resolve(input.projectRoot),
  );
}

function applyClauseWalk(
  result: VerifyAcResult,
  options: EvaluateVerifyAcOptions,
  plan: Record<string, unknown>,
): VerifyAcResult {
  const clauses = result.acceptance.clauses ?? [];
  if (clauses.length === 0 || result.resolution === "config" || result.resolution === "skipped") {
    return result;
  }
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  // #6644: a clause stamped from a grant in this run is left out of the walk, so
  // it is not walked, failed, unverified or verified. It stays in the brief.
  const granted = (options.grantedClauses ?? []).filter((g) =>
    clauses.some((clause) => clause.id === g.id),
  );
  const grantedIds = new Set(granted.map((g) => g.id));
  // #3835: the walk reads files, so it reads only what this brief declared.
  const report = walkAcceptanceClauses(
    clauses.filter((clause) => !grantedIds.has(clause.id)),
    projectRoot,
    { declaredScope: readDeclaredArtifactScope(plan) },
  );
  // #6374 item 4: context note on verified rows whose file is unchanged since the
  // commit before this brief entered its folder. Display only: outcomes, counts,
  // the lead and the exit code below are all computed from `report`.
  const walkMessage = options.quiet
    ? result.message
    : formatClauseWalkMessage(
        annotateUnchangedSinceEntry(report, { projectRoot, xbriefPath: options.xbriefPath }),
        result.message,
      );
  const message =
    options.quiet || granted.length === 0
      ? walkMessage
      : [
          `verify:ac clause walk (#6644): ${granted.length} granted (left out of the counts above)`,
          ...granted.map(
            (g) =>
              `  [granted] clause ${g.id}: ${g.disposition} — ${g.reason.replace(/\s+/g, " ")}`,
          ),
          walkMessage,
        ].join("\n");
  // #3497: a clause the static walk cannot decide is evidence of nothing. It blocks
  // only when nothing else verified the product; a green executable acceptance run
  // already is the product-first oracle. Failed clauses still block unconditionally.
  const blocked = clauseWalkBlocks({
    failed: report.failed.length,
    walked: report.clauses.length,
    adjudicableUnverified: countUnverifiedAdjudicableClauses(report.clauses),
    hasGreenExecutableRun:
      result.ok && result.runs.length > 0 && result.runs.every((run) => run.ok),
  });
  const ok = result.ok && !blocked;
  return {
    ...result,
    ok,
    code: ok ? result.code : result.code === 2 ? 2 : 1,
    message,
    // #3835: only a clause that actually verified may relabel an empty pass as
    // verified. A walk that verified nothing has not verified anything.
    resolution: ok
      ? result.resolution === "empty-pass" && report.verified.length > 0
        ? "verified-pass"
        : result.resolution
      : "fail",
    clauseOutcomes: report.clauses,
    clauseWalked: true,
    ...(granted.length > 0 ? { clauseGranted: granted.length } : {}),
  };
}

function applyRejectedNoop(result: VerifyAcResult): VerifyAcResult {
  if (result.resolution === "rejected-noop") {
    return result;
  }
  const rejected = result.rejected ?? [];
  const fromLedger = rejected.some((row) => isNoopRefusalReason(row.reason));
  const fromRuns = result.runs.some(
    (row) => !row.ok && isNoopRefusalReason(row.detail.replace(/^refused:\s*/i, "")),
  );
  // #3484 / #3497: the advisory block quotes refusal reasons that were deliberately
  // demoted because the plan states structured acceptance commands. Sniffing the
  // rendered message resurrected them as a blocking no-op verdict — verify:ac
  // refused while its own output said "do NOT block". Read the blocking ledgers,
  // and inspect only the non-advisory part of the message.
  const fromMessage = isNoopRefusalReason(stripLiteralAcceptanceAdvisory(result.message));
  if (!fromLedger && !fromRuns && !fromMessage) {
    return result;
  }
  return {
    ...result,
    ok: false,
    code: result.code === 2 ? 2 : 1,
    resolution: "rejected-noop",
  };
}

/**
 * Make the rendered message agree with the verdict (#3497).
 *
 * `annotate` stamps "verify:ac passed" from the sub-gate result, but later stages
 * (clause walk, no-op ledger, oracle integrity) can still flip `ok`. The old output
 * left the stale "passed" lead in place, so scope:complete printed four passing lines
 * and then refused. Re-label the lead and name the deciding predicate.
 */
function labelVerdict(result: VerifyAcResult): string {
  const verdict = resolveAcceptanceVerdict(result);
  if (verdict.ok) {
    return relabelVerifyAcPassLead(result);
  }
  const relabelled = result.message.replace(
    /verify:ac passed \(#3284\)/g,
    "verify:ac FAILED (#3284)",
  );
  const line = formatAcceptanceVerdict(verdict);
  return relabelled.length > 0 ? `${relabelled}\n${line}` : line;
}

function applyOracle(
  result: VerifyAcResult,
  options: EvaluateVerifyAcOptions,
  plan: Record<string, unknown> = {},
): VerifyAcResult {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const walked = applyClauseWalk(applyRejectedNoop(result), options, plan);
  // #3835: a verified row may relabel empty-pass as verified-pass (applyClauseWalk).
  // #4240: a walked clause set is not empty acceptance — even when nothing
  // verified. applyEmptyFloorPolicy (#3334) still owns empty clauses[].
  const gated = walked.clauseWalked === true ? walked : applyEmptyFloorPolicy(walked, options);
  // Emit/read disk only when the caller supplied env (CLI passes process.env).
  // Tests stay isolated unless they opt in with env or runSummaryText.
  if (options.env !== undefined) {
    emitVerifyAcAttempts({
      projectRoot,
      runs: gated.runs,
      env: options.env,
      scopeKey: options.oracleScopeKey,
    });
  }
  let next = gated;
  if (options.applyOracleIntegrity !== false) {
    const verdict = evaluateProductOracleIntegrity({
      projectRoot,
      runSummaryText: options.runSummaryText,
      env: options.env,
    });
    next = mergeOracleVerdict(gated, verdict);
    if (
      !verdict.ok &&
      next.resolution !== "soft_empty" &&
      next.resolution !== "config" &&
      next.resolution !== "rejected-noop"
    ) {
      next = { ...next, resolution: "fail" };
    }
  }
  next = applyStatementSentenceFloor(next, plan, options);
  const servedFrom = next.servedFrom ?? "executed";
  let missReason = next.missReason;
  if (servedFrom === "executed" && (missReason === undefined || missReason.length === 0)) {
    const reuse = resolveAcReuse({
      projectRoot,
      plan,
      scopeId: options.bankScopeId,
      sessionId: options.sessionId,
      env: options.env,
      productPaths: options.productPaths,
      allowCache: (options.reuseMode ?? "auto") === "auto",
      allowBank: true,
      resolvedAcceptanceContract: resolvedContractForHash(plan, options),
      oracleScopeKey: options.oracleScopeKey,
    });
    if (reuse.kind === "miss") missReason = reuse.reason;
  }
  const telemetry = options.requirementSourcesTelemetry;
  const withSources: VerifyAcResult = {
    ...next,
    message: options.quiet === true ? next.message : labelVerdict(next),
    servedFrom,
    missReason: servedFrom === "executed" ? missReason : undefined,
    ...(telemetry !== undefined
      ? {
          sourcesRechecked: telemetry.sourcesRechecked,
          sourcesChanged: telemetry.sourcesChanged,
        }
      : {}),
  };
  const stamped: VerifyAcResult =
    options.quiet === true ||
    telemetry?.autofixMessage === undefined ||
    telemetry.autofixMessage.length === 0
      ? withSources
      : {
          ...withSources,
          message:
            withSources.message.trim().length > 0
              ? `${telemetry.autofixMessage}\n${withSources.message}`
              : telemetry.autofixMessage,
        };
  persistVerifyAcSessionCache(stamped, options, projectRoot, plan);
  if (options.skipAcceptanceEmit !== true) {
    emitAcceptanceTelemetry(stamped, options, projectRoot);
  }
  return stamped;
}

function formatUnmappedSentenceFloor(unmapped: readonly string[]): string {
  return [
    `verify:ac sentence floor (#3550): ${unmapped.length} statement sentence(s) are neither a clause nor an explicit confession`,
    ...unmapped.map((text) => `  - ${text}`),
  ].join("\n");
}

function joinFloorMessage(floor: string, prior: string): string {
  if (prior.trim().length === 0) {
    return floor;
  }
  return `${floor}\n${prior}`;
}

function asPlanRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/**
 * Narrative text the production stamp reads. A generated brief carries this
 * body. A bare title or an evidence item is not that body (#3550).
 */
function planCarriesNarrativeStatement(plan: Record<string, unknown>): boolean {
  const narratives = asPlanRecord(plan.narratives);
  if (narratives === null) {
    return false;
  }
  for (const key of STATEMENT_SENTENCE_NARRATIVE_KEYS) {
    const value = narratives[key];
    if (typeof value === "string" && /[A-Za-z]/.test(value)) {
      return true;
    }
  }
  return false;
}

function walkedClauseCount(walked: unknown): number {
  const clauses = asPlanRecord(walked)?.clauses;
  return Array.isArray(clauses) ? clauses.length : 0;
}

/**
 * The sentence list the floor checks. A stored list wins. A generated brief
 * that has clauses and narrative statement text, but has not stored a list,
 * still goes through the production stamp (#3550).
 */
function acceptanceForSentenceFloor(plan: Record<string, unknown>, walked: unknown): unknown {
  const current = plan.acceptance ?? walked;
  const stored = asPlanRecord(plan.acceptance);
  if (stored !== null && Object.hasOwn(stored, "sentences") && stored.sentences !== undefined) {
    return stored;
  }
  if (walkedClauseCount(walked) === 0 || !planCarriesNarrativeStatement(plan)) {
    return current;
  }
  try {
    const stamped = stampAcceptanceFromLiteralCapture(plan);
    if (stamped.acceptance !== undefined) {
      return stamped.acceptance;
    }
  } catch {
    // A safety refusal is already the walk verdict. Do not replace it with a throw.
  }
  return current;
}

function normalizeIdentityText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function formatMissingAdmittedIdentities(missing: readonly string[]): string {
  return [
    `verify:ac admitted-source identity (#5055): ${missing.length} identity(ies) removed from the inspected clause set`,
    "Confession is not restoration; restore as a same-text clause or amend via authz:grant (#3110).",
    ...missing.map((text) => `  - ${text}`),
  ].join("\n");
}

/**
 * Spec-path briefs persist the refused GitHub body under plan.metadata.issueBody
 * (#4524 / #5055), including empty string when the origin body was empty.
 */
function planHasSpecPathRefusedBody(plan: Record<string, unknown>): boolean {
  const meta = asRecord(plan.metadata);
  if (meta === null) {
    return false;
  }
  return Object.hasOwn(meta, "issueBody") && typeof meta.issueBody === "string";
}

/** Spec-path brief: refused-body metadata or a Spec-path source record (#6333). */
function planIsSpecPath(plan: Record<string, unknown>): boolean {
  if (planHasSpecPathRefusedBody(plan)) {
    return true;
  }
  const meta = asRecord(plan.metadata);
  return meta !== null && Object.hasOwn(meta, SPEC_PATH_SOURCE_KEY);
}

/**
 * Is the brief on the merge base (#6333 item 5)? An explicit probe wins. Else a
 * git pin counts only when it came from the merge base, never from the HEAD
 * fallback the loader uses for branch-only briefs.
 */
function specPathBriefOnMergeBase(options: EvaluateVerifyAcOptions): boolean {
  if (options.briefOnMergeBase !== undefined) {
    return options.briefOnMergeBase;
  }
  const mergeBase = options.admittedSourceMergeBase;
  if (mergeBase === undefined || mergeBase === null || mergeBase.sentences.length === 0) {
    return false;
  }
  return (mergeBase.source ?? "merge-base") === "merge-base";
}

/**
 * #6609 item 7: a body-route brief that is not on the merge base and whose git
 * pin is the HEAD fallback. Its pin is branch-local, so it is compared with the
 * live issue body, re-read by the extractor version stored on the pin.
 */
function isUnlandedBodyRouteHeadPin(
  plan: Record<string, unknown>,
  options: EvaluateVerifyAcOptions,
): boolean {
  const pin = options.admittedSourceMergeBase;
  return (
    !planIsSpecPath(plan) &&
    pin !== undefined &&
    pin !== null &&
    pin.source === "head" &&
    options.briefOnMergeBase === false
  );
}

/** Issue number of the brief's origin reference, for the re-ingest command. */
function originIssueNumber(plan: Record<string, unknown>): string {
  const refs = Array.isArray(plan.references) ? plan.references : [];
  for (const entry of refs) {
    const row = asRecord(entry);
    if (row?.type === "x-xbrief/github-issue" && typeof row.uri === "string") {
      const match = /\/issues\/(\d+)/.exec(row.uri);
      if (match?.[1] !== undefined) {
        return match[1];
      }
    }
  }
  return "<issue>";
}

/**
 * A Spec-path brief that is not on the merge base (#6333 items 4 and 5). With no
 * source record it fails and names the re-ingest command. With a record its pin
 * is compared with the cited lean, resolved through the completed-arc record of
 * the source issue.
 */
function resolveUnlandedSpecPathIdentities(
  plan: Record<string, unknown>,
  options: EvaluateVerifyAcOptions,
):
  | {
      readonly ok: true;
      readonly identities: readonly string[];
      readonly digest: string | null;
      readonly compareLiveDigest: boolean;
    }
  | { readonly ok: false; readonly cause: string; readonly message: string } {
  const record = readSpecPathSourceRecord(plan);
  if (record === null) {
    const issue = originIssueNumber(plan);
    return {
      ok: false,
      cause: SPEC_PATH_SOURCE_RECORD_MISSING_CAUSE,
      message:
        "verify:ac Spec-path source record (#6333): this Spec-path brief is not on the merge base " +
        "and has no source record, so its pin cannot be checked against the accepted lean. " +
        `Ingest it again: task issue:ingest -- ${issue} (remove this working-tree copy first).`,
    };
  }
  const fetchLive = options.fetchSpecPathLiveIdentities ?? fetchSpecPathLiveIdentities;
  const live = fetchLive(record);
  if (!live.ok) {
    return {
      ok: false,
      cause:
        live.kind === "mismatch"
          ? ADMITTED_SOURCE_DIGEST_MISMATCH_CAUSE
          : ADMITTED_SOURCE_DIGEST_UNAVAILABLE_CAUSE,
      message: `verify:ac Spec-path live compare (#6333): ${live.reason}`,
    };
  }
  const identities = live.identities.map(normalizeIdentityText);
  const liveDigest = digestAdmittedSourceSentences(identities);
  const working = readAdmittedSourceSentences(plan.acceptance);
  const recordedDigest = readAdmittedSourceDigest(plan.acceptance);
  const workingDigest =
    working !== null ? digestAdmittedSourceSentences(working.map(normalizeIdentityText)) : null;
  if (
    (workingDigest !== null && workingDigest !== liveDigest) ||
    (recordedDigest !== null && recordedDigest !== liveDigest)
  ) {
    return {
      ok: false,
      cause: ADMITTED_SOURCE_DIGEST_MISMATCH_CAUSE,
      message:
        `verify:ac Spec-path live compare (#6333): the brief's pin disagrees with lean ` +
        `${record.leanCommentId} of #${record.issue}`,
    };
  }
  return { ok: true, identities, digest: liveDigest, compareLiveDigest: false };
}

/**
 * Resolve the authoritative admitted-source identity list (#5055).
 * Prefer git pin (merge-base / HEAD) when supplied, else working-tree pin, else
 * live admitted-source extract. Empty / deleted working-tree pins do not remint
 * from live narratives. Spec-path recovery must not admit the refused raw body.
 */
function resolveAdmittedSourceIdentities(
  plan: Record<string, unknown>,
  options: EvaluateVerifyAcOptions,
):
  | {
      readonly ok: true;
      readonly identities: readonly string[];
      readonly digest: string | null;
      /** Live digest check applies only to a working-tree pin (#5055). */
      readonly compareLiveDigest: boolean;
    }
  | { readonly ok: false; readonly cause: string; readonly message: string } {
  const mergeBase = options.admittedSourceMergeBase;
  // #6333 item 5: the boundary is the merge base. A Spec-path brief that is not
  // on it must carry a source record and is compared with the cited lean; the
  // HEAD-fallback pin is not proof that the brief is on the merge base.
  if (planIsSpecPath(plan) && !specPathBriefOnMergeBase(options)) {
    return resolveUnlandedSpecPathIdentities(plan, options);
  }
  if (mergeBase !== undefined && mergeBase !== null && mergeBase.sentences.length > 0) {
    const identities = mergeBase.sentences.map(normalizeIdentityText);
    return {
      ok: true,
      identities,
      digest:
        typeof mergeBase.digest === "string" && mergeBase.digest.trim().length > 0
          ? mergeBase.digest.trim()
          : digestAdmittedSourceSentences(identities),
      // A merge-base pin is the ingest-recorded reference — no live compare.
      // A HEAD-sourced pin of a body-route brief that is not on the merge base
      // is only branch-local, so a committed trim must not prove itself (#6609
      // item 7): it is compared with the live body like a working pin.
      compareLiveDigest: isUnlandedBodyRouteHeadPin(plan, options),
    };
  }

  const working = readAdmittedSourceSentences(plan.acceptance);
  if (working !== null) {
    return {
      ok: true,
      identities: working,
      digest: readAdmittedSourceDigest(plan.acceptance),
      compareLiveDigest: true,
    };
  }

  const recordedDigest = readAdmittedSourceDigest(plan.acceptance);
  const specPath = planHasSpecPathRefusedBody(plan);

  // Pin deleted / emptied: recover from the admitted live source when no git pin.
  if (options.fetchAdmittedSourceText !== undefined) {
    const fetched = options.fetchAdmittedSourceText();
    if (!fetched.ok) {
      return {
        ok: false,
        cause: ADMITTED_SOURCE_DIGEST_UNAVAILABLE_CAUSE,
        message: `verify:ac admitted-source digest (#5055): ${fetched.reason}`,
      };
    }
    // Same quarantine-aware extract as the first-ingest pin (#5055 P1), read
    // with the extractor version stored on the pin (#6609 item 4).
    const identities = extractAdmittedSourceIdentitiesWithVersion(
      fetched.text,
      readAdmittedSourceExtractor(plan.acceptance),
    ).map(normalizeIdentityText);
    if (identities.length === 0) {
      if (recordedDigest !== null) {
        return {
          ok: false,
          cause: ADMITTED_SOURCE_DIGEST_MISMATCH_CAUSE,
          message:
            "verify:ac admitted-source digest (#5055): recovered source is empty but a digest remains",
        };
      }
      return { ok: true, identities: [], digest: null, compareLiveDigest: false };
    }
    const liveDigest = digestAdmittedSourceSentences(identities);
    if (recordedDigest !== null && liveDigest !== recordedDigest) {
      return {
        ok: false,
        cause: ADMITTED_SOURCE_DIGEST_MISMATCH_CAUSE,
        message:
          "verify:ac admitted-source digest (#5055): recovered source disagrees with the recorded digest",
      };
    }
    // Spec-path with both pin+digest removed: do not trust a mutable harvest
    // remnant without a digest check — refuse offline / restore from git.
    if (specPath && recordedDigest === null) {
      return {
        ok: false,
        cause: ADMITTED_SOURCE_DIGEST_UNAVAILABLE_CAUSE,
        message:
          "verify:ac admitted-source digest (#5055): Spec-path pin and digest removed; restore from git or re-ingest the Bound-remedy harvest",
      };
    }
    return {
      ok: true,
      identities,
      digest: recordedDigest ?? liveDigest,
      // Recovered + digest-checked already — no second comparison.
      compareLiveDigest: false,
    };
  }

  // Digest remains but no pin, no git pin, no live source → refuse offline.
  if (recordedDigest !== null) {
    return {
      ok: false,
      cause: ADMITTED_SOURCE_DIGEST_UNAVAILABLE_CAUSE,
      message:
        "verify:ac admitted-source digest (#5055): pin removed; provide live admitted-source text or restore from git",
    };
  }

  // Spec-path with both fields removed and no recovery path → refuse offline.
  if (specPath) {
    return {
      ok: false,
      cause: ADMITTED_SOURCE_DIGEST_UNAVAILABLE_CAUSE,
      message:
        "verify:ac admitted-source digest (#5055): Spec-path pin and digest removed; restore from git or re-ingest the Bound-remedy harvest",
    };
  }

  // No pin and no external reference: nothing to enforce (pre-#5055 briefs).
  return { ok: true, identities: [], digest: null, compareLiveDigest: false };
}

function applyAdmittedSourceIdentityGate(
  result: VerifyAcResult,
  plan: Record<string, unknown>,
  options: EvaluateVerifyAcOptions,
): VerifyAcResult {
  if (result.resolution === "config" || result.resolution === "skipped") {
    return result;
  }
  const quiet = options.quiet === true;
  const resolved = resolveAdmittedSourceIdentities(plan, options);
  if (!resolved.ok) {
    return {
      ...result,
      ok: false,
      code: result.code === 2 ? 2 : 1,
      resolution: "fail",
      cause: resolved.cause,
      message: quiet ? "" : joinFloorMessage(resolved.message, result.message),
    };
  }
  if (resolved.identities.length === 0) {
    return result;
  }

  // Digest comparison against live REST for a working-tree pin (#5055).
  // Merge-base recovery and live-recovery skips this — Spec-path harvest must
  // not be compared to the raw refused issue body.
  if (resolved.compareLiveDigest && options.fetchAdmittedSourceText !== undefined) {
    const fetched = options.fetchAdmittedSourceText();
    if (!fetched.ok) {
      return {
        ...result,
        ok: false,
        code: result.code === 2 ? 2 : 1,
        resolution: "fail",
        cause: ADMITTED_SOURCE_DIGEST_UNAVAILABLE_CAUSE,
        message: quiet
          ? ""
          : joinFloorMessage(
              `verify:ac admitted-source digest (#5055): ${fetched.reason}`,
              result.message,
            ),
      };
    }
    // Quarantine-aware: match pin extract so unchanged bodies do not mismatch.
    const liveIdentities = extractAdmittedSourceIdentitiesWithVersion(
      fetched.text,
      readAdmittedSourceExtractor(plan.acceptance),
    ).map(normalizeIdentityText);
    const liveDigest = digestAdmittedSourceSentences(liveIdentities);
    const expectedDigest = resolved.digest ?? digestAdmittedSourceSentences(resolved.identities);
    if (liveDigest !== expectedDigest) {
      return {
        ...result,
        ok: false,
        code: result.code === 2 ? 2 : 1,
        resolution: "fail",
        cause: ADMITTED_SOURCE_DIGEST_MISMATCH_CAUSE,
        message: quiet
          ? ""
          : joinFloorMessage(
              "verify:ac admitted-source digest (#5055): working pin disagrees with live REST at the ingest-recorded revision",
              result.message,
            ),
      };
    }
  }

  const inspectedAcceptance = acceptanceForSentenceFloor(plan, result.acceptance);
  const inspectedRec = asPlanRecord(inspectedAcceptance);
  const inspectedSentences = new Set(
    (Array.isArray(inspectedRec?.sentences) ? inspectedRec.sentences : [])
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .map(normalizeIdentityText),
  );
  const clauseTexts = new Set(
    (result.acceptance.clauses ?? []).map((clause) => normalizeIdentityText(clause.text)),
  );
  const confessionTexts = new Set(
    (Array.isArray(inspectedRec?.confessions) ? inspectedRec.confessions : [])
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .map(normalizeIdentityText),
  );

  // Removed from the inspected set, or covered only by confession (#5055).
  // Ordinary unmapped (still listed, not confessed) stays on the #3550 cause.
  const missing = resolved.identities.filter((text) => {
    if (clauseTexts.has(text)) {
      return false;
    }
    if (!inspectedSentences.has(text)) {
      return true;
    }
    return confessionTexts.has(text);
  });
  if (missing.length === 0) {
    return result;
  }
  const floor = formatMissingAdmittedIdentities(missing);
  return {
    ...result,
    ok: false,
    code: result.code === 2 ? 2 : 1,
    resolution: "fail",
    cause: ADMITTED_SOURCE_IDENTITY_REMOVED_CAUSE,
    message: quiet ? (result.ok ? "" : result.message) : joinFloorMessage(floor, result.message),
  };
}

/**
 * Fail closed when a sentence on the brief is neither a clause nor a confession.
 * Runs for every reader that reaches the oracle walk. Does not read a file (#3550).
 * Admitted-source identities additionally require clause restoration (#5055).
 */
function applyStatementSentenceFloor(
  result: VerifyAcResult,
  plan: Record<string, unknown>,
  options: EvaluateVerifyAcOptions,
): VerifyAcResult {
  const quiet = options.quiet === true;
  const coverage = evaluateStatementSentenceCoverage(
    acceptanceForSentenceFloor(plan, result.acceptance),
    result.acceptance.clauses ?? [],
  );
  // No list means the brief has no statement sentences. Clauseless plans and
  // plans with no narrative body do not enter the production stamp.
  let next: VerifyAcResult = result;
  if (coverage.hasSentenceList) {
    const counted: VerifyAcResult = {
      ...result,
      behavioralClauseCount: coverage.behavioralClauseCount,
      unmappedSentenceCount: coverage.unmappedSentenceCount,
    };
    if (
      coverage.unmappedSentenceCount === 0 ||
      result.resolution === "config" ||
      result.resolution === "skipped"
    ) {
      next = counted;
    } else {
      const floor = formatUnmappedSentenceFloor(coverage.unmapped);
      if (!result.ok) {
        next = {
          ...counted,
          message: quiet ? result.message : joinFloorMessage(floor, result.message),
        };
      } else {
        next = {
          ...counted,
          ok: false,
          code: result.code === 2 ? 2 : 1,
          resolution: "fail",
          cause: UNMAPPED_STATEMENT_SENTENCE_CAUSE,
          message: quiet ? "" : joinFloorMessage(floor, result.message),
        };
      }
    }
  }
  return applyAdmittedSourceIdentityGate(next, plan, options);
}

function annotate(
  result: LiteralAcceptanceGateResult,
  acceptance: PlanAcceptance,
  quiet?: boolean,
): VerifyAcResult {
  const prefix = result.ok
    ? `verify:ac passed (#3284) [rung=${acceptance.source_rung}]`
    : `verify:ac FAILED (#3284) [rung=${acceptance.source_rung}]`;
  let message = result.message;
  if (!quiet) {
    if (message.includes("#3267")) {
      message = message.replace(/#3267/g, "#3284/#3267");
    }
    if (!message.startsWith("verify:ac")) {
      message = `${prefix}\n${message}`;
    } else if (!message.includes(`rung=${acceptance.source_rung}`)) {
      message = `${message} [rung=${acceptance.source_rung}]`;
    }
  } else if (result.ok) {
    message = "";
  }
  const commandCount = Math.max(result.commands.length, acceptance.commands.length);
  const executedRuns = result.runs.filter((run) => !isSafetyRefusalRun(run));
  const refusedRuns = result.runs.filter(isSafetyRefusalRun);
  const hasRefusal = refusedRuns.length > 0 || (result.rejected?.length ?? 0) > 0;
  const servedFrom: AcServedFrom =
    executedRuns.length > 0 ? "executed" : hasRefusal ? "refused" : "executed";
  return {
    ...result,
    message,
    sourceRung: acceptance.source_rung,
    noneStated: acceptance.none_stated,
    acceptance,
    resolution: classifyResolution({
      ok: result.ok,
      code: result.code,
      runsLength: result.runs.length,
      commandCount,
      rejectedCount: result.rejected?.length ?? 0,
    }),
    resolvedCommandCount: result.runs.length > 0 ? result.runs.length : commandCount,
    servedFrom,
  };
}

/**
 * Load admitted-source pin from a git treeish:path show (#5055).
 */
function loadAdmittedSourceAtTreeish(
  projectRoot: string,
  rel: string,
  treeish: string,
): { readonly sentences: readonly string[]; readonly digest: string | null } | null {
  const shown = defaultGitRunner(projectRoot, ["show", `${treeish}:${rel}`]);
  if (shown.code !== 0 || shown.stdout.trim().length === 0) {
    return null;
  }
  return parseAdmittedSourceFromBriefText(shown.stdout);
}

/**
 * Load admitted-source pin from merge-base, then HEAD (#5055).
 * New branch-only briefs have no merge-base copy; HEAD still recovers a deleted
 * working-tree pin after the ingest commit. Null → caller may fall through to live.
 */
function loadAdmittedSourceFromGit(
  projectRoot: string,
  xbriefPath: string,
): {
  readonly sentences: readonly string[];
  readonly digest: string | null;
  readonly source: "merge-base" | "head";
} | null {
  const abs = resolve(xbriefPath);
  const rel = relative(projectRoot, abs).replace(/\\/g, "/");
  if (rel.length === 0 || rel.startsWith("..")) {
    return null;
  }
  const mb = resolveMergeBaseSha(projectRoot);
  if (mb !== null) {
    // #6333: a lifecycle move keeps the basename, so a brief moved in the
    // working tree still reads its own merge-base pin from its old folder.
    for (const candidate of lifecycleSiblingRels(rel)) {
      const fromMb = loadAdmittedSourceAtTreeish(projectRoot, candidate, mb);
      if (fromMb !== null) {
        return { ...fromMb, source: "merge-base" };
      }
    }
  }
  // Branch-only ingest: merge-base lacks the file; HEAD still has the pin.
  // #6333: tagged `head` so it is never read as proof of the merge base.
  const fromHead = loadAdmittedSourceAtTreeish(projectRoot, rel, "HEAD");
  return fromHead === null ? null : { ...fromHead, source: "head" };
}

/**
 * `rel` first, then the same basename under the other lifecycle folders of the
 * same root (#6333). A path outside a lifecycle folder yields only itself.
 */
function lifecycleSiblingRels(rel: string): string[] {
  const parts = rel.split("/");
  const [root, folder, name] = parts;
  if (
    parts.length !== 3 ||
    root === undefined ||
    folder === undefined ||
    name === undefined ||
    !LIFECYCLE_ROOTS.has(root) ||
    !LIFECYCLE_FOLDERS.has(folder)
  ) {
    return [rel];
  }
  return [
    rel,
    ...[...LIFECYCLE_FOLDERS]
      .filter((other) => other !== folder)
      .map((other) => `${root}/${other}/${name}`),
  ];
}

/** Merge base of the delivery ref and HEAD (origin/main fallback), or null. */
function resolveMergeBaseSha(projectRoot: string): string | null {
  const baseRef =
    process.env.DEFT_BASE_REF?.trim() || process.env.GITHUB_BASE_REF?.trim() || "origin/master";
  const left = baseRef.includes("/") ? baseRef : `origin/${baseRef}`;
  const mb = defaultGitRunner(projectRoot, ["merge-base", left, "HEAD"]);
  if (mb.code === 0 && mb.stdout.trim().length > 0) {
    return mb.stdout.trim();
  }
  const fallback = defaultGitRunner(projectRoot, ["merge-base", "origin/main", "HEAD"]);
  if (fallback.code === 0 && fallback.stdout.trim().length > 0) {
    return fallback.stdout.trim();
  }
  return null;
}

const LIFECYCLE_ROOTS = new Set(["xbrief", "vbrief"]);
const LIFECYCLE_FOLDERS = new Set(["proposed", "pending", "active", "completed", "cancelled"]);

/**
 * #6333 item 5: is this brief really on the merge base? True when the merge
 * base tree holds the same basename under any lifecycle folder (a lifecycle
 * move keeps the basename). The HEAD fallback is never consulted.
 */
export function isBriefOnMergeBase(projectRoot: string, xbriefPath: string): boolean {
  const abs = resolve(xbriefPath);
  const rel = relative(projectRoot, abs).replace(/\\/g, "/");
  if (rel.length === 0 || rel.startsWith("..")) {
    return false;
  }
  const mb = resolveMergeBaseSha(projectRoot);
  if (mb === null) {
    return false;
  }
  const name = rel.split("/").pop() ?? "";
  const listed = defaultGitRunner(projectRoot, [
    "ls-tree",
    "-r",
    "--name-only",
    mb,
    "--",
    ...LIFECYCLE_ROOTS,
  ]);
  if (listed.code !== 0) {
    return false;
  }
  return listed.stdout.split(/\r?\n/).some((line) => {
    const parts = line.trim().split("/");
    return (
      parts.length === 3 &&
      LIFECYCLE_ROOTS.has(parts[0] ?? "") &&
      LIFECYCLE_FOLDERS.has(parts[1] ?? "") &&
      parts[2] === name
    );
  });
}

function parseAdmittedSourceFromBriefText(
  text: string,
): { readonly sentences: readonly string[]; readonly digest: string | null } | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    const root = asRecord(parsed);
    const plan = asRecord(root?.plan);
    const sentences = readAdmittedSourceSentences(plan?.acceptance);
    if (sentences === null) {
      return null;
    }
    return {
      sentences,
      digest: readAdmittedSourceDigest(plan?.acceptance),
    };
  } catch {
    return null;
  }
}

/**
 * Evaluate from xBRIEF path.
 */
export function evaluateVerifyAcFromPath(
  xbriefPath: string,
  options: EvaluateVerifyAcOptions = {},
): VerifyAcResult {
  const abs = resolve(xbriefPath);
  if (!existsSync(abs)) {
    if (options.softMissingXbrief) {
      return applyOracle(softSkip(`xBRIEF not found: ${abs}`, options.quiet), options);
    }
    return applyOracle(configResult(`verify:ac: xBRIEF not found: ${abs}`), options);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8"));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return applyOracle(configResult(`verify:ac: unreadable xBRIEF (${msg}): ${abs}`), options);
  }
  const data = asRecord(parsed);
  if (data === null) {
    return applyOracle(
      configResult(`verify:ac: xBRIEF top-level is not an object: ${abs}`),
      options,
    );
  }
  const plan = asRecord(data.plan);
  if (plan === null) {
    return applyOracle(configResult(`verify:ac: xBRIEF missing plan object: ${abs}`), options);
  }
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  // Path-relative keys stay unique across xbrief/ vs vbrief/ and duplicate plan.id (#3337 Greptile).
  const oracleScopeKey =
    options.oracleScopeKey?.trim() || resolveOracleScopeKey(plan, abs, projectRoot);
  let admittedSourceMergeBase = options.admittedSourceMergeBase;
  // #5055: recover git pin (merge-base / HEAD) even when a working pin remains so
  // an edited/shrunk pin cannot silently replace the ingest-recorded identities.
  if (admittedSourceMergeBase === undefined) {
    const fromGit = loadAdmittedSourceFromGit(projectRoot, abs);
    if (fromGit !== null) {
      admittedSourceMergeBase = fromGit;
    }
  }
  // #6333 item 5: probe the merge base itself for Spec-path briefs.
  // #6609 item 7: a HEAD-sourced pin of a body-route brief needs the same probe.
  const briefOnMergeBase =
    options.briefOnMergeBase ??
    (planIsSpecPath(plan) || admittedSourceMergeBase?.source === "head"
      ? isBriefOnMergeBase(projectRoot, abs)
      : undefined);
  const emitOptions: EvaluateVerifyAcOptions = {
    ...options,
    xbriefPath: abs,
    oracleScopeKey,
    observedAcceptance: plan.acceptance,
    ...(admittedSourceMergeBase !== undefined ? { admittedSourceMergeBase } : {}),
    ...(briefOnMergeBase !== undefined ? { briefOnMergeBase } : {}),
    persistRequirementSourcesAutofix:
      options.persistRequirementSourcesAutofix ??
      ((next) => {
        for (const key of Object.keys(plan)) {
          delete plan[key];
        }
        Object.assign(plan, next);
        writeRequirementSourcesAutofixToXbrief(abs, plan, projectRoot);
      }),
  };
  const result = evaluateVerifyAcFromPlan(plan, {
    ...emitOptions,
    skipAcceptanceEmit: true,
  });
  const banked = maybeAttachAcPassBank(result, plan, abs, emitOptions);
  emitAcceptanceTelemetry(banked, emitOptions, projectRoot);
  return banked;
}

export interface AdmittedSourceActivationResult {
  readonly ok: boolean;
  /** The `verify:ac` message `scope:complete` would print; empty when ok. */
  readonly message: string;
  readonly cause?: string;
}

/**
 * #6609 item 7: the existing admitted-source identity check (#5055) and the
 * statement sentence floor (#3550), run when a brief enters `xbrief/active/`.
 * The clause oracle walk does not run. A body-route brief that is not on the
 * merge base is compared with the live issue body, even when its pin comes
 * from HEAD. No new cause, refusal text or flag: same checks, same messages.
 */
export function evaluateAdmittedSourceAtActivation(
  plan: Record<string, unknown>,
  options: {
    readonly projectRoot: string;
    readonly xbriefPath?: string | null;
    readonly admittedSourceMergeBase?: EvaluateVerifyAcOptions["admittedSourceMergeBase"];
    readonly briefOnMergeBase?: boolean;
    readonly fetchAdmittedSourceText?: EvaluateVerifyAcOptions["fetchAdmittedSourceText"];
    readonly fetchSpecPathLiveIdentities?: EvaluateVerifyAcOptions["fetchSpecPathLiveIdentities"];
  },
): AdmittedSourceActivationResult {
  const projectRoot = resolve(options.projectRoot);
  const base: EvaluateVerifyAcOptions = {
    projectRoot,
    quiet: false,
    ...(options.xbriefPath !== undefined ? { xbriefPath: options.xbriefPath } : {}),
    ...(options.admittedSourceMergeBase !== undefined
      ? { admittedSourceMergeBase: options.admittedSourceMergeBase }
      : {}),
    ...(options.fetchSpecPathLiveIdentities !== undefined
      ? { fetchSpecPathLiveIdentities: options.fetchSpecPathLiveIdentities }
      : {}),
  };
  const pin = resolveAdmittedSourceGitPin(plan, base, projectRoot);
  // Only an ingested brief is checked: one that carries a stored sentence list
  // or an admitted-source pin, or whose pin was saved in git (a deleted working
  // block must not skip the check, so the git pin is looked up first). A
  // hand-authored brief has none; its sentence list is derived from narratives
  // at completion, as before.
  const stored = asPlanRecord(plan.acceptance);
  const carriesAdmittedSource =
    (stored !== null &&
      (readAdmittedSourceSentences(stored) !== null ||
        readAdmittedSourceDigest(stored) !== null ||
        Array.isArray(stored.sentences))) ||
    planHasSpecPathRefusedBody(plan) ||
    (pin !== undefined && pin !== null && pin.sentences.length > 0);
  if (!carriesAdmittedSource) {
    return { ok: true, message: "" };
  }
  const briefOnMergeBase =
    options.briefOnMergeBase ?? resolveBriefOnMergeBase(plan, base, projectRoot, pin ?? null);
  // Arm the live fetch when a pin or digest exists or the brief is Spec-path,
  // as `verify:ac` does, so a brief with no admitted source stays unchecked.
  const armed =
    readAdmittedSourceSentences(plan.acceptance) !== null ||
    readAdmittedSourceDigest(plan.acceptance) !== null ||
    planHasSpecPathRefusedBody(plan) ||
    (pin !== undefined && pin !== null && pin.sentences.length > 0);
  const fetchText =
    options.fetchAdmittedSourceText ??
    (armed ? () => fetchPlanAdmittedSourceText(plan) : undefined);
  const acceptance = readPlanAcceptance(plan);
  const walked: VerifyAcResult = {
    ok: true,
    code: 0,
    message: "",
    commands: [],
    runs: [],
    sourceRung: acceptance.source_rung,
    noneStated: acceptance.none_stated,
    acceptance,
    resolution: "verified-pass",
    resolvedCommandCount: 0,
  };
  const checked = applyStatementSentenceFloor(walked, plan, {
    ...base,
    ...(pin !== undefined ? { admittedSourceMergeBase: pin } : {}),
    ...(briefOnMergeBase !== undefined ? { briefOnMergeBase } : {}),
    ...(fetchText !== undefined ? { fetchAdmittedSourceText: fetchText } : {}),
  });
  return {
    ok: checked.ok,
    message: checked.ok ? "" : checked.message,
    ...(checked.cause !== undefined ? { cause: checked.cause } : {}),
  };
}

/**
 * Unique product-oracle scope key for one active xBRIEF path (#3337).
 * Relative path is always unique across active roots; plan.id alone is not
 * (duplicate ids / same stem in xbrief+vbrief). Prefer `id@relPath` when both exist.
 */
export function resolveOracleScopeKey(
  plan: Record<string, unknown>,
  xbriefPath: string,
  projectRoot: string,
): string {
  const rel = collisionAwareOracleRelPath(xbriefPath, projectRoot);
  const planId = typeof plan.id === "string" && plan.id.trim() ? plan.id.trim() : null;
  if (planId !== null) {
    return `${planId}@${rel}`;
  }
  return rel;
}

/**
 * After verified-pass, FINALIZE the banking checkpoint (#3285 / #3558).
 * Soft/advisory empty-pass still skips. Ledger I/O failures fail closed.
 */
function maybeAttachAcPassBank(
  result: VerifyAcResult,
  plan: Record<string, unknown>,
  xbriefPath: string,
  options: EvaluateVerifyAcOptions,
): VerifyAcResult {
  if (options.bankOnPass === false) {
    return result;
  }
  if (!result.ok || result.resolution !== "verified-pass") {
    return result;
  }
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const scopeId = resolveScopeIdForAcReuse(plan, options.bankScopeId, {
    oracleScopeKey: options.oracleScopeKey,
    xbriefPath,
    projectRoot,
  });
  if (scopeId === null) {
    return result;
  }
  try {
    const hashed = hashProductState({
      projectRoot,
      plan,
      productPaths: options.productPaths,
      resolvedAcceptanceContract: resolvedContractForHash(plan, options),
    });
    const banked = maybeBankOnAcPass({
      projectRoot,
      scopeId,
      executableRuns: result.runs.length,
      verifiedPass: true,
      quiet: options.quiet,
      productStateHash: hashed.complete ? hashed.digest : null,
      environ: options.env,
      headSha: gitHead(projectRoot).head,
      runs: result.runs,
      commands: result.commands,
    });
    if (options.quiet || banked.notes.length === 0) {
      return result;
    }
    const extra = banked.notes.join("\n");
    return {
      ...result,
      message: result.message ? `${result.message}\n${extra}` : extra,
    };
  } catch (err: unknown) {
    // Checkpoint is mandatory after executable AC green (#3285 Greptile residual).
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ...result,
      ok: false,
      code: 1,
      resolution: "fail",
      message:
        `verify:ac bank checkpoint failed (#3285): ${msg}` +
        (result.message ? `\n${result.message}` : ""),
    };
  }
}

function configResult(message: string): VerifyAcResult {
  return {
    ok: false,
    code: 2,
    message,
    commands: [],
    runs: [],
    sourceRung: "project_floor",
    noneStated: true,
    acceptance: { commands: [], none_stated: true, source_rung: "project_floor" },
    resolution: "config",
    resolvedCommandCount: 0,
  };
}

function softSkip(detail: string, quiet?: boolean): VerifyAcResult {
  return {
    ok: true,
    code: 0,
    message: quiet ? "" : `verify:ac skipped (#3284 soft-missing): ${detail}`,
    commands: [],
    runs: [],
    sourceRung: "project_floor",
    noneStated: true,
    acceptance: { commands: [], none_stated: true, source_rung: "project_floor" },
    resolution: "skipped",
    resolvedCommandCount: 0,
  };
}

/** Pure: product AC is required at every ceremony depth (#3284 / #3267 / #3156). */
export function isVerifyAcRequiredAtCeremonyDepth(_depth: string | null | undefined): boolean {
  return true;
}
