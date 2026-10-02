/**
 * Workspace requirement_sources staleness (#3920).
 *
 * At intake/stamp, record path+sha256 for workspace artifacts derivation already
 * read. verify:ac and the completion walk re-hash; digest change autofixes
 * (re-read / re-derive / re-stamp / report) per the #3813 autofix line.
 * Residuals fail closed: missing source, malformed stamp, completed-item
 * conflict, post-complete.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { containedWrite } from "../fs/contained-write.js";
import {
  type AcceptanceClause,
  deriveAcceptanceClauses,
  readAcceptanceClauses,
  serializeAcceptanceClauses,
} from "./clauses.js";

export const REQUIREMENT_SOURCES_KEY = "requirement_sources" as const;

export const REQUIREMENT_SOURCE_MISSING_REMEDIATION =
  "restore the recorded requirement source on disk, or re-ingest after dropping the stale path from plan.metadata.requirement_sources";

export const REQUIREMENT_SOURCE_COMPLETED_CONFLICT_REMEDIATION =
  "re-open or revise already-completed plan items before accepting a requirement-source re-derivation that changes clauses";

export const REQUIREMENT_SOURCE_POST_COMPLETE_REMEDIATION =
  "requirement sources must not change after scope:complete; open a new scope or restore the recorded bytes";

export const REQUIREMENT_SOURCE_MALFORMED_REMEDIATION =
  "repair plan.metadata.requirement_sources entries to include non-empty path, content_sha256, and recorded_at, or drop the malformed rows and re-stamp";

export const REQUIREMENT_SOURCE_UNPARSEABLE_REMEDIATION =
  "restore parseable acceptance content in the recorded requirement source (list items under an Acceptance Criteria heading), or re-ingest after updating plan.acceptance clauses";

export interface RequirementSource {
  readonly path: string;
  readonly content_sha256: string;
  readonly recorded_at: string;
}

/** Path (+ optional already-read bytes) the stamp path consumed. */
export interface WorkspaceSourceInput {
  readonly path: string;
  readonly content?: string | Buffer;
}

export interface RequirementSourceDelta {
  readonly path: string;
  readonly previous_sha256: string;
  readonly current_sha256: string;
}

export interface RequirementSourcesOk {
  readonly ok: true;
  readonly kind: "unchanged" | "autofixed" | "absent";
  readonly sources_rechecked: number;
  readonly sources_changed: number;
  readonly deltas: readonly RequirementSourceDelta[];
  readonly plan: Record<string, unknown>;
  readonly message: string;
}

export interface RequirementSourcesFail {
  readonly ok: false;
  readonly kind: "missing" | "completed_conflict" | "post_complete" | "malformed" | "unparseable";
  readonly sources_rechecked: number;
  readonly sources_changed: number;
  readonly deltas: readonly RequirementSourceDelta[];
  readonly message: string;
  readonly remediation: string;
}

export type RequirementSourcesVerdict = RequirementSourcesOk | RequirementSourcesFail;

