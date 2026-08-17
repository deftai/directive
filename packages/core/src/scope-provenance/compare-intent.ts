/**
 * Public compare entry for extracted intent (#3376 R2 / R5 / #3385 F1–F2).
 *
 * Scalars are byte-equal after canonicalize. Decisions and references[] are
 * guarded-append. Unclassified key only when unknown AND absent from base.
 */

import { DECISION_FILE_SUFFIX, DECISIONS_DIR_REL } from "../decision/schema.js";
import { GITHUB_ISSUE_REF_TYPES } from "../intake/reconcile-issues.js";
import { type IntentPreimage, slugFromGithubIssueUri } from "./extract-intent.js";
import { sortKeysDeep } from "./intent-digest.js";
import { classifyPlanPath } from "./known-machine.js";

const EM_DASH = "\u2014";
const DECISION_LINE = new RegExp(
  `^- (${DECISIONS_DIR_REL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[^\\s]+${DECISION_FILE_SUFFIX.replace(".", "\\.")}) ${EM_DASH} (.+)$`,
);

export type IntentCompareKind =
  | "intent-drift"
  | "unclassified-key"
  | "reference-mutation"
  | "decisions-mutation"
  | "repo-not-approved"
  | "ref-type-not-appendable"
  | "decision-pointer-missing";

export interface IntentCompareFinding {
  readonly kind: IntentCompareKind;
  readonly path: string;
  readonly detail: string;
}

export interface IntentCompareResult {
  readonly ok: boolean;
  readonly findings: readonly IntentCompareFinding[];
}

export interface CompareIntentOptions {
  readonly changedFiles?: readonly string[];
  readonly decisionExists?: (relPath: string) => boolean;
}

