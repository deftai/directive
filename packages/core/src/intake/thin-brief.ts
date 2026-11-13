/**
 * Thin command-backed brief for the small-change lane (#6204).
 *
 * The emitter writes only title, issue ref, file_scope and acceptance commands
 * inside the xBRIEF 0.8 envelope (plus the required `status` / `items` keys and
 * the lane marker that names the lane-admit base). It emits only when a
 * supported command-backed acceptance record already exists. Otherwise the
 * caller keeps the full shape, and its derived acceptance stays as it is.
 *
 * The issue ref sits in `plan.references` (`x-xbrief/github-issue`) and
 * file_scope in `plan.metadata.swarm.file_scope`, the native locations the
 * delivery identity readers use (#3041 / #3675). Nothing here changes them.
 *
 * `escalateThinBriefToFullShape` is the lane exit: a scope-local conversion
 * that keeps scope identity and acceptance evidence. It is not the #3319
 * dial-depth raise.
 */

import {
  buildSmallChangeLaneMarker,
  readSmallChangeLaneMarker,
  SMALL_CHANGE_LANE_MARKER_KEY,
} from "../policy/small-change-lane.js";
import { validatePlanAcceptance } from "../product-first-done-gate/acceptance.js";
import { resolvePlanGithubIssueRef } from "../scope/delivery-evidence.js";

export const THIN_BRIEF_XBRIEF_VERSION = "0.8";

export interface ThinBriefIssueRef {
  /** `owner/repo`. */
  readonly repository: string;
  readonly issueNumber: number;
}

export interface ThinBriefInput {
  readonly title: string;
  readonly issue: ThinBriefIssueRef;
  readonly fileScope: readonly string[];
  /** The existing `plan.acceptance` record. Must be supported and command-backed. */
  readonly acceptance: unknown;
  /** Lane-admit base: the commit the bound is measured against. */
  readonly admitBase: string;
  /** Optional existing `plan.id`, kept as scope identity. */
  readonly planId?: string | null;
}

export type ThinBriefEmitResult =
  | { readonly ok: true; readonly brief: Record<string, unknown> }
  | { readonly ok: false; readonly keep: "full-shape"; readonly reason: string };

/** Acceptance records tied to the admitted source; their presence keeps the full shape. */
const SOURCE_SENTENCE_KEYS = [
  "sentences",
  "admitted_source_sentences",
  "admitted_source_digest",
] as const;