export interface EvaluateRequirementSourcesOptions {
  /** Persist autofix restamp (tests / path helpers). */
  readonly writePlan?: (plan: Record<string, unknown>) => void;
  readonly now?: () => string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** sha256 hex of UTF-8 text or raw bytes. */
export function hashRequirementContent(content: string | Buffer): string {
  const hash = createHash("sha256");
  if (typeof content === "string") {
    hash.update(content, "utf8");
  } else {
    hash.update(content);
  }
  return hash.digest("hex");
}

/** Repo-relative forward-slash form for stamped paths. */
export function normalizeRequirementSourcePath(projectRoot: string, pathValue: string): string {
  const abs = isAbsolute(pathValue) ? resolve(pathValue) : resolve(projectRoot, pathValue);
  const rel = relative(resolve(projectRoot), abs).split("\\").join("/");
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return abs.split("\\").join("/");
  }
  return rel.replace(/^\.\//, "");
}

export type ReadRequirementSourcesResult =
  | { readonly ok: true; readonly sources: RequirementSource[] }
  | { readonly ok: false; readonly message: string };

/**
 * Read stamped requirement_sources from plan.metadata.
 * Absent key → empty ok. Malformed rows fail closed (#3920 Greptile).
 */
export function readRequirementSourcesStrict(plan: unknown): ReadRequirementSourcesResult {
  const metadata = asRecord(asRecord(plan)?.metadata);
  if (metadata === null || !Array.isArray(metadata[REQUIREMENT_SOURCES_KEY])) {
    return { ok: true, sources: [] };
  }
  const out: RequirementSource[] = [];
  let index = 0;
  for (const entry of metadata[REQUIREMENT_SOURCES_KEY]) {
    const row = asRecord(entry);
    if (
      row === null ||
      !isNonEmptyString(row.path) ||
      !isNonEmptyString(row.content_sha256) ||
      !isNonEmptyString(row.recorded_at)
    ) {
      return {
        ok: false,
        message: `verify:ac requirement_sources (#3920): malformed entry at index ${index} (need path, content_sha256, recorded_at)`,
      };
    }
    out.push({
      path: row.path.trim(),
      content_sha256: row.content_sha256.trim().toLowerCase(),
      recorded_at: row.recorded_at.trim(),
    });
    index += 1;
  }
  return { ok: true, sources: out };
}

/** Read stamped requirement_sources from plan.metadata (empty when absent). */
export function readRequirementSources(plan: unknown): RequirementSource[] {
  const result = readRequirementSourcesStrict(plan);
  return result.ok ? result.sources : [];
}

function withRequirementSources(
  plan: Record<string, unknown>,
  sources: readonly RequirementSource[],
): Record<string, unknown> {
  const metadata = asRecord(plan.metadata) ?? {};
  return {
    ...plan,
    metadata: {
      ...metadata,
      [REQUIREMENT_SOURCES_KEY]: sources.map((source) => ({
        path: source.path,
        content_sha256: source.content_sha256,
        recorded_at: source.recorded_at,
      })),
    },
  };
}

/**
 * Record digests for workspace artifacts the caller already read (or paths to
 * read once now). Does not invent sources beyond the provided list (#3920).
 */
export function stampRequirementSources(
  plan: Record<string, unknown>,
  projectRoot: string,
  sources: readonly WorkspaceSourceInput[],
  options: { readonly now?: () => string } = {},
): Record<string, unknown> {
  if (sources.length === 0) {
    return plan;
  }
  const now = options.now ?? (() => new Date().toISOString());
  const recordedAt = now();
  const root = resolve(projectRoot);
  const stamped: RequirementSource[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    if (!isNonEmptyString(source.path)) continue;
    const norm = normalizeRequirementSourcePath(root, source.path);
    if (seen.has(norm)) continue;
    seen.add(norm);
    let content = source.content;
    if (content === undefined) {
      const abs = isAbsolute(source.path) ? resolve(source.path) : resolve(root, source.path);
      if (!existsSync(abs)) {
        continue;
      }
      content = readFileSync(abs);
    }
    stamped.push({
      path: norm,
      content_sha256: hashRequirementContent(content),
      recorded_at: recordedAt,
    });
  }
  if (stamped.length === 0) {
    return plan;
  }
  return withRequirementSources(plan, stamped);
}

function resolveSourceAbs(projectRoot: string, stampedPath: string): string {
  if (isAbsolute(stampedPath)) {
    return resolve(stampedPath);
  }
  return resolve(projectRoot, stampedPath);
}

function planHasCompletedItems(plan: Record<string, unknown>): boolean {
  if (!Array.isArray(plan.items)) {
    return false;
  }
  for (const item of plan.items) {
    const row = asRecord(item);
    if (row === null) continue;
    const status = typeof row.status === "string" ? row.status.trim().toLowerCase() : "";
    if (status === "completed" || status === "done" || status === "complete") {
      return true;
    }
  }
  return false;
}

function planIsCompleted(plan: Record<string, unknown>): boolean {
  const status = typeof plan.status === "string" ? plan.status.trim().toLowerCase() : "";
  return status === "completed" || status === "complete";
}

function clauseFingerprint(plan: Record<string, unknown>): string {
  const clauses = readAcceptanceClauses(plan.acceptance);
  return clauses.map((c) => `${c.id}:${c.text}|${c.artifact_path ?? ""}`).join("\n");
}

/** Prefer task-statement text when a source is an xBRIEF / plan JSON blob. */
function taskStatementFromSourceContent(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return trimmed;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const doc = asRecord(parsed);
    const plan = asRecord(doc?.plan) ?? doc;
    if (plan === null) {
      return trimmed;
    }
    const parts: string[] = [];
    if (isNonEmptyString(plan.title)) {
      parts.push(plan.title.trim());
    }
    const narratives = asRecord(plan.narratives);
    if (narratives !== null) {
      for (const value of Object.values(narratives)) {
        if (isNonEmptyString(value)) {
          parts.push(value.trim());
        }
      }
    }
    if (Array.isArray(plan.items)) {
      for (const item of plan.items) {
        const row = asRecord(item);
        if (row === null) continue;
        const narrative = asRecord(row.narrative);
        const declared = narrative?.Acceptance;
        const text = isNonEmptyString(declared) ? declared : row.title;
        if (isNonEmptyString(text)) {
          parts.push(text.trim());
        }
      }
    }
    if (parts.length > 0) {
      return parts.join("\n\n");
    }
  } catch {
    // Not JSON — fall through to raw content.
  }
  return trimmed;
}

