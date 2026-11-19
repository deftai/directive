/**
 * `scope:confess`: write a sentence that is not a criterion to
 * `plan.acceptance.confessions` (#6644).
 *
 * Usage: deft scope:confess -- <brief> --sentence "<text>" (repeatable) or --all-unmapped.
 *
 * The sentence floor (#3550) wants every statement sentence to be a clause or a
 * confession. Until now nothing wrote a confession, so workers hand-edited the
 * acceptance block. This verb appends the named sentences and changes nothing
 * else: not the clauses, the sentence list, the admitted-source pin or its digest.
 *
 * A sentence that is an admitted-source identity (#5055) is refused: a confession
 * of an admitted identity is the removal the identity check rejects. Such a
 * sentence is a clause, and an operator marks it with the acceptance-disposition
 * grant (`--disposition not_applicable`). The refusal names that command.
 */

import { dirname } from "node:path";
import {
  readAdmittedSourceDigest,
  readAdmittedSourceSentences,
} from "../product-first-done-gate/acceptance.js";
import { evaluateStatementSentenceCoverage, readAcceptanceClauses } from "../verify-ac/clauses.js";
import { atomicWriteBrief, readBriefForMutation } from "./brief-io.js";
import { resolveProjectRoot } from "./project-context.js";

export const CONFESS_ACTION = "confess" as const;
export const CONFESS_VERB = "scope:confess" as const;

export interface ConfessOnBriefOptions {
  readonly projectRoot?: string;
  /** Sentences named with `--sentence` (repeatable). */
  readonly sentences?: readonly string[];
  /** `--all-unmapped`: every sentence the sentence floor reports as unmapped. */
  readonly allUnmapped?: boolean;
}

export interface ConfessOnBriefResult {
  readonly ok: boolean;
  readonly message: string;
  /** Sentences written to acceptance.confessions by this call. */
  readonly confessed: readonly string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/** Same identity the sentence floor uses: all whitespace collapsed. */
function key(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function readStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function grantCommand(planId: string | null, clauseId: number | null): string {
  return (
    `deft authz:grant -- --template acceptance-disposition --plan-ref ${planId ?? "<scopeId>"} ` +
    `--story-ids ${clauseId === null ? "<clause.N>" : `clause.${clauseId}`} ` +
    `--disposition not_applicable --reason <text> --confirm`
  );
}

function refuse(message: string): ConfessOnBriefResult {
  return { ok: false, message: `${CONFESS_VERB} refused: ${message}`, confessed: [] };
}

/**
 * In-memory confess. Refuses with no mutation when any named sentence is not in
 * `acceptance.sentences`, is clause text, or is an admitted-source identity.
 */
export function confessSentencesOnPlan(
  plan: Record<string, unknown>,
  options: Pick<ConfessOnBriefOptions, "sentences" | "allUnmapped">,
): ConfessOnBriefResult {
  const named = (options.sentences ?? []).map(key).filter((s) => s.length > 0);
  const allUnmapped = options.allUnmapped === true;
  if (named.length === 0 && !allUnmapped) {
    return refuse('name at least one --sentence "<text>" or pass --all-unmapped');
  }
  const acceptance = asRecord(plan.acceptance);
  if (acceptance === null || !Array.isArray(acceptance.sentences)) {
    return refuse("plan.acceptance.sentences is missing; there is nothing to confess");
  }
  const planId = typeof plan.id === "string" && plan.id.trim().length > 0 ? plan.id.trim() : null;
  const sentences = readStrings(acceptance.sentences);
  const sentenceByKey = new Map(sentences.map((text) => [key(text), text] as const));
  const clauses = readAcceptanceClauses(acceptance);
  const clauseIdByKey = new Map(clauses.map((clause) => [key(clause.text), clause.id] as const));
  const admittedList = readAdmittedSourceSentences(acceptance);
  if (admittedList === null && readAdmittedSourceDigest(acceptance) !== null) {
    return refuse(
      "the admitted-source pin is missing while its digest remains; restore it from git first (#5055)",
    );
  }
  const admitted = new Set((admittedList ?? []).map(key));
  const existing = readStrings(acceptance.confessions);
  const confessedKeys = new Set(existing.map(key));

  const toWrite = new Map<string, string>();
  const refusals: string[] = [];
  for (const wanted of new Set(named)) {
    const stored = sentenceByKey.get(wanted);
    if (stored === undefined) {
      refusals.push(`not in plan.acceptance.sentences: ${wanted}`);
      continue;
    }
    const clauseId = clauseIdByKey.get(wanted) ?? null;
    if (admitted.has(wanted)) {
      refusals.push(
        `admitted-source identity (#5055), a confession would be its removal: ${wanted}\n` +
          `    mark it instead with: ${grantCommand(planId, clauseId)}`,
      );
      continue;
    }
    if (clauseId !== null) {
      refusals.push(
        `clause ${clauseId} text, not a sentence to confess: ${wanted}\n` +
          `    mark it instead with: ${grantCommand(planId, clauseId)}`,
      );
      continue;
    }
    if (!confessedKeys.has(wanted)) toWrite.set(wanted, stored);
  }
  if (refusals.length > 0) {
    return refuse(`nothing written.\n${refusals.map((line) => `  - ${line}`).join("\n")}`);
  }

  const skipped: string[] = [];
  if (allUnmapped) {
    const coverage = evaluateStatementSentenceCoverage(acceptance, clauses);
    for (const text of coverage.unmapped) {
      const k = key(text);
      if (admitted.has(k)) {
        skipped.push(text);
      } else if (!confessedKeys.has(k)) {
        toWrite.set(k, sentenceByKey.get(k) ?? text);
      }
    }
  }

  const confessed = [...toWrite.values()];
  const lines = [
    ...confessed.map((text) => `${CONFESS_VERB} wrote: ${text}`),
    ...skipped.map(
      (text) =>
        `${CONFESS_VERB} left unmapped (admitted-source identity, no clause carries it): ${text}`,
    ),
  ];
  if (confessed.length === 0) {
    return {
      ok: true,
      confessed,
      message: [`${CONFESS_VERB}: unchanged (nothing to confess)`, ...lines].join("\n"),
    };
  }
  acceptance.confessions = [...existing, ...confessed];
  plan.acceptance = acceptance;
  return {
    ok: true,
    confessed,
    message: [`${CONFESS_VERB} confessed ${confessed.length} sentence(s) (#6644)`, ...lines].join(
      "\n",
    ),
  };
}

export function confessOnBrief(
  filePath: string,
  options: ConfessOnBriefOptions,
): ConfessOnBriefResult {
  const read = readBriefForMutation(filePath);
  if (!read.ok) {
    return { ok: false, message: read.message, confessed: [] };
  }
  const data = read.data;
  const plan = data.plan;
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) {
    return { ok: false, message: `vBRIEF at ${filePath} lacks a plan object`, confessed: [] };
  }
  const result = confessSentencesOnPlan(plan as Record<string, unknown>, options);
  if (!result.ok || result.confessed.length === 0) {
    return result;
  }
  const projectRoot =
    resolveProjectRoot(options.projectRoot, filePath) ?? dirname(dirname(dirname(filePath)));
  const write = atomicWriteBrief(filePath, data, dirname(dirname(filePath)), { projectRoot });
  if (!write.ok) {
    return { ok: false, message: write.message, confessed: [] };
  }
  return result;
}