export interface CommandBackedAcceptanceCheck {
  readonly ok: boolean;
  readonly reason: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Supported command-backed acceptance record: stated commands (source_rung
 * `stated`, none_stated not true), at least one non-empty command, no clause
 * scaffolding, and no `validatePlanAcceptance` error.
 */
export function checkCommandBackedAcceptance(acceptance: unknown): CommandBackedAcceptanceCheck {
  const rec = asRecord(acceptance);
  if (rec === null) {
    return { ok: false, reason: "no plan.acceptance record" };
  }
  if (rec.none_stated === true) {
    return { ok: false, reason: "plan.acceptance is none_stated (derived acceptance)" };
  }
  if (rec.source_rung !== "stated") {
    return { ok: false, reason: 'plan.acceptance.source_rung is not "stated"' };
  }
  const commands = Array.isArray(rec.commands) ? rec.commands : [];
  const usable = commands.filter((c) => {
    const row = asRecord(c);
    return row !== null && typeof row.command === "string" && row.command.trim().length > 0;
  });
  if (usable.length === 0 || usable.length !== commands.length) {
    return { ok: false, reason: "plan.acceptance.commands has no usable command rows" };
  }
  if (Array.isArray(rec.clauses) && rec.clauses.length > 0) {
    return { ok: false, reason: "plan.acceptance carries clauses; the thin shape has none" };
  }
  // verify:ac's admitted-source identity gate (#5055) and sentence floor (#3550)
  // read these records. The thin shape cannot keep them without clauses, so a
  // brief that carries them keeps the full shape.
  for (const key of SOURCE_SENTENCE_KEYS) {
    if (rec[key] !== undefined && rec[key] !== null) {
      return { ok: false, reason: `plan.acceptance carries ${key}; the thin shape cannot keep it` };
    }
  }
  const errors = validatePlanAcceptance(rec);
  if (errors.length > 0) {
    return { ok: false, reason: errors.join("; ") };
  }
  return { ok: true, reason: "stated command-backed acceptance" };
}

const REPOSITORY_SHAPE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function keepFull(reason: string): ThinBriefEmitResult {
  return { ok: false, keep: "full-shape", reason };
}

/** Copy only the acceptance fields the thin shape keeps. */
function thinAcceptance(acceptance: Record<string, unknown>): Record<string, unknown> {
  return {
    commands: (acceptance.commands as unknown[]).map((c) => ({
      ...(c as Record<string, unknown>),
    })),
    none_stated: false,
    source_rung: "stated",
  };
}

/** Emit a thin brief, or tell the caller to keep the full shape. */
export function emitThinBrief(input: ThinBriefInput): ThinBriefEmitResult {
  const title = input.title.trim();
  if (title.length === 0) return keepFull("title is empty");
  if (!REPOSITORY_SHAPE.test(input.issue.repository)) {
    return keepFull("issue repository must be owner/repo");
  }
  if (!Number.isInteger(input.issue.issueNumber) || input.issue.issueNumber < 1) {
    return keepFull("issue number must be a positive integer");
  }
  const fileScope = [
    ...new Set(
      input.fileScope.map((p) => p.replace(/\\/g, "/").trim()).filter((p) => p.length > 0),
    ),
  ];
  if (fileScope.length === 0) return keepFull("file_scope is empty");
  const admitBase = input.admitBase.trim();
  if (admitBase.length === 0) return keepFull("no lane-admit base");
  const acceptanceCheck = checkCommandBackedAcceptance(input.acceptance);
  if (!acceptanceCheck.ok) return keepFull(acceptanceCheck.reason);

  const plan: Record<string, unknown> = {};
  if (typeof input.planId === "string" && input.planId.trim().length > 0) {
    plan.id = input.planId.trim();
  }
  plan.title = title;
  plan.status = "proposed";
  plan.items = [];
  plan.references = [
    {
      uri: `https://github.com/${input.issue.repository}/issues/${input.issue.issueNumber}`,
      type: "x-xbrief/github-issue",
      title: `Issue #${input.issue.issueNumber}`,
    },
  ];
  plan.acceptance = thinAcceptance(input.acceptance as Record<string, unknown>);
  plan.metadata = {
    swarm: { file_scope: fileScope },
    [SMALL_CHANGE_LANE_MARKER_KEY]: buildSmallChangeLaneMarker(admitBase),
  };
  return {
    ok: true,
    brief: { xBRIEFInfo: { version: THIN_BRIEF_XBRIEF_VERSION }, plan },
  };
}

/**
 * Emit a thin brief from an existing full brief. Keeps the full shape (and its
 * derived acceptance) when the acceptance is not command-backed.
 */
export function emitThinBriefFromFull(
  fullBrief: unknown,
  options: { readonly admitBase: string },
): ThinBriefEmitResult {
  const plan = asRecord(asRecord(fullBrief)?.plan);
  if (plan === null) return keepFull("brief has no plan object");
  const issue = resolvePlanGithubIssueRef(plan);
  if (issue === null) return keepFull("brief has no x-xbrief/github-issue reference");
  const swarm = asRecord(asRecord(plan.metadata)?.swarm);
  const fileScope = Array.isArray(swarm?.file_scope)
    ? swarm.file_scope.filter((p): p is string => typeof p === "string")
    : [];
  return emitThinBrief({
    title: typeof plan.title === "string" ? plan.title : "",
    issue: { repository: issue.repository, issueNumber: issue.issueNumber },
    fileScope,
    acceptance: plan.acceptance,
    admitBase: options.admitBase,
    planId: typeof plan.id === "string" ? plan.id : null,
  });
}

export type EscalateThinBriefResult =
  | { readonly ok: true; readonly brief: Record<string, unknown>; readonly message: string }
  | { readonly ok: false; readonly message: string };

function commandText(row: unknown): string {
  const rec = asRecord(row);
  return rec !== null && typeof rec.command === "string" ? rec.command.trim() : "";
}

/**
 * Lane exit (#6204): convert a thin brief to the full shape, in place of the
 * same scope. Keeps plan.id, plan.status, references, file_scope, the whole
 * acceptance record and all other metadata. Adds plan.narratives and one plan
 * item per acceptance command, and marks the lane `escalated`. The existing
 * gates then govern the scope. Does not change ceremony dial policy.
 */
export function escalateThinBriefToFullShape(brief: unknown): EscalateThinBriefResult {
  const root = asRecord(brief);
  const plan = asRecord(root?.plan);
  if (root === null || plan === null) {
    return { ok: false, message: "brief has no plan object" };
  }
  const marker = readSmallChangeLaneMarker(plan);
  if (!marker.present) {
    return { ok: false, message: "brief is not in the small-change lane (no lane marker)" };
  }
  if (!marker.ok) {
    return { ok: false, message: marker.reason };
  }
  const commands = (
    Array.isArray(asRecord(plan.acceptance)?.commands)
      ? (asRecord(plan.acceptance)?.commands as unknown[])
      : []
  )
    .map(commandText)
    .filter((c) => c.length > 0);
  if (commands.length === 0) {
    return { ok: false, message: "brief has no acceptance commands to carry into plan items" };
  }

  const title = typeof plan.title === "string" ? plan.title : "";
  const existingItems = Array.isArray(plan.items) ? plan.items : [];
  const items =
    existingItems.length > 0
      ? existingItems
      : commands.map((command, index) => ({
          id: `acceptance.${index + 1}`,
          title: `Acceptance command passes: ${command}`,
          status: "proposed",
          narrative: { Acceptance: `\`${command}\` exits 0.` },
        }));
  const narratives = {
    ...(asRecord(plan.narratives) ?? {}),
    Description:
      typeof asRecord(plan.narratives)?.Description === "string" &&
      (asRecord(plan.narratives)?.Description as string).trim().length > 0
        ? (asRecord(plan.narratives)?.Description as string)
        : title,
    LaneExit:
      "Converted from the small-change lane to the full brief shape (#6204). " +
      "Scope identity and acceptance evidence are unchanged.",
  };
  const metadata = {
    ...(asRecord(plan.metadata) ?? {}),
    // Keep crossedReason (if any) as the record of why the scope left the lane.
    [SMALL_CHANGE_LANE_MARKER_KEY]: {
      ...(asRecord(asRecord(plan.metadata)?.[SMALL_CHANGE_LANE_MARKER_KEY]) ?? {}),
      ...buildSmallChangeLaneMarker(marker.marker.admitBase, "escalated"),
    },
  };
  const nextPlan = { ...plan, narratives, items, metadata };
  return {
    ok: true,
    brief: { ...root, plan: nextPlan },
    message: "converted to the full brief shape; the existing gates now govern this scope (#6204)",
  };
}