function normalizeClauseText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Keep prior artifact_path / ambiguity when clause text still matches. */
function preserveClauseBindings(
  previous: readonly AcceptanceClause[],
  next: readonly AcceptanceClause[],
): AcceptanceClause[] {
  const byText = new Map<string, AcceptanceClause>();
  for (const clause of previous) {
    const key = normalizeClauseText(clause.text);
    if (!byText.has(key)) {
      byText.set(key, clause);
    }
  }
  return next.map((clause) => {
    const prior = byText.get(normalizeClauseText(clause.text));
    if (prior === undefined) {
      return clause;
    }
    return {
      ...clause,
      artifact_path: prior.artifact_path,
      ambiguous: prior.ambiguous,
      ...(prior.readings !== undefined ? { readings: prior.readings } : {}),
      ...(prior.chosen_reading !== undefined ? { chosen_reading: prior.chosen_reading } : {}),
    };
  });
}

type AutofixRederiveResult =
  | { readonly ok: true; readonly plan: Record<string, unknown>; readonly clausesChanged: boolean }
  | { readonly ok: false; readonly kind: "unparseable"; readonly message: string };

function autofixRederive(
  plan: Record<string, unknown>,
  sourceContents: readonly string[],
  nextSources: readonly RequirementSource[],
): AutofixRederiveResult {
  const before = clauseFingerprint(plan);
  // Re-derive from the re-read workspace sources only (#3920). Passing the
  // pre-change plan item / narrative surfaces would freeze the old clause set
  // and defeat the autofix half.
  const statement = sourceContents
    .map((c) => taskStatementFromSourceContent(c))
    .filter((c) => c.length > 0)
    .join("\n\n");
  const derived = deriveAcceptanceClauses(statement);
  if (derived.length === 0) {
    // Digest changed but the source no longer yields clauses — do not keep
    // stale acceptance while pretending the source is current (#3920 Greptile).
    return {
      ok: false,
      kind: "unparseable",
      message:
        "verify:ac requirement_sources (#3920): source digest changed but re-derivation yielded no parseable clauses",
    };
  }
  const previous = readAcceptanceClauses(plan.acceptance);
  const clauses = preserveClauseBindings(previous, derived);
  const acceptance = asRecord(plan.acceptance) ?? {};
  const nextAcceptance: Record<string, unknown> = {
    ...acceptance,
    clauses: serializeAcceptanceClauses(clauses),
  };
  if (
    acceptance.none_stated === true ||
    !Array.isArray(acceptance.commands) ||
    acceptance.commands.length === 0
  ) {
    nextAcceptance.none_stated = true;
    nextAcceptance.source_rung = "derived";
    nextAcceptance.derived_reason = `re-derived ${clauses.length} clauses after requirement_sources digest change (#3920)`;
  }
  const nextPlan = withRequirementSources(
    {
      ...plan,
      acceptance: nextAcceptance,
    },
    nextSources,
  );
  return {
    ok: true,
    plan: nextPlan,
    clausesChanged: clauseFingerprint(nextPlan) !== before,
  };
}

function formatDeltaReport(deltas: readonly RequirementSourceDelta[]): string {
  return deltas
    .map(
      (d) =>
        `  - ${d.path}: ${d.previous_sha256.slice(0, 12)}... -> ${d.current_sha256.slice(0, 12)}...`,
    )
    .join("\n");
}

/**
 * Re-hash recorded requirement_sources. Digest change autofixes (re-derive /
 * re-stamp / report). Missing / malformed / completed-conflict / post-complete
 * fail closed.
 */