function canon(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function splitDecisionLines(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function refKey(ref: Record<string, unknown>): string {
  return `${String(ref.type ?? "")}\n${String(ref.uri ?? "")}`;
}

function narrativesOf(plan: Record<string, unknown>): Record<string, unknown> {
  return asRecord(plan.narratives) ?? {};
}

function compareScalars(
  basePlan: Record<string, unknown>,
  livePlan: Record<string, unknown>,
  findings: IntentCompareFinding[],
): void {
  const skip = new Set(["references", "narratives", "items", "parentId"]);
  const keys = new Set([...Object.keys(basePlan), ...Object.keys(livePlan)]);
  for (const key of keys) {
    if (skip.has(key)) continue;
    if (key === "metadata") {
      if (canon(basePlan.metadata) !== canon(livePlan.metadata)) {
        findings.push({
          kind: "intent-drift",
          path: "metadata",
          detail: "extracted metadata drifted from the base preimage",
        });
      }
      continue;
    }
    if (canon(basePlan[key]) !== canon(livePlan[key])) {
      findings.push({
        kind: "intent-drift",
        path: key,
        detail: `extracted ${key} drifted from the base preimage`,
      });
    }
  }
}

function compareItems(
  baseItems: unknown,
  liveItems: unknown,
  findings: IntentCompareFinding[],
): void {
  if (canon(baseItems ?? []) !== canon(liveItems ?? [])) {
    findings.push({
      kind: "intent-drift",
      path: "items",
      detail: "extracted items drifted from the base preimage",
    });
  }
}

function compareNarratives(
  basePlan: Record<string, unknown>,
  livePlan: Record<string, unknown>,
  options: CompareIntentOptions,
  findings: IntentCompareFinding[],
): void {
  const baseN = narrativesOf(basePlan);
  const liveN = narrativesOf(livePlan);
  const keys = new Set([...Object.keys(baseN), ...Object.keys(liveN)]);
  for (const key of keys) {
    if (key === "Decisions") continue;
    if (canon(baseN[key]) !== canon(liveN[key])) {
      findings.push({
        kind: "intent-drift",
        path: `narratives.${key}`,
        detail: `extracted narratives.${key} drifted from the base preimage`,
      });
    }
  }

  const baseLines = splitDecisionLines(baseN.Decisions);
  const liveLines = splitDecisionLines(liveN.Decisions);
  if (liveLines.length < baseLines.length) {
    findings.push({
      kind: "decisions-mutation",
      path: "narratives.Decisions",
      detail: "Decisions lines were deleted; preimage lines are law",
    });
    return;
  }
  for (let i = 0; i < baseLines.length; i += 1) {
    if (liveLines[i] !== baseLines[i]) {
      findings.push({
        kind: "decisions-mutation",
        path: "narratives.Decisions",
        detail: "existing Decisions lines were edited; only append is allowed",
      });
      return;
    }
  }
  const changed = new Set((options.changedFiles ?? []).map((p) => p.replace(/\\/g, "/")));
  for (const line of liveLines.slice(baseLines.length)) {
    const m = DECISION_LINE.exec(line);
    if (m === null) {
      findings.push({
        kind: "decisions-mutation",
        path: "narratives.Decisions",
        detail: `appended Decisions line is not '- <${DECISIONS_DIR_REL}>/…${DECISION_FILE_SUFFIX} ${EM_DASH} <summary>'`,
      });
      continue;
    }
    const rel = m[1] ?? "";
    const onBaseOrChange = changed.has(rel) || Boolean(options.decisionExists?.(rel));
    if (!onBaseOrChange) {
      findings.push({
        kind: "decision-pointer-missing",
        path: "narratives.Decisions",
        detail: `Decisions pointer ${rel} is not on base and not in the change set`,
      });
    }
  }
}

function compareReferences(
  base: IntentPreimage,
  live: IntentPreimage,
  findings: IntentCompareFinding[],
): void {
  const baseRefs = Array.isArray(base.plan.references)
    ? (base.plan.references as Record<string, unknown>[])
    : [];
  const liveRefs = Array.isArray(live.plan.references)
    ? (live.plan.references as Record<string, unknown>[])
    : [];
  const liveByKey = new Map<string, Record<string, unknown>>();
  for (const ref of liveRefs) {
    liveByKey.set(refKey(ref), ref);
  }
  for (const ref of baseRefs) {
    const key = refKey(ref);
    const liveRef = liveByKey.get(key);
    if (liveRef === undefined) {
      findings.push({
        kind: "reference-mutation",
        path: "references",
        detail: `origin reference removed: ${String(ref.uri ?? "")}`,
      });
      continue;
    }
    if (canon(ref) !== canon(liveRef)) {
      findings.push({
        kind: "reference-mutation",
        path: "references",
        detail: `origin reference edited: ${String(ref.uri ?? "")}`,
      });
    }
  }
  const baseKeys = new Set(baseRefs.map(refKey));
  const approved = new Set(base.approvedRepos.map((s) => s.toLowerCase()));
  for (const ref of liveRefs) {
    if (baseKeys.has(refKey(ref))) continue;
    const type = String(ref.type ?? "");
    if (!GITHUB_ISSUE_REF_TYPES.has(type)) {
      findings.push({
        kind: "ref-type-not-appendable",
        path: "references",
        detail: `appended reference type ${JSON.stringify(type)} is not in GITHUB_ISSUE_REF_TYPES`,
      });
      continue;
    }
    const uri = typeof ref.uri === "string" ? ref.uri : "";
    const slug = slugFromGithubIssueUri(uri);
    if (slug === null || !approved.has(slug)) {
      findings.push({
        kind: "repo-not-approved",
        path: "references",
        detail: `appended github-issue URL is not in the base preimage approvedRepos: ${uri}`,
      });
    }
  }
}

function compareUnknownKeys(
  base: IntentPreimage,
  live: IntentPreimage,
  findings: IntentCompareFinding[],
): void {
  const baseUnknown = new Set(base.unknownPaths);
  const basePlan = asRecord(base.plan) ?? {};
  for (const path of live.unknownPaths) {
    if (baseUnknown.has(path)) continue;
    const top = path.split(".")[0] ?? path;
    if (top in basePlan && classifyPlanPath(top) === "unknown") continue;
    const parts = path.split(".");
    let cursor: unknown = base.plan;
    let present = true;
    for (const part of parts) {
      const rec = asRecord(cursor);
      if (rec === null || !(part in rec)) {
        present = false;
        break;
      }
      cursor = rec[part];
    }
    if (present) continue;
    findings.push({
      kind: "unclassified-key",
      path,
      detail: `unclassified key ${path} is absent from the base preimage`,
    });
  }
}

/**
 * Compare a live extraction to the base-committed preimage.
 * One entry point covers scalar equality and guarded append (R2 / R5).
 */
export function compareExtractedIntent(
  base: IntentPreimage,
  live: IntentPreimage,
  options: CompareIntentOptions = {},
): IntentCompareResult {
  const findings: IntentCompareFinding[] = [];
  const basePlan = asRecord(base.plan) ?? {};
  const livePlan = asRecord(live.plan) ?? {};

  if (canon(basePlan.parentId) !== canon(livePlan.parentId)) {
    findings.push({
      kind: "intent-drift",
      path: "parentId",
      detail: "parent identity changed (silent reparent)",
    });
  }

  compareScalars(basePlan, livePlan, findings);
  compareItems(basePlan.items, livePlan.items, findings);
  compareNarratives(basePlan, livePlan, options, findings);
  compareReferences(base, live, findings);
  compareUnknownKeys(base, live, findings);

  return { ok: findings.length === 0, findings };
}