export function evaluateRequirementSourcesStaleness(
  plan: Record<string, unknown>,
  projectRoot: string,
  options: EvaluateRequirementSourcesOptions = {},
): RequirementSourcesVerdict {
  const recordedResult = readRequirementSourcesStrict(plan);
  if (!recordedResult.ok) {
    return {
      ok: false,
      kind: "malformed",
      sources_rechecked: 0,
      sources_changed: 0,
      deltas: [],
      message: recordedResult.message,
      remediation: REQUIREMENT_SOURCE_MALFORMED_REMEDIATION,
    };
  }
  const recorded = recordedResult.sources;
  if (recorded.length === 0) {
    return {
      ok: true,
      kind: "absent",
      sources_rechecked: 0,
      sources_changed: 0,
      deltas: [],
      plan,
      message: "",
    };
  }

  const root = resolve(projectRoot);
  const now = options.now ?? (() => new Date().toISOString());
  const recordedAt = now();
  const deltas: RequirementSourceDelta[] = [];
  const nextSources: RequirementSource[] = [];
  const sourceContents: string[] = [];
  let rechecked = 0;

  for (const source of recorded) {
    rechecked += 1;
    const abs = resolveSourceAbs(root, source.path);
    if (!existsSync(abs)) {
      return {
        ok: false,
        kind: "missing",
        sources_rechecked: rechecked,
        sources_changed: deltas.length,
        deltas,
        message: `verify:ac requirement_sources (#3920): recorded source missing on disk: ${source.path}`,
        remediation: REQUIREMENT_SOURCE_MISSING_REMEDIATION,
      };
    }
    const content = readFileSync(abs);
    const digest = hashRequirementContent(content);
    sourceContents.push(content.toString("utf8"));
    if (digest !== source.content_sha256) {
      deltas.push({
        path: source.path,
        previous_sha256: source.content_sha256,
        current_sha256: digest,
      });
      nextSources.push({
        path: source.path,
        content_sha256: digest,
        recorded_at: recordedAt,
      });
    } else {
      nextSources.push(source);
    }
  }

  if (deltas.length === 0) {
    return {
      ok: true,
      kind: "unchanged",
      sources_rechecked: rechecked,
      sources_changed: 0,
      deltas: [],
      plan,
      message: "",
    };
  }

  if (planIsCompleted(plan)) {
    return {
      ok: false,
      kind: "post_complete",
      sources_rechecked: rechecked,
      sources_changed: deltas.length,
      deltas,
      message:
        `verify:ac requirement_sources (#3920): ${deltas.length} source(s) changed after scope:complete\n` +
        formatDeltaReport(deltas),
      remediation: REQUIREMENT_SOURCE_POST_COMPLETE_REMEDIATION,
    };
  }

  const fixed = autofixRederive(plan, sourceContents, nextSources);
  if (!fixed.ok) {
    return {
      ok: false,
      kind: "unparseable",
      sources_rechecked: rechecked,
      sources_changed: deltas.length,
      deltas,
      message: `${fixed.message}\n${formatDeltaReport(deltas)}`,
      remediation: REQUIREMENT_SOURCE_UNPARSEABLE_REMEDIATION,
    };
  }
  if (fixed.clausesChanged && planHasCompletedItems(plan)) {
    return {
      ok: false,
      kind: "completed_conflict",
      sources_rechecked: rechecked,
      sources_changed: deltas.length,
      deltas,
      message:
        `verify:ac requirement_sources (#3920): re-derivation conflicts with already-completed plan items\n` +
        formatDeltaReport(deltas),
      remediation: REQUIREMENT_SOURCE_COMPLETED_CONFLICT_REMEDIATION,
    };
  }

  options.writePlan?.(fixed.plan);
  const message =
    `requirement_sources autofix (#3920): re-derived after ${deltas.length} digest change(s)\n` +
    formatDeltaReport(deltas);
  return {
    ok: true,
    kind: "autofixed",
    sources_rechecked: rechecked,
    sources_changed: deltas.length,
    deltas,
    plan: fixed.plan,
    message,
  };
}

/**
 * Merge autofix acceptance + requirement_sources into the on-disk brief plan.
 * Preserves intervening plan edits outside those fields (#3920 Greptile).
 */
export function writeRequirementSourcesAutofixToXbrief(
  xbriefPath: string,
  plan: Record<string, unknown>,
  projectRoot: string,
): void {
  const root = resolve(projectRoot);
  const abs = isAbsolute(xbriefPath) ? resolve(xbriefPath) : resolve(root, xbriefPath);
  const raw = JSON.parse(readFileSync(abs, "utf8")) as unknown;
  const doc = asRecord(raw);
  if (doc === null) {
    return;
  }
  const diskPlan = asRecord(doc.plan) ?? {};
  const diskMeta = asRecord(diskPlan.metadata) ?? {};
  const nextMeta = asRecord(plan.metadata) ?? {};
  const mergedPlan: Record<string, unknown> = {
    ...diskPlan,
    ...(plan.acceptance !== undefined ? { acceptance: plan.acceptance } : {}),
    metadata: {
      ...diskMeta,
      ...(REQUIREMENT_SOURCES_KEY in nextMeta
        ? { [REQUIREMENT_SOURCES_KEY]: nextMeta[REQUIREMENT_SOURCES_KEY] }
        : {}),
    },
  };
  const next = { ...doc, plan: mergedPlan };
  containedWrite({
    root,
    target: abs,
    data: `${JSON.stringify(next, null, 2)}\n`,
    mode: "replace",
  });
}
