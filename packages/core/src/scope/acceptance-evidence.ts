/**
 * Per-acceptance-criterion evidence / disposition for scope:complete (#3240 / epic #3237 Q3).
 *
 * Merge ancestry alone must not auto-complete acceptance items. Each non-terminal
 * plan item needs either typed evidence or a human-origin disposition before complete
 * may advance it. Kind suitability: merge/review alone cannot satisfy smoke, UAT,
 * deploy, or observed_behavior requirements.
 *
 * Canonical item keys are namespaced under #1620 / #3305 (Option B):
 * - plan.items[].x-directive/evidence
 * - plan.items[].x-directive/disposition
 * - plan.items[].x-directive/requires (merge / strict-axis declaration; #5105)
 * Bare `evidence` / `disposition` are not valid typed evidence (no dual-read).
 * Bare `requires` / `requiredEvidenceKind` / `acceptanceAxis` still dual-read for
 * declaration, but fail verify:vbrief-conformance — prefer the namespaced key.
 * ITEM_CORE is not expanded with bare keys; verify:vbrief-conformance rejects them.
 */

import { resolve } from "node:path";
import { isHumanOrigin } from "../authz/origin.js";
import { type GrantOrigin, HUMAN_ORIGIN_KINDS } from "../authz/types.js";
import {
  SCOPE_COMPLETE_ZERO_VERIFIED_NOTICE,
  scopeCompleteRejectsZeroVerifiedWalk,
} from "../check/rapid-zero-verified.js";
import type { DeclaredTestCommand } from "../consumer-test-lane/evaluate.js";
import type { LiteralAcceptanceCommand } from "../literal-acceptance/types.js";
import {
  type AcceptancePredicate,
  formatAcceptanceVerdict,
  resolveAcceptanceGateProfile,
  resolveAcceptanceVerdict,
} from "../product-first-done-gate/acceptance-resolver.js";
import {
  type EvaluateVerifyAcOptions,
  evaluateVerifyAcFromPlan,
  resolveAcceptanceCommandRecords,
  type VerifyAcResult,
} from "../product-first-done-gate/evaluate.js";
import type { GitRunner } from "../session/git.js";
import {
  isMatchAnyFilePointer,
  readAcceptanceClauses,
  readDeclaredArtifactScope,
  stripInlineMarkdownBold,
} from "../verify-ac/clauses.js";
import { verifyDeliveryAncestry } from "./delivery-evidence.js";
import { utcNowIso } from "./vbrief-json.js";

/**
 * Recordable GrantOrigin shape for missing-path / field-spec disclosure (#4877).
 * Matches isHumanOrigin + fixtures (kind closed set + non-agent actor example).
 * Bare "human-origin" strings remain rejected; this is guidance only.
 */
const DISPOSITION_PROVENANCE_SHAPE = `{kind: ${HUMAN_ORIGIN_KINDS.join("|")}, actor: <non-agent, e.g. operator@example.com>}`;

/** Canonical namespaced key for typed acceptance evidence (#3305 / #1620). */
export const ACCEPTANCE_EVIDENCE_KEY = "x-directive/evidence" as const;

/** Canonical namespaced key for human-origin disposition (#3305 / #1620). */
export const ACCEPTANCE_DISPOSITION_KEY = "x-directive/disposition" as const;

/**
 * Canonical namespaced acceptance-requirement declaration (#5105 / #1620).
 * Value is a single token (`merge` or a STRICT_ACCEPTANCE_AXES member).
 * Prefer this over bare `requires` so briefs pass verify:vbrief-conformance.
 */
export const ACCEPTANCE_REQUIRES_KEY = "x-directive/requires" as const;

/** Closed evidence kinds (locked Q3). */
export const ACCEPTANCE_EVIDENCE_KINDS = [
  "test",
  "review",
  "merge",
  "deploy",
  "smoke",
  "uat",
  "observed_behavior",
] as const;

export type AcceptanceEvidenceKind = (typeof ACCEPTANCE_EVIDENCE_KINDS)[number];

/** Closed dispositions (locked Q3). */
export const ACCEPTANCE_DISPOSITIONS = ["waived", "deferred", "not_applicable"] as const;

export type AcceptanceDispositionKind = (typeof ACCEPTANCE_DISPOSITIONS)[number];

/**
 * Axes that merge/review evidence alone cannot satisfy.
 * Matches epic #3237 Q3 suitability rule.
 * `merge` is declarable on requires / requiredEvidenceKind / acceptanceAxis
 * but MUST stay outside this set (#5105) — folding it in would reject kind:merge.
 */
export const STRICT_ACCEPTANCE_AXES = ["deploy", "smoke", "uat", "observed_behavior"] as const;

export type StrictAcceptanceAxis = (typeof STRICT_ACCEPTANCE_AXES)[number];

/** Explicit field token for a merge evidence requirement (#5105). Not a strict axis. */
export const MERGE_ACCEPTANCE_REQUIREMENT = "merge" as const;

const EVIDENCE_KIND_SET = new Set<string>(ACCEPTANCE_EVIDENCE_KINDS);
const DISPOSITION_SET = new Set<string>(ACCEPTANCE_DISPOSITIONS);
const STRICT_AXIS_SET = new Set<string>(STRICT_ACCEPTANCE_AXES);

/**
 * kind:uat write-time pointer shape (#4563).
 *
 * Assumptions: pointer is a path/symbol token string (no NLP). Probe artifacts live
 * under repo-root uat-evidence/** after POSIX-separator normalize.
 * Guarantees: .. / absolute paths are not probes (no collapse-then-prefix);
 * test/spec and path#Symbol stay denied even under uat-evidence/; camelCase
 * and PR/CHANGELOG substrings in probe filenames are allowed.
 * Non-goals: completed-tracked re-audit; uatVerified as independent evidence;
 * human-origin on kind:uat recorded_by.
 */
const UAT_TEST_SPEC_POINTER = /\.test\.|\.spec\./i;
const UAT_EVIDENCE_ROOT = "uat-evidence";

export const UAT_POINTER_SHAPE_REMEDIATION =
  "evidence kind mismatch: kind 'uat' with a test/source pointer — point at a UAT probe " +
  "artifact (uat-evidence/**), or relabel 'test' (#4563)";

export const TEST_POINTER_SHAPE_REMEDIATION =
  "evidence kind mismatch: kind 'test' with a non-test artifact pointer — point at a test " +
  "or declared code file, not markdown/CHANGELOG/PR prose (#5105)";

export const MERGE_POINTER_SHAPE_REMEDIATION =
  "evidence kind mismatch: kind 'merge' with a non-commit pointer — point at a git commit " +
  "sha (7–40 hex) that is an ancestor of the delivery tip (#5105)";

/** Item statuses that still represent unfinished acceptance work (#2862 / #3240). */
const NON_TERMINAL_ITEM_STATUSES = new Set(["pending", "proposed", "running"]);

/**
 * Recognized fail/cancel/historical terminals that may use the already_terminal
 * skip after landing-set evidence checks (#4879 Prefer-A / lean 5781675816 / #3819).
 * Missing or unrecognized statuses are not in this set and no longer default-open.
 */
const COMPLETED_LANDING_WITHOUT_EVIDENCE_STATUSES = new Set([
  "completed",
  "complete",
  "failed",
  "cancelled",
  "blocked",
  "draft",
  "approved",
  "auto",
]);

/** Stable plan.item id for a clause so stampNamespacedEvidence has a row (#4385 / #4707). */
export const CLAUSE_KEYED_ITEM_ID_PREFIX = "clause." as const;

/** Pre-#4707 persist prefix. Dual-read only — not a second mint. */
const LEGACY_CLAUSE_KEYED_ITEM_ID_PREFIX = "clause:" as const;
const LEGACY_CLAUSE_KEYED_ITEM_ID_RE = /^clause:(\d+)$/;

/** `clause.N` or leftover `clause:N` ids (#5193 title-follows-id placeholders). */
const CLAUSE_KEYED_PLACEHOLDER_ID_RE = /^clause[.:](\d+)$/;

/**
 * True when a plan item is a clause-keyed title-follows-id placeholder (#5193).
 * Id is `clause.N` or leftover `clause:N`, title is empty or equal to that id,
 * and `narrative.Acceptance` is absent/empty. Do not treat every `clause.`-prefixed
 * id as a placeholder — authored titles and Acceptance narrative stay visible.
 */
export function isClauseKeyedTitleFollowsIdPlaceholder(item: Record<string, unknown>): boolean {
  const id = typeof item.id === "string" ? item.id.trim() : "";
  if (!CLAUSE_KEYED_PLACEHOLDER_ID_RE.test(id)) {
    return false;
  }
  const narrative =
    typeof item.narrative === "object" && item.narrative !== null && !Array.isArray(item.narrative)
      ? (item.narrative as Record<string, unknown>)
      : null;
  const acceptance = narrative?.Acceptance;
  if (typeof acceptance === "string" && acceptance.trim().length > 0) {
    return false;
  }
  const title = typeof item.title === "string" ? item.title.trim() : "";
  return title.length === 0 || title === id;
}

/**
 * Leftover of #4385 defect 2: pending change-task ledger
 * (history/changes/.../tasks.xbrief.json) is not closed by this P1.
 * Prefer derive-status over a second walker. #4426 owns the issue-less origin half.
 * Not an exported production symbol.
 */

export interface AcceptanceEvidenceRecord {
  readonly kind: AcceptanceEvidenceKind;
  readonly pointer: string;
  readonly recorded_at: string;
  readonly recorded_by: string;
}

export interface AcceptanceDispositionRecord {
  readonly disposition: AcceptanceDispositionKind;
  readonly reason: string;
  /**
   * Human-origin provenance (kind + actor required; other GrantOrigin fields optional).
   * `grantId` names the acceptance-disposition grant that wrote it (#6318).
   */
  readonly provenance: Pick<GrantOrigin, "kind" | "actor"> &
    Partial<GrantOrigin> & { readonly grantId?: string };
  readonly recorded_at: string;
  readonly resume_when?: string;
  /** Issue a `deferred` item moved to (#6318 grant). */
  readonly deferred_to?: string;
}

export interface CriterionAcceptanceReport {
  readonly path: string;
  readonly title: string;
  readonly outcome: "evidence" | "disposition" | "already_terminal" | "missing" | "invalid";
  readonly detail: string;
  readonly evidence?: AcceptanceEvidenceRecord;
  readonly disposition?: AcceptanceDispositionRecord;
}

export interface AcceptanceEvidenceGateResult {
  readonly ok: boolean;
  readonly message: string;
  readonly reports: readonly CriterionAcceptanceReport[];
  /** How the #3357 walk obtained AC (#3387). */
  readonly servedFrom?: "bank" | "cache" | "executed" | "refused";
  /** Which acceptance check decided the walk (#3497). Undefined when no walk ran. */
  readonly predicate?: AcceptancePredicate;
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

function posixPointer(pointer: string): string {
  return pointer.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Contained uat-evidence/** probe path: first segment must be the root after
 * dropping . and empty parts. .. and absolute paths fail closed (no collapse).
 */
function isContainedUatEvidencePath(p: string): boolean {
  if (p.startsWith("/") || /^[A-Za-z]:\//.test(p)) {
    return false;
  }
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      return false;
    }
    out.push(part);
  }
  return out.length >= 2 && out[0] === UAT_EVIDENCE_ROOT;
}

/**
 * Fail-closed kind:uat pointer shape at write (#4563).
 * Positive allow: contained uat-evidence/**. Replay deny: test/spec, hash symbol.
 * Source / PR / CHANGELOG pointers fail the allow (they are not under uat-evidence).
 * Does not read uatVerified. Does not require human-origin on recorded_by.
 */
function uatPointerShapeError(pointer: string): string | null {
  const p = posixPointer(pointer);
  const denied = p.includes("#") || UAT_TEST_SPEC_POINTER.test(p) || !isContainedUatEvidencePath(p);
  return denied ? UAT_POINTER_SHAPE_REMEDIATION : null;
}

/**
 * kind:test must not point at markdown / CHANGELOG / bare PR prose (#5105).
 * Declared source files (including #4840 matchAny stamps) remain allowed.
 */
function testPointerShapeError(pointer: string): string | null {
  const p = posixPointer(pointer);
  if (/\.md$/i.test(p) || /(^|\/)changelog(\.md)?$/i.test(p) || /^pr\s*#?\d+$/i.test(p)) {
    return TEST_POINTER_SHAPE_REMEDIATION;
  }
  return null;
}

/** kind:merge pointer must be a git commit sha (7–40 hex) (#5105). */
function mergePointerShapeError(pointer: string): string | null {
  const p = pointer.trim();
  if (/^[0-9a-f]{7,40}$/i.test(p)) {
    return null;
  }
  return MERGE_POINTER_SHAPE_REMEDIATION;
}

/**
 * Stamp-time kind-versus-pointer coherence for human and agent stamps (#5105).
 * Extends uatPointerShapeError; recorded_by stays non-authoritative.
 */
export function evidencePointerShapeError(
  kind: AcceptanceEvidenceKind,
  pointer: string,
): string | null {
  if (kind === "uat") {
    return uatPointerShapeError(pointer);
  }
  if (kind === "test") {
    return testPointerShapeError(pointer);
  }
  if (kind === "merge") {
    return mergePointerShapeError(pointer);
  }
  return null;
}

/**
 * The values of the eight declaration fields, in this fixed order (#5105).
 * This is the one field list; other modules compare these values instead of
 * naming the fields again (#6591).
 */
export function readExplicitAcceptanceRequirementFields(
  item: Record<string, unknown>,
): readonly unknown[] {
  return [
    // Namespaced first — conformant declaration path (#5105 / #1620).
    item[ACCEPTANCE_REQUIRES_KEY],
    item["x-directive/requiredEvidenceKind"],
    item["x-directive/acceptanceAxis"],
    // Bare dual-read (fails vbrief-conformance; keep for migration / tests).
    item.requires,
    item.requiredEvidenceKind,
    item.required_evidence_kind,
    item.acceptanceAxis,
    item.acceptance_axis,
  ];
}

function normalizeRequirementToken(raw: string): string {
  return raw.trim().toLowerCase().replace(/-/g, "_");
}

/**
 * True when the criterion explicitly declares merge on x-directive/requires
 * (or bare dual-read requires / requiredEvidenceKind / acceptanceAxis) (#5105).
 * Never inferred from keywords.
 */
export function itemDeclaresMergeRequirement(item: Record<string, unknown>): boolean {
  for (const raw of readExplicitAcceptanceRequirementFields(item)) {
    if (typeof raw !== "string") continue;
    if (normalizeRequirementToken(raw) === MERGE_ACCEPTANCE_REQUIREMENT) {
      return true;
    }
  }
  return false;
}

export function isAcceptanceEvidenceKind(value: unknown): value is AcceptanceEvidenceKind {
  return typeof value === "string" && EVIDENCE_KIND_SET.has(value.trim().toLowerCase());
}

export function isAcceptanceDispositionKind(value: unknown): value is AcceptanceDispositionKind {
  return typeof value === "string" && DISPOSITION_SET.has(value.trim().toLowerCase());
}

/**
 * Infer strict axes a criterion requires from explicit fields and title/Acceptance text.
 * Explicit `requires` / `requiredEvidenceKind` / `acceptanceAxis` wins when valid.
 * Merge-only declaration short-circuits free-text to [] (#5105). When merge AND a
 * strict axis are both declared (e.g. requires=merge + acceptanceAxis=smoke), keep
 * the strict axis — do not hide it behind the merge short-circuit (Greptile P1).
 *
 * Code formatting is not a name signal (#6301). Deploy, smoke and UAT also match
 * inside code spans and fenced blocks, because the same formatting holds real
 * claims ("`npm run deploy` succeeds") as well as names ("the `deploy` job").
 * No strip or filter runs on code. To clear an axis that a clause only names,
 * reword the clause or declare x-directive/requires on the item (merge, or the
 * one axis the clause does need).
 */
export function inferRequiredStrictAxes(item: Record<string, unknown>): StrictAcceptanceAxis[] {
  let sawMerge = false;
  let explicitStrict: StrictAcceptanceAxis | null = null;
  for (const raw of readExplicitAcceptanceRequirementFields(item)) {
    if (typeof raw !== "string") continue;
    const norm = normalizeRequirementToken(raw);
    if (norm === MERGE_ACCEPTANCE_REQUIREMENT) {
      sawMerge = true;
      continue;
    }
    if (STRICT_AXIS_SET.has(norm) && explicitStrict === null) {
      explicitStrict = norm as StrictAcceptanceAxis;
    }
  }
  if (explicitStrict !== null) {
    return [explicitStrict];
  }
  if (sawMerge) {
    return [];
  }
  return inferTextStrictAxes(item);
}

/**
 * Axes the item's declaration hides (#6591): the axes inferred with the eight
 * declaration fields ignored, minus the axes inferred as written. Empty when
 * no declaration hides a text-inferred axis.
 */
export function inferHiddenStrictAxes(item: Record<string, unknown>): StrictAcceptanceAxis[] {
  // No string declaration: the as-written axes are the text axes, so none hide.
  if (!readExplicitAcceptanceRequirementFields(item).some((raw) => typeof raw === "string")) {
    return [];
  }
  const written = inferRequiredStrictAxes(item);
  return inferTextStrictAxes(item).filter((axis) => !written.includes(axis));
}

/** Axes from title, id and narrative text alone; no declaration field is read. */
function inferTextStrictAxes(item: Record<string, unknown>): StrictAcceptanceAxis[] {
  const narrative = asRecord(item.narrative);
  const parts: string[] = [];
  if (typeof item.title === "string") parts.push(item.title);
  if (typeof item.id === "string") parts.push(item.id);
  if (narrative !== null) {
    for (const key of ["Acceptance", "acceptance", "Description", "description", "Test", "test"]) {
      if (typeof narrative[key] === "string") parts.push(narrative[key] as string);
    }
  }
  const raw = parts.join("\n").toLowerCase();
  // deploy / smoke / UAT match prose only (#6270); observed_behavior keeps `raw`.
  const text = splitAxisAlternations(raw);
  const found: StrictAcceptanceAxis[] = [];
  // Order: longer / more specific phrases first so "observed behavior" wins over generic.
  if (
    /\bobserved[_\s-]?behavior\b/.test(raw) ||
    /\bobserved behaviour\b/.test(raw) ||
    /\brunning behaviour\b/.test(raw) ||
    /\brunning behavior\b/.test(raw)
  ) {
    found.push("observed_behavior");
  }
  if (PROSE_UAT.test(text) || PROSE_USER_ACCEPTANCE.test(text)) {
    found.push("uat");
  }
  if (PROSE_SMOKE.test(text)) {
    found.push("smoke");
  }
  if (PROSE_DEPLOY.test(text)) {
    found.push("deploy");
  }
  return found;
}

/**
 * Prose-only boundaries for the deploy / smoke / UAT axis words (#6270).
 * `\b` treats `-`, `.`, `_` and `/` as boundaries, so names such as
 * `deploy-dev`, `deploy.yml`, `deploy_prod` and `smoke-test.ts` matched.
 * Left: no word char, `.`, `/` or `-` before the word. Right: no word char or
 * `-` after it, and no `.` / `/` that joins another word char (`deploy.yml`),
 * so sentence-final "after deployment." still matches.
 */
const PROSE_LEFT = String.raw`(?<![\w./-])`;
const PROSE_RIGHT = String.raw`(?![\w-]|[./]\w)`;
function proseWord(body: string): RegExp {
  return new RegExp(`${PROSE_LEFT}${body}${PROSE_RIGHT}`);
}
const PROSE_UAT = proseWord("uat");
const PROSE_USER_ACCEPTANCE = proseWord(String.raw`user\s+acceptance`);
const PROSE_SMOKE = proseWord("smoke");
const PROSE_DEPLOY = proseWord("deploy(?:ment|ed|s)?");

/** One axis word, for slash alternations such as "smoke/UAT" (#6270). */
const AXIS_WORD = "(?:deploy(?:ment|ed|s)?|smoke|uat)";
const AXIS_ALTERNATION = new RegExp(
  `${PROSE_LEFT}${AXIS_WORD}(?:/${AXIS_WORD})+${PROSE_RIGHT}`,
  "g",
);

/**
 * Split a slash list made only of axis words ("smoke/uat", "deploy/smoke")
 * into prose, so each word keeps its axis. Paths such as `scripts/smoke.sh`
 * or `.github/workflows/deploy` do not match and stay names (#6270).
 */
function splitAxisAlternations(text: string): string {
  return text.replace(AXIS_ALTERNATION, (run) => run.replaceAll("/", " / "));
}

/** One plan item that scope:complete will hold to strict-axis evidence (#6272). */
export interface StrictAxisRequirement {
  /** JSON path of the item, e.g. `plan.items[2]`. */
  readonly path: string;
  /** Item id when it is a non-empty string, else null. */
  readonly id: string | null;
  readonly axes: readonly StrictAcceptanceAxis[];
  /**
   * True on a declared row (#6591): `axes` are the text axes the item's
   * declaration hides, and scope:complete does not hold the item to them.
   */
  readonly declared?: true;
}

/** Item id when it is a non-empty string (trimmed), else null. */
export function strictAxisItemId(item: Record<string, unknown>): string | null {
  return typeof item.id === "string" && item.id.trim().length > 0 ? item.id.trim() : null;
}

/**
 * Visit each plan item in the completion gate's tree order (items, subItems,
 * nested items) with its JSON path, e.g. `plan.items[2].subItems[0]`.
 */
export function forEachStrictAxisItem(
  plan: unknown,
  visit: (item: Record<string, unknown>, path: string) => void,
): void {
  const walk = (items: unknown, prefix: string): void => {
    if (!Array.isArray(items)) {
      return;
    }
    items.forEach((raw, index) => {
      const item = asRecord(raw);
      if (item === null) {
        return;
      }
      const path = `${prefix}[${index}]`;
      visit(item, path);
      walk(item.subItems, `${path}.subItems`);
      walk(item.items, `${path}.items`);
    });
  };
  walk(asRecord(plan)?.items, "plan.items");
}

/**
 * List the plan items that scope:complete will hold to strict-axis evidence (#6272).
 *
 * Pure function of the brief text: no git, network or evidence input. It walks
 * the same item tree as the completion gate (items, subItems, nested items) and
 * calls inferRequiredStrictAxes, the function the gate calls, so the listing at
 * activation, promote and preflight cannot drift from completion.
 *
 * An item whose declaration hides text axes also gets a row marked `declared`
 * with those axes (#6591). Only rows that are not declared match the gate.
 */
export function listStrictAxisRequirements(plan: unknown): StrictAxisRequirement[] {
  const found: StrictAxisRequirement[] = [];
  forEachStrictAxisItem(plan, (item, path) => {
    const id = strictAxisItemId(item);
    const axes = inferRequiredStrictAxes(item);
    if (axes.length > 0) {
      found.push({ path, id, axes });
    }
    const hidden = inferHiddenStrictAxes(item);
    if (hidden.length > 0) {
      found.push({ path, id, axes: hidden, declared: true });
    }
  });
  return found;
}

/** The verb that prints the strict-axis advisory (#6591 item 6). */
export type StrictAxisAdvisoryVerb = "scope:promote" | "scope:activate" | "xbrief:preflight";

/**
 * Advisory lines for listStrictAxisRequirements (#6272). Empty when no item
 * has a row. Callers print these; they never change an exit code.
 *
 * The count in the first line covers only rows that are not declared, the
 * items the completion gate holds. Declared rows follow, marked (#6591). At
 * promote and activate the last line says how to change the list, including
 * a declaration; at xbrief:preflight (an active brief) it does not suggest
 * a declaration.
 */
export function formatStrictAxisAdvisory(
  requirements: readonly StrictAxisRequirement[],
  verb: StrictAxisAdvisoryVerb,
): string[] {
  if (requirements.length === 0) {
    return [];
  }
  const required = requirements.filter((req) => req.declared !== true);
  const declared = requirements.filter((req) => req.declared === true);
  const lines = [
    `[deft scope] advisory: ${required.length} clause(s) will need strict-axis evidence ` +
      "at scope:complete (#6272):",
  ];
  for (const req of required) {
    lines.push(`  ${req.id ?? req.path}: ${req.axes.join(", ")}`);
  }
  if (declared.length > 0) {
    lines.push(
      `  ${declared.length} declared clause(s): the item's declaration hides these text axes, ` +
        "so scope:complete does not require them (#6591):",
    );
    for (const req of declared) {
      lines.push(`  ${req.id ?? req.path}: ${req.axes.join(", ")} (declared)`);
    }
  }
  lines.push(
    verb === "xbrief:preflight"
      ? "  Advisory only; exit code unchanged."
      : `  To change this, reword the clause or declare ${ACCEPTANCE_REQUIRES_KEY} ` +
          `(${MERGE_ACCEPTANCE_REQUIREMENT} or one axis) on the item. Advisory only; exit code unchanged.`,
  );
  return lines;
}

/** Advisory lines for a parsed brief (`{ plan }`) or a bare plan object (#6272). */
export function strictAxisAdvisoryLines(
  briefOrPlan: unknown,
  verb: StrictAxisAdvisoryVerb,
): string[] {
  const record = asRecord(briefOrPlan);
  if (record === null) {
    return [];
  }
  const plan = "plan" in record ? record.plan : record;
  return formatStrictAxisAdvisory(listStrictAxisRequirements(plan), verb);
}

/**
 * Whether evidence.kind is suitable for the criterion's required strict axes.
 * merge and review never satisfy smoke/UAT/deploy/observed_behavior.
 *
 * Suitability dual for merge (#5105): a declared merge requirement accepts
 * kind:merge; kind:merge is suitable only when merge is explicitly declared —
 * empty-axis / undeclared must refuse kind:merge.
 *
 * A single evidence.kind covers only that axis. When free-text inference yields
 * multiple axes (e.g. "smoke after deploy"), every required axis must match the
 * same kind — which is only possible when the axes are identical. Otherwise use
 * explicit `requires` / `acceptanceAxis` for a single axis, split the criterion,
 * or record a human-origin disposition (#3240 Greptile P1).
 */
export function isEvidenceKindSuitable(
  kind: AcceptanceEvidenceKind,
  requiredAxes: readonly StrictAcceptanceAxis[],
  options: { readonly mergeDeclared?: boolean } = {},
): boolean {
  const mergeDeclared = options.mergeDeclared === true;
  if (kind === "merge") {
    return mergeDeclared && requiredAxes.length === 0;
  }
  if (requiredAxes.length === 0) {
    return true;
  }
  if (kind === "review") {
    return false;
  }
  // All required strict axes must be covered by this single evidence kind.
  return requiredAxes.every((axis) => kind === axis);
}

/**
 * Structural x-directive/evidence parse.
 * requirePointerShape:false has two sanctioned uses:
 * (a) landing-set structural probe that re-tightens for non-uat (#4563 / #4879);
 * (b) stampMatchAnyFileEvidence repair reader that keeps the loose parse for
 *     kind:test shape-bad rows (#5382). Empty {} / missing fields still refuse
 * (Greptile P1 / #4879).
 */
function parseEvidence(
  raw: unknown,
  options: { readonly requirePointerShape?: boolean } = {},
):
  | {
      ok: true;
      record: AcceptanceEvidenceRecord;
    }
  | {
      ok: false;
      message: string;
    } {
  const requirePointerShape = options.requirePointerShape !== false;
  const obj = asRecord(raw);
  if (obj === null) {
    return { ok: false, message: "evidence must be an object" };
  }
  const allowedEvidenceKeys = new Set(["kind", "pointer", "recorded_at", "recorded_by"]);
  const extra = Object.keys(obj)
    .filter((k) => !allowedEvidenceKeys.has(k))
    .sort((a, b) => a.localeCompare(b));
  if (extra.length > 0) {
    return {
      ok: false,
      message:
        "evidence has extra properties " +
        extra.join(", ") +
        "; allowed: kind|pointer|recorded_at|recorded_by",
    };
  }
  const kindRaw = typeof obj.kind === "string" ? obj.kind.trim().toLowerCase() : "";
  if (!isAcceptanceEvidenceKind(kindRaw)) {
    return {
      ok: false,
      message:
        `unknown or missing evidence.kind ${JSON.stringify(obj.kind)}; ` +
        `allowed: ${ACCEPTANCE_EVIDENCE_KINDS.join("|")}`,
    };
  }
  if (!isNonEmptyString(obj.pointer)) {
    return { ok: false, message: "evidence.pointer is required (non-empty string)" };
  }
  if (!isNonEmptyString(obj.recorded_at)) {
    return { ok: false, message: "evidence.recorded_at is required" };
  }
  if (!isNonEmptyString(obj.recorded_by)) {
    return { ok: false, message: "evidence.recorded_by is required" };
  }
  if (requirePointerShape) {
    const shape = evidencePointerShapeError(kindRaw as AcceptanceEvidenceKind, obj.pointer.trim());
    if (shape !== null) {
      return { ok: false, message: shape };
    }
  }
  return {
    ok: true,
    record: {
      kind: kindRaw as AcceptanceEvidenceKind,
      pointer: obj.pointer.trim(),
      recorded_at: obj.recorded_at.trim(),
      recorded_by: obj.recorded_by.trim(),
    },
  };
}

/**
 * Parse a typed acceptance disposition and require human-origin provenance (#3240 / #3819).
 * Shared by scope:complete and evaluateCompletedWriteGuard — do not fork a second parser.
 */
export function parseDisposition(raw: unknown):
  | {
      ok: true;
      record: AcceptanceDispositionRecord;
    }
  | {
      ok: false;
      message: string;
    } {
  const obj = asRecord(raw);
  if (obj === null) {
    return { ok: false, message: "disposition must be an object" };
  }
  const dispRaw = typeof obj.disposition === "string" ? obj.disposition.trim().toLowerCase() : "";
  if (!isAcceptanceDispositionKind(dispRaw)) {
    return {
      ok: false,
      message:
        `unknown or missing disposition.disposition ${JSON.stringify(obj.disposition)}; ` +
        `allowed: ${ACCEPTANCE_DISPOSITIONS.join("|")}`,
    };
  }
  if (!isNonEmptyString(obj.reason)) {
    return { ok: false, message: "disposition.reason is required" };
  }
  if (!isNonEmptyString(obj.recorded_at)) {
    return { ok: false, message: "disposition.recorded_at is required" };
  }
  const provenance = asRecord(obj.provenance);
  if (provenance === null) {
    return {
      ok: false,
      message: `disposition.provenance is required (${DISPOSITION_PROVENANCE_SHAPE})`,
    };
  }
  // Reuse authz human-origin gate (#2944) so agent-self stamps cannot waive criteria.
  const originForCheck: GrantOrigin = {
    kind: String(provenance.kind ?? ""),
    actor: String(provenance.actor ?? ""),
    mintedAt: typeof provenance.mintedAt === "string" ? provenance.mintedAt : "",
    mintedVia: typeof provenance.mintedVia === "string" ? provenance.mintedVia : "",
    eventRef: typeof provenance.eventRef === "string" ? provenance.eventRef : null,
  };
  if (!isHumanOrigin(originForCheck)) {
    return {
      ok: false,
      message:
        "disposition.provenance must be human-origin " +
        "(kind operator-cli|operator-session|human-event + non-agent actor)",
    };
  }
  const record: AcceptanceDispositionRecord = {
    disposition: dispRaw as AcceptanceDispositionKind,
    reason: obj.reason.trim(),
    provenance: {
      kind: originForCheck.kind,
      actor: originForCheck.actor,
      ...(originForCheck.mintedAt.length > 0 ? { mintedAt: originForCheck.mintedAt } : {}),
      ...(originForCheck.mintedVia.length > 0 ? { mintedVia: originForCheck.mintedVia } : {}),
      ...(originForCheck.eventRef !== null ? { eventRef: originForCheck.eventRef } : {}),
      ...(isNonEmptyString(provenance.grantId) ? { grantId: provenance.grantId.trim() } : {}),
    },
    recorded_at: obj.recorded_at.trim(),
    ...(isNonEmptyString(obj.deferred_to) ? { deferred_to: obj.deferred_to.trim() } : {}),
  };
  if (isNonEmptyString(obj.resume_when)) {
    return {
      ok: true,
      record: { ...record, resume_when: obj.resume_when.trim() },
    };
  }
  return { ok: true, record };
}

function itemLabel(item: Record<string, unknown>, path: string): string {
  if (typeof item.title === "string" && item.title.trim().length > 0) {
    return item.title.trim();
  }
  if (typeof item.id === "string" && item.id.trim().length > 0) {
    return item.id.trim();
  }
  return path;
}

/**
 * Fence untrusted clause/task/basename text so roster and refuse listings cannot inject (#4385 / #4840).
 * Assumptions: callers interpolate this into operator-visible hook or gate copy.
 * Guarantees: fence markers and CR/LF are stripped so `pointer=` cannot break a markdown bullet.
 * Non-goals: HTML/ANSI escaping, path canonicalization, glob matching.
 */
export function fenceUntrustedAcceptanceText(text: string): string {
  const collapsed = text.replace(/[«»]/g, "").replace(/\r?\n/g, " ");
  return `«untrusted:${collapsed}»`;
}

export function clauseKeyedItemId(clauseId: number): string {
  return `${CLAUSE_KEYED_ITEM_ID_PREFIX}${clauseId}`;
}

function legacyClauseKeyedItemId(clauseId: number): string {
  return `${LEGACY_CLAUSE_KEYED_ITEM_ID_PREFIX}${clauseId}`;
}

function itemIdKey(item: Record<string, unknown>): string | null {
  const id = item.id;
  if (typeof id === "string" && id.trim().length > 0) {
    return id.trim();
  }
  if (typeof id === "number" && Number.isFinite(id)) {
    return String(id);
  }
  return null;
}

function collectItemIdKeys(items: unknown, keys: Set<string>): void {
  if (!Array.isArray(items)) {
    return;
  }
  for (const item of items) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const obj = item as Record<string, unknown>;
    const key = itemIdKey(obj);
    if (key !== null) {
      keys.add(key);
    }
    collectItemIdKeys(obj.subItems, keys);
    collectItemIdKeys(obj.items, keys);
  }
}

function clauseHasKeyedItem(clauseId: number, keys: ReadonlySet<string>): boolean {
  return (
    keys.has(clauseKeyedItemId(clauseId)) ||
    keys.has(legacyClauseKeyedItemId(clauseId)) ||
    keys.has(String(clauseId))
  );
}

function clauseBindingKeysFromPlan(plan: Record<string, unknown>): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const clause of readAcceptanceClauses(plan.acceptance)) {
    keys.add(clauseKeyedItemId(clause.id));
    keys.add(String(clause.id));
  }
  return keys;
}

function isClauseBindingItem(
  item: Record<string, unknown>,
  clauseKeys: ReadonlySet<string>,
): boolean {
  const key = itemIdKey(item);
  return key !== null && clauseKeys.has(key);
}

function clauseMatchKey(text: string): string {
  return stripInlineMarkdownBold(text).replace(/\s+/g, " ").trim().toLowerCase();
}

export interface BindPlanItemIdsToClausesResult {
  readonly boundIds: readonly string[];
}

/**
 * Copy clause ids onto matching plan.items (title === clause text) as `clause.N`.
 * Does not overwrite existing ids. Does not invent rows. Unmatched clauses stay unbound (#4732).
 */
export function bindPlanItemIdsToClauses(
  plan: Record<string, unknown>,
): BindPlanItemIdsToClausesResult {
  const clauses = readAcceptanceClauses(plan.acceptance);
  if (clauses.length === 0) {
    return { boundIds: [] };
  }
  const items = Array.isArray(plan.items) ? plan.items : [];
  const keys = new Set<string>();
  collectItemIdKeys(items, keys);
  const boundIds: string[] = [];
  const claimedIndexes = new Set<number>();
  for (const clause of clauses) {
    if (clauseHasKeyedItem(clause.id, keys)) {
      continue;
    }
    const wanted = clauseMatchKey(clause.text);
    if (wanted.length === 0) {
      continue;
    }
    for (let index = 0; index < items.length; index += 1) {
      if (claimedIndexes.has(index)) {
        continue;
      }
      const item = asRecord(items[index]);
      if (item === null || itemIdKey(item) !== null) {
        continue;
      }
      const title = typeof item.title === "string" ? item.title : "";
      if (clauseMatchKey(title) !== wanted) {
        continue;
      }
      const id = clauseKeyedItemId(clause.id);
      item.id = id;
      keys.add(id);
      keys.add(String(clause.id));
      claimedIndexes.add(index);
      boundIds.push(id);
      break;
    }
  }
  return { boundIds };
}

function isExactDeclaredMember(pointer: string, declared: readonly string[]): boolean {
  const normalized = posixPointer(pointer);
  if (normalized.length === 0) {
    return false;
  }
  return declared.some((entry) => posixPointer(entry) === normalized);
}

function resolveAllowedTestPointer(
  artifactPath: string | null | undefined,
  declared: readonly string[],
): string | null {
  if (declared.length === 0) {
    return null;
  }
  if (typeof artifactPath !== "string" || artifactPath.trim().length === 0) {
    return null;
  }
  const pointer = posixPointer(artifactPath);
  return isExactDeclaredMember(pointer, declared) ? pointer : null;
}

/**
 * Skip-row pointer for the glob-refusing matchAny stamp (#4840).
 * Exact-member `resolveAllowedTestPointer` is not this writer.
 */
export function resolveMatchAnyFilePointer(
  artifactPath: string | null | undefined,
  declared: readonly string[],
  projectRoot: string,
): string | null {
  if (declared.length === 0) {
    return null;
  }
  if (typeof artifactPath !== "string" || artifactPath.trim().length === 0) {
    return null;
  }
  const pointer = posixPointer(artifactPath);
  if (!isMatchAnyFilePointer(pointer, declared, projectRoot)) {
    return null;
  }
  return pointer;
}

export interface StampDeclaredTestEvidenceOptions {
  readonly recorded_by: string;
  readonly recorded_at?: string;
}

export interface StampDeclaredTestEvidenceSkip {
  readonly clauseId: number;
  readonly reason: string;
}

export interface StampDeclaredTestEvidenceResult {
  readonly stampedIds: readonly string[];
  readonly repairedIds: readonly string[];
  readonly skipped: readonly StampDeclaredTestEvidenceSkip[];
}

/**
 * Exact-member kind:test helper (#4732).
 * Records kind:test only when the clause already has an exact declared file_scope
 * member (or that member copied onto artifact_path by #4008). Does not read PR
 * paths, verify_commands, or issue/comment prose (#3835).
 *
 * Inventory (#5105 / #4840 / #5382): live production matchAny writer is
 * stampMatchAnyFileEvidence via scope:stamp-evidence (kind test|review coherence).
 * This helper stays exported for exact-member callers and tests; it has no
 * production CLI caller (documented #4732 orphan — not wired here).
 */
export function stampDeclaredTestEvidence(
  plan: Record<string, unknown>,
  options: StampDeclaredTestEvidenceOptions,
): StampDeclaredTestEvidenceResult {
  const recordedBy = typeof options.recorded_by === "string" ? options.recorded_by.trim() : "";
  const recordedAt =
    typeof options.recorded_at === "string" && options.recorded_at.trim().length > 0
      ? options.recorded_at.trim()
      : utcNowIso();
  const declared = readDeclaredArtifactScope(plan);
  const clauses = readAcceptanceClauses(plan.acceptance);
  const stampedIds: string[] = [];
  const repairedIds: string[] = [];
  const skipped: StampDeclaredTestEvidenceSkip[] = [];
  if (recordedBy.length === 0) {
    for (const clause of clauses) {
      skipped.push({ clauseId: clause.id, reason: "recorded_by-required" });
    }
    return { stampedIds, repairedIds, skipped };
  }
  for (const clause of clauses) {
    const item = findClauseKeyedItem(plan.items, clause.id);
    if (item === null) {
      skipped.push({ clauseId: clause.id, reason: "unbound" });
      continue;
    }
    const fields = readNamespacedAcceptanceFields(item);
    if (fields.hasEvidence || fields.hasDisposition) {
      skipped.push({ clauseId: clause.id, reason: "already-stamped" });
      continue;
    }
    if (inferRequiredStrictAxes(item).length > 0) {
      skipped.push({ clauseId: clause.id, reason: "strict-axis" });
      continue;
    }
    const pointer = resolveAllowedTestPointer(clause.artifact_path, declared);
    if (pointer === null) {
      skipped.push({ clauseId: clause.id, reason: "no-allowed-pointer" });
      continue;
    }
    stampNamespacedEvidence(item, {
      kind: "test",
      pointer,
      recorded_at: recordedAt,
      recorded_by: recordedBy,
    });
    stampedIds.push(itemIdKey(item) ?? clauseKeyedItemId(clause.id));
  }
  return { stampedIds, repairedIds, skipped };
}

export interface StampMatchAnyFileEvidenceOptions {
  readonly recorded_by: string;
  readonly recorded_at?: string;
  readonly projectRoot: string;
}

/**
 * MatchAny evidence coherence writer (#4840 / #5382).
 * After resolveMatchAnyFilePointer, chooses kind via evidencePointerShapeError("test"):
 * null → kind test; non-null (md/CHANGELOG/PR prose) → kind review with the same
 * pointer so stamp→complete stays coherent under #5105. Does not weaken the hand-path
 * kind:test ban. Repairs already-stamped incoherent kind:test markdown via
 * parseEvidence(..., { requirePointerShape: false }); no uat/merge repair.
 * Strict-axis uses inferRequiredStrictAxes(item) (auto title:id → []). Surviving
 * skips: no-allowed-pointer, unbound, strict-axis when the aligned probe is
 * non-empty. Precedent: stampDeclaredMergeEvidence stamp-time coherence (#5105).
 * Does not take disposition, --pr, or --merge-commit. Does not copy file_scope[0]
 * or classifyGlob.prefix. Null-path persist-default rows stay unstamped.
 */
export function stampMatchAnyFileEvidence(
  plan: Record<string, unknown>,
  options: StampMatchAnyFileEvidenceOptions,
): StampDeclaredTestEvidenceResult {
  const recordedBy = typeof options.recorded_by === "string" ? options.recorded_by.trim() : "";
  const recordedAt =
    typeof options.recorded_at === "string" && options.recorded_at.trim().length > 0
      ? options.recorded_at.trim()
      : utcNowIso();
  const projectRoot = options.projectRoot;
  const declared = readDeclaredArtifactScope(plan);
  const clauses = readAcceptanceClauses(plan.acceptance);
  const stampedIds: string[] = [];
  const repairedIds: string[] = [];
  const skipped: StampDeclaredTestEvidenceSkip[] = [];
  if (recordedBy.length === 0) {
    for (const clause of clauses) {
      skipped.push({ clauseId: clause.id, reason: "recorded_by-required" });
    }
    return { stampedIds, repairedIds, skipped };
  }
  for (const clause of clauses) {
    const item = findClauseKeyedItem(plan.items, clause.id);
    if (item === null) {
      skipped.push({ clauseId: clause.id, reason: "unbound" });
      continue;
    }
    const fields = readNamespacedAcceptanceFields(item);
    // Disposition guard: repair only when hasEvidence && !hasDisposition (#5382).
    if (fields.hasDisposition) {
      skipped.push({ clauseId: clause.id, reason: "already-stamped" });
      continue;
    }
    if (fields.hasEvidence) {
      const parsed = parseEvidence(fields.evidence, { requirePointerShape: false });
      if (!parsed.ok) {
        // Malformed → no throw; leave for the gate (#5382).
        skipped.push({ clauseId: clause.id, reason: "already-stamped" });
        continue;
      }
      const existing = parsed.record;
      if (existing.kind !== "test" || testPointerShapeError(existing.pointer) === null) {
        skipped.push({ clauseId: clause.id, reason: "already-stamped" });
        continue;
      }
      const pointer = resolveMatchAnyFilePointer(clause.artifact_path, declared, projectRoot);
      if (pointer === null || posixPointer(pointer) !== posixPointer(existing.pointer)) {
        skipped.push({ clauseId: clause.id, reason: "already-stamped" });
        continue;
      }
      if (inferRequiredStrictAxes(item).length > 0) {
        skipped.push({ clauseId: clause.id, reason: "strict-axis" });
        continue;
      }
      stampNamespacedEvidence(item, {
        kind: "review",
        pointer: existing.pointer,
        recorded_at: recordedAt,
        recorded_by: recordedBy,
      });
      const id = itemIdKey(item) ?? clauseKeyedItemId(clause.id);
      repairedIds.push(id);
      continue;
    }
    // Fresh stamp: align strict-axis with the gate (auto title:id → []).
    if (inferRequiredStrictAxes(item).length > 0) {
      skipped.push({ clauseId: clause.id, reason: "strict-axis" });
      continue;
    }
    const pointer = resolveMatchAnyFilePointer(clause.artifact_path, declared, projectRoot);
    if (pointer === null) {
      skipped.push({ clauseId: clause.id, reason: "no-allowed-pointer" });
      continue;
    }
    const shapeErr = evidencePointerShapeError("test", pointer);
    const kind = shapeErr === null ? "test" : "review";
    stampNamespacedEvidence(item, {
      kind,
      pointer,
      recorded_at: recordedAt,
      recorded_by: recordedBy,
    });
    stampedIds.push(itemIdKey(item) ?? clauseKeyedItemId(clause.id));
  }
  return { stampedIds, repairedIds, skipped };
}

export type MergeAncestryVerifier = (
  projectRoot: string,
  mergeCommit: string,
  deliveryBranch: string,
  runGit?: GitRunner,
) => { ok: boolean; error: string | null; remoteTip: string | null };

export interface StampDeclaredMergeEvidenceOptions {
  readonly recorded_by: string;
  readonly recorded_at?: string;
  readonly mergeCommit: string;
  readonly projectRoot: string;
  readonly deliveryBranch: string;
  readonly verifyAncestry?: MergeAncestryVerifier;
  readonly runGit?: GitRunner;
  /**
   * When true, stamp merge on items that omit x-directive/requires:merge
   * (declaration-side admit for historical ship-closeout / #5403).
   * Strict-axis items (smoke/uat/deploy/observed_behavior) still skip.
   */
  readonly admitUndeclaredMerge?: boolean;
}

/**
 * Merge-kind stamp sibling (#5105). By default stamps only criteria that
 * explicitly declare merge. With admitUndeclaredMerge (historical ship-closeout
 * / #5403), undeclared non-strict items may also receive kind:merge when
 * completion provenance already proved delivery. Pointer is the merge commit
 * after verifyDeliveryAncestry-shaped check against the refreshed delivery tip.
 * Never auto-stamps from keywords or empty-axis alone.
 *
 * Production caller: stampMergeFromCompletionProvenance on the scope:complete
 * persist path after delivery provenance is on the plan and before the shared
 * read-only gate (#5120). Live matchAny coherence writer remains
 * stampMatchAnyFileEvidence / scope:stamp-evidence (kind test|review, #4840 /
 * #5382); stampDeclaredTestEvidence stays the #4732 orphan. Stamp-time
 * coherence precedent for the matchAny kind choice.
 */
export function stampDeclaredMergeEvidence(
  plan: Record<string, unknown>,
  options: StampDeclaredMergeEvidenceOptions,
): StampDeclaredTestEvidenceResult {
  const recordedBy = typeof options.recorded_by === "string" ? options.recorded_by.trim() : "";
  const recordedAt =
    typeof options.recorded_at === "string" && options.recorded_at.trim().length > 0
      ? options.recorded_at.trim()
      : utcNowIso();
  const mergeCommit = typeof options.mergeCommit === "string" ? options.mergeCommit.trim() : "";
  const deliveryBranch =
    typeof options.deliveryBranch === "string" ? options.deliveryBranch.trim() : "";
  const projectRoot = typeof options.projectRoot === "string" ? options.projectRoot.trim() : "";
  const clauses = readAcceptanceClauses(plan.acceptance);
  const stampedIds: string[] = [];
  const repairedIds: string[] = [];
  const skipped: StampDeclaredTestEvidenceSkip[] = [];
  if (recordedBy.length === 0) {
    for (const clause of clauses) {
      skipped.push({ clauseId: clause.id, reason: "recorded_by-required" });
    }
    return { stampedIds, repairedIds, skipped };
  }
  if (mergeCommit.length === 0 || deliveryBranch.length === 0 || projectRoot.length === 0) {
    for (const clause of clauses) {
      skipped.push({ clauseId: clause.id, reason: "merge-pointer-required" });
    }
    return { stampedIds, repairedIds, skipped };
  }
  const shape = mergePointerShapeError(mergeCommit);
  if (shape !== null) {
    for (const clause of clauses) {
      skipped.push({ clauseId: clause.id, reason: "merge-pointer-shape" });
    }
    return { stampedIds, repairedIds, skipped };
  }
  const verify = options.verifyAncestry ?? verifyDeliveryAncestry;
  const ancestry = verify(projectRoot, mergeCommit, deliveryBranch, options.runGit);
  if (!ancestry.ok) {
    for (const clause of clauses) {
      skipped.push({ clauseId: clause.id, reason: "ancestry-failed" });
    }
    return { stampedIds, repairedIds, skipped };
  }
  const evidence = {
    kind: "merge" as const,
    pointer: mergeCommit,
    recorded_at: recordedAt,
    recorded_by: recordedBy,
  };
  const clauseItems = new Set<Record<string, unknown>>();
  for (const clause of clauses) {
    const item = findClauseKeyedItem(plan.items, clause.id);
    if (item === null) {
      skipped.push({ clauseId: clause.id, reason: "unbound" });
      continue;
    }
    clauseItems.add(item);
    const reason = mergeStampSkipReason(item, options.admitUndeclaredMerge === true);
    if (reason !== null) {
      skipped.push({ clauseId: clause.id, reason });
      continue;
    }
    stampMergeOnItem(item, evidence, options.admitUndeclaredMerge === true);
    stampedIds.push(itemIdKey(item) ?? clauseKeyedItemId(clause.id));
  }
  // #6765: a hand-written acceptance item (not clause-keyed, e.g. `ac.1`) gets
  // the same merge evidence under the same rules. The gate walks the same tree,
  // so every non-terminal item it holds to evidence is reached here.
  forEachStrictAxisItem(plan, (item) => {
    if (clauseItems.has(item) || isClauseKeyedIdShape(itemIdKey(item))) {
      return;
    }
    if (!NON_TERMINAL_ITEM_STATUSES.has(String(item.status ?? ""))) {
      return;
    }
    if (mergeStampSkipReason(item, options.admitUndeclaredMerge === true) !== null) {
      return;
    }
    stampMergeOnItem(item, evidence, options.admitUndeclaredMerge === true);
    const id = itemIdKey(item);
    if (id !== null) {
      stampedIds.push(id);
    }
  });
  return { stampedIds, repairedIds, skipped };
}

/** Why the merge stamper leaves an item alone, or null to stamp it (#5105 / #6765). */
function mergeStampSkipReason(
  item: Record<string, unknown>,
  admitUndeclaredMerge: boolean,
): "already-stamped" | "undeclared-merge" | "strict-axis" | null {
  const fields = readNamespacedAcceptanceFields(item);
  if (fields.hasEvidence || fields.hasDisposition) {
    return "already-stamped";
  }
  if (!itemDeclaresMergeRequirement(item) && !admitUndeclaredMerge) {
    return "undeclared-merge";
  }
  if (inferRequiredStrictAxes(item).length > 0) {
    return "strict-axis";
  }
  return null;
}

function stampMergeOnItem(
  item: Record<string, unknown>,
  evidence: {
    readonly kind: "merge";
    readonly pointer: string;
    readonly recorded_at: string;
    readonly recorded_by: string;
  },
  admitUndeclaredMerge: boolean,
): void {
  // #5403 declaration-side admit: write requires=merge so the later
  // evaluateAcceptanceEvidenceGate / isEvidenceKindSuitable path agrees
  // with this stamp (Greptile P1 on #5430). Strict axes already skipped.
  if (admitUndeclaredMerge && !itemDeclaresMergeRequirement(item)) {
    item[ACCEPTANCE_REQUIRES_KEY] = MERGE_ACCEPTANCE_REQUIREMENT;
  }
  stampNamespacedEvidence(item, { ...evidence });
}

/** `clause.N`, legacy `clause:N`, or a bare clause number (#4385). */
function isClauseKeyedIdShape(id: string | null): boolean {
  return id !== null && /^(?:clause[.:])?\d+$/.test(id);
}

function readCompletionProvenance(plan: Record<string, unknown>): Record<string, unknown> | null {
  const metadata = asRecord(plan.metadata);
  if (metadata === null) {
    return null;
  }
  return asRecord(metadata.completionProvenance);
}

export interface StampMergeFromCompletionProvenanceOptions {
  readonly projectRoot?: string;
  readonly runGit?: GitRunner;
  readonly verifyAncestry?: MergeAncestryVerifier;
  /**
   * When true, skip verifyDeliveryAncestry / git fetch and pass through
   * completionProvenance already validated by evaluateDeliveryGate on this
   * complete invocation (#5120 dest residual). Explicit verifyAncestry wins.
   */
  readonly reuseValidatedAncestry?: boolean;
  readonly recorded_by?: string;
  readonly recorded_at?: string;
}

function passThroughProvenanceAncestry(
  mergeCommit: string,
  deliveryBranch: string,
  deliveryCommit: unknown,
): MergeAncestryVerifier {
  const remoteTip =
    typeof deliveryCommit === "string" && deliveryCommit.trim().length > 0
      ? deliveryCommit.trim()
      : mergeCommit;
  return (_projectRoot, commit, branch) => {
    if (commit === mergeCommit && branch === deliveryBranch) {
      return { ok: true, error: null, remoteTip };
    }
    return {
      ok: false,
      error: "completion provenance pointers do not match stamp request",
      remoteTip: null,
    };
  };
}

/**
 * Complete-path persist writer for stampDeclaredMergeEvidence (#5105 / #5120).
 * Runs only when delivery completionProvenance already carries verified
 * delivered ship provenance (mergeCommit + deliveryBranch + disposition
 * "delivered"). Does not run inside evaluateAcceptanceEvidenceGate.
 * Never falls back to process.cwd() (#5105 Greptile P1).
 */
export function stampMergeFromCompletionProvenance(
  plan: Record<string, unknown>,
  options: StampMergeFromCompletionProvenanceOptions = {},
): StampDeclaredTestEvidenceResult {
  const empty: StampDeclaredTestEvidenceResult = { stampedIds: [], repairedIds: [], skipped: [] };
  if (!isHistoricalShipCloseout(plan)) {
    return empty;
  }
  const prov = readCompletionProvenance(plan);
  if (prov === null) {
    return empty;
  }
  // isHistoricalShipCloseout already required non-empty delivered pointers.
  const mergeCommit = (prov.mergeCommit as string).trim();
  const deliveryBranch = (prov.deliveryBranch as string).trim();
  const projectRoot =
    typeof options.projectRoot === "string" && options.projectRoot.trim().length > 0
      ? options.projectRoot.trim()
      : "";
  if (projectRoot.length === 0) {
    return empty;
  }
  const recordedBy =
    typeof options.recorded_by === "string" && options.recorded_by.trim().length > 0
      ? options.recorded_by.trim()
      : typeof prov.verifier === "string" && prov.verifier.trim().length > 0
        ? prov.verifier.trim()
        : "scope:complete";
  const verifyAncestry =
    options.verifyAncestry ??
    (options.reuseValidatedAncestry === true
      ? passThroughProvenanceAncestry(mergeCommit, deliveryBranch, prov.deliveryCommit)
      : undefined);
  return stampDeclaredMergeEvidence(plan, {
    recorded_by: recordedBy,
    recorded_at: options.recorded_at,
    mergeCommit,
    projectRoot,
    deliveryBranch,
    verifyAncestry,
    runGit: options.runGit,
    // #5403: completion provenance is the declaration-side admit for historical class.
    admitUndeclaredMerge: true,
  });
}

export interface PersistClauseKeyedPendingItemsResult {
  readonly addedIds: readonly string[];
  /** Leftover `clause:N` ids rewritten to `clause.N`. Not new mints. */
  readonly rewrittenIds: readonly string[];
}

/**
 * Complete-prep writer: add pending plan.items keyed to each acceptance clause id.
 * Does not stamp evidence. Does not run inside evaluateAcceptanceEvidenceGate (#4385 / #4732).
 */
export function persistClauseKeyedPendingItems(
  plan: Record<string, unknown>,
): PersistClauseKeyedPendingItemsResult {
  const clauses = readAcceptanceClauses(plan.acceptance);
  const items = Array.isArray(plan.items) ? plan.items : [];
  const rewrittenIds = rewriteLegacyClauseKeyedItemIds(items);
  if (clauses.length === 0) {
    return { addedIds: [], rewrittenIds };
  }
  if (!Array.isArray(plan.items)) {
    plan.items = items;
  }
  const keys = new Set<string>();
  collectItemIdKeys(items, keys);
  const addedIds: string[] = [];
  for (const clause of clauses) {
    if (clauseHasKeyedItem(clause.id, keys)) {
      continue;
    }
    const id = clauseKeyedItemId(clause.id);
    items.push({
      id,
      title: id,
      status: "pending",
    });
    keys.add(id);
    addedIds.push(id);
  }
  return { addedIds, rewrittenIds };
}

export interface ScopeStatusInput {
  readonly id?: string;
  readonly path?: string;
  readonly plan: Record<string, unknown>;
}

export interface ScopeStatusCounts {
  readonly id: string;
  readonly status: string;
  readonly itemCounts: Record<string, number>;
  readonly itemIds: readonly string[];
  readonly clauseIds: readonly number[];
  readonly clauseCounts: {
    readonly total: number;
    readonly keyed: number;
    readonly unbound: number;
    readonly evidenced: number;
    readonly dispositioned: number;
  };
}

function countItemStatuses(items: unknown, counts: Record<string, number>, ids: string[]): void {
  if (!Array.isArray(items)) {
    return;
  }
  for (const item of items) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const obj = item as Record<string, unknown>;
    const status =
      typeof obj.status === "string" && obj.status.trim().length > 0 ? obj.status.trim() : "(none)";
    counts[status] = (counts[status] ?? 0) + 1;
    const key = itemIdKey(obj);
    if (key !== null) {
      ids.push(key);
    }
    countItemStatuses(obj.subItems, counts, ids);
    countItemStatuses(obj.items, counts, ids);
  }
}

function findItemByKey(items: unknown, wanted: string): Record<string, unknown> | null {
  if (!Array.isArray(items)) {
    return null;
  }
  for (const item of items) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const obj = item as Record<string, unknown>;
    if (itemIdKey(obj) === wanted) {
      return obj;
    }
    const nested = findItemByKey(obj.subItems, wanted) ?? findItemByKey(obj.items, wanted);
    if (nested !== null) {
      return nested;
    }
  }
  return null;
}

function findClauseKeyedItem(items: unknown, clauseId: number): Record<string, unknown> | null {
  return (
    findItemByKey(items, clauseKeyedItemId(clauseId)) ??
    findItemByKey(items, legacyClauseKeyedItemId(clauseId)) ??
    findItemByKey(items, String(clauseId))
  );
}

export function rewriteLegacyClauseKeyedItemIds(
  items: unknown,
  rewrittenIds: string[] = [],
): string[] {
  if (!Array.isArray(items)) {
    return rewrittenIds;
  }
  for (const item of items) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const obj = item as Record<string, unknown>;
    if (typeof obj.id === "string") {
      const raw = obj.id;
      const match = LEGACY_CLAUSE_KEYED_ITEM_ID_RE.exec(raw.trim());
      if (match !== null) {
        const next = clauseKeyedItemId(Number(match[1]));
        if (typeof obj.title === "string" && obj.title === raw) {
          obj.title = next;
        }
        obj.id = next;
        rewrittenIds.push(next);
      }
    }
    rewriteLegacyClauseKeyedItemIds(obj.subItems, rewrittenIds);
    rewriteLegacyClauseKeyedItemIds(obj.items, rewrittenIds);
  }
  return rewrittenIds;
}

export function evaluateScopeStatus(
  scopes: readonly ScopeStatusInput[],
): readonly ScopeStatusCounts[] {
  return scopes.map((scope) => {
    const plan = scope.plan;
    const itemCounts: Record<string, number> = {};
    const itemIds: string[] = [];
    countItemStatuses(plan.items, itemCounts, itemIds);
    const clauses = readAcceptanceClauses(plan.acceptance);
    let keyed = 0;
    let evidenced = 0;
    let dispositioned = 0;
    for (const clause of clauses) {
      const item = findClauseKeyedItem(plan.items, clause.id);
      if (item === null) {
        continue;
      }
      keyed += 1;
      const fields = readNamespacedAcceptanceFields(item);
      if (fields.hasEvidence) evidenced += 1;
      if (fields.hasDisposition) dispositioned += 1;
    }
    const id =
      (typeof scope.id === "string" && scope.id.trim().length > 0 ? scope.id.trim() : null) ??
      (typeof plan.id === "string" && plan.id.trim().length > 0 ? plan.id.trim() : null) ??
      (typeof scope.path === "string" && scope.path.trim().length > 0
        ? scope.path.trim()
        : "(no-id)");
    return {
      id,
      status:
        typeof plan.status === "string" && plan.status.trim().length > 0
          ? plan.status.trim()
          : "(none)",
      itemCounts,
      itemIds,
      clauseIds: clauses.map((c) => c.id),
      clauseCounts: {
        total: clauses.length,
        keyed,
        unbound: clauses.length - keyed,
        evidenced,
        dispositioned,
      },
    };
  });
}

/** Counts and ids only. Clause/task text is omitted (fenced if a caller injects it). */
export function formatScopeStatus(
  scopes: readonly ScopeStatusInput[],
  options: { readonly json?: boolean } = {},
): string {
  const rows = evaluateScopeStatus(scopes);
  if (options.json === true) {
    return JSON.stringify(rows);
  }
  if (rows.length === 0) {
    return "scope:status: (none)";
  }
  const blocks = rows.map((row) => {
    const itemParts = Object.entries(row.itemCounts)
      .map(([status, n]) => `${status}=${n}`)
      .join(" ");
    const itemIds = row.itemIds.length > 0 ? row.itemIds.join(",") : "(none)";
    const clauseIds = row.clauseIds.length > 0 ? row.clauseIds.join(",") : "(none)";
    return [
      `scope:status id=${row.id} status=${row.status}`,
      `  items: ${itemParts.length > 0 ? itemParts : "(none)"} ids=${itemIds}`,
      `  clauses: total=${row.clauseCounts.total} keyed=${row.clauseCounts.keyed} unbound=${row.clauseCounts.unbound} evidenced=${row.clauseCounts.evidenced} dispositioned=${row.clauseCounts.dispositioned} ids=${clauseIds}`,
    ].join("\n");
  });
  return blocks.join("\n");
}

/**
 * Read only namespaced acceptance fields (#3305). Bare `evidence` / `disposition`
 * are never treated as success (no permanent dual-read).
 */
export function readNamespacedAcceptanceFields(item: Record<string, unknown>): {
  readonly evidence: unknown;
  readonly disposition: unknown;
  readonly hasEvidence: boolean;
  readonly hasDisposition: boolean;
  readonly hasBareEvidence: boolean;
  readonly hasBareDisposition: boolean;
} {
  const evidence = item[ACCEPTANCE_EVIDENCE_KEY];
  const disposition = item[ACCEPTANCE_DISPOSITION_KEY];
  return {
    evidence,
    disposition,
    hasEvidence: evidence !== undefined && evidence !== null,
    hasDisposition: disposition !== undefined && disposition !== null,
    hasBareEvidence: item.evidence !== undefined && item.evidence !== null,
    hasBareDisposition: item.disposition !== undefined && item.disposition !== null,
  };
}

/** Clear bare and namespaced acceptance fields so stamps never leave dual/conflicting keys. */
function clearAcceptanceStampFields(item: Record<string, unknown>): void {
  delete item.evidence;
  delete item.disposition;
  delete item[ACCEPTANCE_EVIDENCE_KEY];
  delete item[ACCEPTANCE_DISPOSITION_KEY];
}

/**
 * Stamp typed evidence under the canonical namespaced key only.
 * Clears bare evidence/disposition and any prior namespaced disposition so the item
 * cannot carry both acceptance fields after a replace (#3305 Greptile P2).
 */
export function stampNamespacedEvidence(
  item: Record<string, unknown>,
  record: AcceptanceEvidenceRecord,
): void {
  clearAcceptanceStampFields(item);
  item[ACCEPTANCE_EVIDENCE_KEY] = {
    kind: record.kind,
    pointer: record.pointer,
    recorded_at: record.recorded_at,
    recorded_by: record.recorded_by,
  };
}

/**
 * Stamp human-origin disposition under the canonical namespaced key only.
 * Clears bare evidence/disposition and any prior namespaced evidence so the item
 * cannot carry both acceptance fields after a replace (#3305 Greptile P2).
 */
export function stampNamespacedDisposition(
  item: Record<string, unknown>,
  record: AcceptanceDispositionRecord,
): void {
  clearAcceptanceStampFields(item);
  const body: Record<string, unknown> = {
    disposition: record.disposition,
    reason: record.reason,
    provenance: { ...record.provenance },
    recorded_at: record.recorded_at,
  };
  if (record.resume_when !== undefined) {
    body.resume_when = record.resume_when;
  }
  if (record.deferred_to !== undefined) {
    body.deferred_to = record.deferred_to;
  }
  item[ACCEPTANCE_DISPOSITION_KEY] = body;
}

const ACCEPTANCE_STAMP_KEYS = [
  "evidence",
  "disposition",
  ACCEPTANCE_EVIDENCE_KEY,
  ACCEPTANCE_DISPOSITION_KEY,
] as const;

/** Covered items' acceptance fields as they were before a grant apply (#6318). */
export type GrantedDispositionOriginals = ReadonlyMap<string, Readonly<Record<string, unknown>>>;

/** One grant-covered disposition to apply in memory (#6318). */
export interface GrantedDisposition {
  readonly itemId: string;
  readonly record: AcceptanceDispositionRecord;
}

function findGrantCoveredItem(items: unknown, itemId: string): Record<string, unknown> | null {
  const clause = CLAUSE_KEYED_PLACEHOLDER_ID_RE.exec(itemId);
  if (clause !== null) {
    const keyed = findClauseKeyedItem(items, Number(clause[1]));
    if (keyed !== null) return keyed;
  }
  return findItemByKey(items, itemId);
}

/**
 * Apply grant-covered dispositions in memory (#6318). Runs in complete-prep
 * after persistClauseKeyedPendingItems and before
 * stampMergeFromCompletionProvenance, so the merge stamper skips these items.
 * The returned originals let the mid-flight active write leave them out.
 */
export function applyGrantedDispositions(
  plan: Record<string, unknown>,
  granted: readonly GrantedDisposition[],
): {
  readonly appliedIds: readonly string[];
  readonly missingIds: readonly string[];
  readonly originals: GrantedDispositionOriginals;
} {
  const appliedIds: string[] = [];
  const missingIds: string[] = [];
  const originals = new Map<string, Readonly<Record<string, unknown>>>();
  for (const { itemId, record } of granted) {
    const item = findGrantCoveredItem(plan.items, itemId);
    if (item === null) {
      missingIds.push(itemId);
      continue;
    }
    const before: Record<string, unknown> = {};
    for (const key of ACCEPTANCE_STAMP_KEYS) {
      if (key in item) before[key] = structuredClone(item[key]);
    }
    originals.set(itemId, before);
    stampNamespacedDisposition(item, record);
    appliedIds.push(itemId);
  }
  return { appliedIds, missingIds, originals };
}

/**
 * Put covered items back as they were before applyGrantedDispositions, on a
 * copy of the plan written to the active brief mid-flight (#6318).
 */
export function restoreGrantedDispositionOriginals(
  plan: Record<string, unknown>,
  originals: GrantedDispositionOriginals,
): void {
  for (const [itemId, before] of originals) {
    const item = findGrantCoveredItem(plan.items, itemId);
    if (item === null) continue;
    clearAcceptanceStampFields(item);
    for (const [key, value] of Object.entries(before)) {
      item[key] = structuredClone(value);
    }
  }
}

function evaluateOneItem(
  item: Record<string, unknown>,
  path: string,
  clauseKeys: ReadonlySet<string>,
): CriterionAcceptanceReport {
  const title = itemLabel(item, path);
  const status = String(item.status ?? "");
  // Clause-keyed bindings still need typed evidence or a human-origin disposition
  // even when already terminal; persist skips creating a second pending row (#4385).
  if (!NON_TERMINAL_ITEM_STATUSES.has(status) && !isClauseBindingItem(item, clauseKeys)) {
    // #4879 Prefer-A: landing-set statuses cannot enter completed/ without typed
    // evidence. requirePointerShape:false here is the landing-set structural
    // probe (#4563) — re-tighten for non-uat. Distinct from the #5382
    // stampMatchAnyFileEvidence repair reader, which keeps the loose parse for
    // kind:test shape-bad rows. Empty {} / malformed do not count (Greptile P1).
    if (COMPLETED_LANDING_WITHOUT_EVIDENCE_STATUSES.has(status)) {
      const landingFields = readNamespacedAcceptanceFields(item);
      let landingEvidence: ReturnType<typeof parseEvidence> | null = null;
      if (landingFields.hasEvidence) {
        const structural = parseEvidence(landingFields.evidence, {
          requirePointerShape: false,
        });
        if (!structural.ok) {
          landingEvidence = structural;
        } else if (structural.record.kind === "uat") {
          // #4563 historical kind:uat test pointers stay already_terminal.
          landingEvidence = structural;
        } else {
          landingEvidence = parseEvidence(landingFields.evidence);
        }
      }
      if (landingEvidence === null || !landingEvidence.ok) {
        const bareHint =
          landingFields.hasBareEvidence || landingFields.hasBareDisposition
            ? ` bare evidence/disposition ignored — use ${ACCEPTANCE_EVIDENCE_KEY} or ${ACCEPTANCE_DISPOSITION_KEY} (#3305);`
            : "";
        const shapeHint =
          landingEvidence !== null && !landingEvidence.ok
            ? ` ${ACCEPTANCE_EVIDENCE_KEY} present but malformed (${landingEvidence.message});`
            : "";
        return {
          path,
          title,
          outcome: "missing",
          detail:
            `status=${status} already terminal but no valid ${ACCEPTANCE_EVIDENCE_KEY};` +
            `${shapeHint}${bareHint} missing typed evidence blocks completed/ entry (#4879)`,
        };
      }
      // Recognized fail/cancel/historical terminals keep the skip once landing
      // evidence is present — do not demand a disposition on every terminal (#3819).
      return {
        path,
        title,
        outcome: "already_terminal",
        detail: `status=${status || "(empty)"} (not advanced; typed evidence not re-checked)`,
      };
    }
    // #3819: missing or unrecognized item.status no longer default-open
    // already_terminal. Fall through to typed evidence / disposition checks.
  }

  const fields = readNamespacedAcceptanceFields(item);
  const { hasEvidence, hasDisposition, hasBareEvidence, hasBareDisposition } = fields;

  if (hasEvidence && hasDisposition) {
    return {
      path,
      title,
      outcome: "invalid",
      detail: `exactly one of ${ACCEPTANCE_EVIDENCE_KEY} or ${ACCEPTANCE_DISPOSITION_KEY} required; both present`,
    };
  }

  if (!hasEvidence && !hasDisposition) {
    const bareHint =
      hasBareEvidence || hasBareDisposition
        ? ` bare evidence/disposition ignored — use ${ACCEPTANCE_EVIDENCE_KEY} or ${ACCEPTANCE_DISPOSITION_KEY} (#3305);`
        : "";
    return {
      path,
      title,
      outcome: "missing",
      detail:
        `no ${ACCEPTANCE_EVIDENCE_KEY} or ${ACCEPTANCE_DISPOSITION_KEY};` +
        `${bareHint} scope:complete refuses to auto-complete (#3240)`,
    };
  }

  if (hasDisposition) {
    const parsed = parseDisposition(fields.disposition);
    if (!parsed.ok) {
      return { path, title, outcome: "invalid", detail: parsed.message };
    }
    return {
      path,
      title,
      outcome: "disposition",
      detail: `${parsed.record.disposition}: ${parsed.record.reason}`,
      disposition: parsed.record,
    };
  }

  const parsed = parseEvidence(fields.evidence);
  if (!parsed.ok) {
    return { path, title, outcome: "invalid", detail: parsed.message };
  }
  const requiredAxes = inferRequiredStrictAxes(item);
  const mergeDeclared = itemDeclaresMergeRequirement(item);
  if (!isEvidenceKindSuitable(parsed.record.kind, requiredAxes, { mergeDeclared })) {
    const axes = requiredAxes.length > 0 ? requiredAxes.join("|") : "(none)";
    const mergeHint =
      parsed.record.kind === "merge" && !mergeDeclared
        ? ` kind:merge requires explicit ${ACCEPTANCE_REQUIRES_KEY}=merge (#5105);`
        : "";
    return {
      path,
      title,
      outcome: "invalid",
      detail:
        `evidence.kind=${parsed.record.kind} is not suitable for required axis/axes [${axes}];` +
        `${mergeHint} ` +
        `merge/review alone cannot satisfy smoke|uat|deploy|observed_behavior (#3240)`,
      evidence: parsed.record,
    };
  }
  return {
    path,
    title,
    outcome: "evidence",
    detail: `${parsed.record.kind} @ ${fenceUntrustedAcceptanceText(parsed.record.pointer)}`,
    evidence: parsed.record,
  };
}

function walkItems(
  items: unknown,
  pathPrefix: string,
  reports: CriterionAcceptanceReport[],
  clauseKeys: ReadonlySet<string>,
): void {
  if (!Array.isArray(items)) {
    return;
  }
  items.forEach((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return;
    }
    const obj = item as Record<string, unknown>;
    const path = `${pathPrefix}[${index}]`;
    reports.push(evaluateOneItem(obj, path, clauseKeys));
    walkItems(obj.subItems, `${path}.subItems`, reports, clauseKeys);
    walkItems(obj.items, `${path}.items`, reports, clauseKeys);
  });
}

/**
 * Standing contract for scope:complete's acceptance precondition (#3357 / #3497).
 *
 * It no longer asserts a predicate ("empty or failing") — the actual predicate is
 * named per refusal by the shared resolver. It also no longer tells operators to
 * stamp by running verify:ac: verify:ac is the verifier and never writes the brief
 * (a verifier that authors the acceptance it then checks is not a gate). Stamping
 * happens at intake / promote via clause derivation (#3323).
 */

/**
 * True when plan.metadata.completionProvenance is verified delivered ship
 * provenance (#5403): mergeCommit + deliveryBranch + disposition "delivered".
 * Non-delivery dispositions (even with merge pointers) must not admit.
 */
export function isHistoricalShipCloseout(plan: Record<string, unknown>): boolean {
  const prov = readCompletionProvenance(plan);
  if (prov === null) {
    return false;
  }
  const mergeCommit = typeof prov.mergeCommit === "string" ? prov.mergeCommit.trim() : "";
  const deliveryBranch = typeof prov.deliveryBranch === "string" ? prov.deliveryBranch.trim() : "";
  const disposition = typeof prov.disposition === "string" ? prov.disposition.trim() : "";
  return mergeCommit.length > 0 && deliveryBranch.length > 0 && disposition === "delivered";
}

/** True when acceptance.clauses is absent or empty (Stage-2 clause-less hatch, #5403). */
export function isClauseLessAcceptance(plan: Record<string, unknown>): boolean {
  return readAcceptanceClauses(plan.acceptance).length === 0;
}

/**
 * Stage-1 (#3284): migrate empty commands → none_stated:true only when merge
 * provenance is already on the plan (historical ship-closeout). Returns true
 * when the plan was mutated.
 */
export function migrateNoneStatedForHistoricalShip(plan: Record<string, unknown>): boolean {
  if (!isHistoricalShipCloseout(plan)) {
    return false;
  }
  const acc = asRecord(plan.acceptance);
  if (acc === null) {
    return false;
  }
  const commands = Array.isArray(acc.commands) ? acc.commands : [];
  if (commands.length > 0) {
    return false;
  }
  if (acc.none_stated === true) {
    return false;
  }
  acc.none_stated = true;
  return true;
}

export const HISTORICAL_SHIP_CLOSEOUT_ADMIT_MESSAGE =
  "Historical ship-closeout admitted clause-less empty acceptance with merge provenance (#5403)";

const SCOPE_COMPLETE_ACCEPTANCE_REMEDIATION_LEAD =
  "scope:complete requires executable plan.acceptance that runs green; stamp commands on " +
  "plan.acceptance.commands (or plan.metadata.swarm.verify_commands) — task verify:ac verifies, " +
  "it does not stamp — then re-run task verify:ac -- <completing-xbrief> ";

export const SCOPE_COMPLETE_ACCEPTANCE_REMEDIATION = `${SCOPE_COMPLETE_ACCEPTANCE_REMEDIATION_LEAD}(disposition is not a substitute) (#3357/#3497)`;

/**
 * Refusal text for a walk that left clauses neither verified nor granted (#6644).
 * Replaces the "(disposition is not a substitute)" sentence: it lists each such
 * clause and gives the two remedies. Falls back to the standing text when no
 * clause row is unresolved.
 */
function scopeCompleteRemediation(
  plan: Record<string, unknown>,
  unresolved: readonly { readonly id: number; readonly text: string }[],
): string {
  if (unresolved.length === 0) return SCOPE_COMPLETE_ACCEPTANCE_REMEDIATION;
  const planId = typeof plan.id === "string" && plan.id.trim().length > 0 ? plan.id.trim() : null;
  const ids = unresolved.map((row) => `clause.${row.id}`).join(",");
  const lines = unresolved.map((row) => {
    const text = row.text.replace(/\s+/g, " ").trim();
    return `  - clause ${row.id}: ${fenceUntrustedAcceptanceText(text.length > 80 ? `${text.slice(0, 80)}...` : text)}`;
  });
  return (
    `${SCOPE_COMPLETE_ACCEPTANCE_REMEDIATION_LEAD}(#3357/#3497)\n` +
    `${unresolved.length} clause(s) neither verified nor granted:\n${lines.join("\n")}\n` +
    `Fix each one of two ways: (1) a verify command that covers the clause; or (2) an operator ` +
    `grant: deft authz:grant -- --template ${ACCEPTANCE_DISPOSITION_TEMPLATE} ` +
    `--plan-ref ${planId ?? "<scopeId>"} --story-ids ${ids} ` +
    `--disposition <deferred|not_applicable|waived> --reason <text> ` +
    `[--deferred-to <issue>, for deferred only] --confirm (#6644)`
  );
}

/** Clause rows the walk neither verified nor left out as granted (#6644). */
function unresolvedClauseRows(
  rows: readonly { readonly id: number; readonly text: string; readonly outcome: string }[],
): { readonly id: number; readonly text: string }[] {
  return rows.filter((row) => row.outcome !== "verified").map(({ id, text }) => ({ id, text }));
}

const ACCEPTANCE_DISPOSITION_TEMPLATE = "acceptance-disposition";

/**
 * True when a walk verified no clause and no green executable oracle ran
 * (#4870 / #6644): with a clause walk the counts decide (granted clauses are
 * already left out of them), otherwise the printed lead does.
 */
function walkReportsZeroVerified(walk: VerifyAcResult, predicate: AcceptancePredicate): boolean {
  if (walk.clauseWalked === true) {
    const rows = walk.clauseOutcomes ?? [];
    return (
      rows.length > 0 &&
      !rows.some((row) => row.outcome === "verified") &&
      predicate !== "executable-pass"
    );
  }
  return scopeCompleteRejectsZeroVerifiedWalk({ text: walk.message, predicate });
}

/** Lead used when the project declares no test command (#7047). */
export const DECLARED_TEST_FLOOR_NONE =
  "no declared test command (set `plan.policy.testCommand` in PROJECT-DEFINITION, " +
  "or `scripts.test` in package.json) (#7047)";

/** Where the floor's command came from, for the listing and the refusal. */
function describeDeclaredTestCommand(declared: DeclaredTestCommand, cwd: string): string {
  return `source ${declared.source}, cwd ${cwd}`;
}

/**
 * Characters an argument may hold and still reach the platform shell
 * unchanged when the record runs as one command string (#7047).
 */
const SHELL_LITERAL_ARGUMENT = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * The declared command as one acceptance record, argv split kept (#7047).
 * The record runs through the platform shell, so an argument that would not
 * survive it unchanged (whitespace, quotes, backslashes, globs and other
 * shell syntax) is refused instead of quoted or re-split.
 */
function declaredTestFloorRecord(
  declared: DeclaredTestCommand,
): { readonly record: LiteralAcceptanceCommand } | { readonly refused: string } {
  const argv = [declared.command, ...declared.args];
  const changed = argv.find((part) => !SHELL_LITERAL_ARGUMENT.test(part));
  if (changed !== undefined) {
    return {
      refused:
        `argument ${JSON.stringify(changed)} would not reach the shell unchanged, ` +
        "so its argv split cannot be kept in one command",
    };
  }
  return {
    record: {
      command: argv.join(" "),
      cwd: null,
      expectedStdout: null,
      expectedExitCode: 0,
      source: "metadata",
      sourceSpan: `project_floor (${declared.source})`,
    },
  };
}

/** The last non-empty line of each output stream of a failed floor run. */
function lastOutputLines(run: { readonly stdout: string; readonly stderr: string }): string {
  const last = (text: string): string | undefined =>
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .at(-1);
  const parts: string[] = [];
  const out = last(run.stdout);
  const err = last(run.stderr);
  if (out !== undefined) parts.push(`stdout: ${fenceUntrustedAcceptanceText(out)}`);
  if (err !== undefined) parts.push(`stderr: ${fenceUntrustedAcceptanceText(err)}`);
  return parts.length > 0 ? `; last output lines: ${parts.join("; ")}` : "; no output";
}

interface DeclaredTestFloorResult {
  /** Set when the floor walk admits completion. */
  readonly admitted: AcceptanceEvidenceGateResult | null;
  /** The floor outcome line printed first on a refusal. */
  readonly outcome: string;
  /** The floor walk, when one ran. */
  readonly walk: VerifyAcResult | null;
  readonly predicate: AcceptancePredicate | null;
}

/**
 * Completion floor (#7047). Called only where the #4870 zero-verified refusal
 * would fire on a clause-bearing brief. Applies only when the effective
 * contract has no command and no refused record (else null: the refusal stands
 * as before). The declared test command joins one more ordinary walk as a
 * transient record, so safety, the blocking refusal, reuse and applyOracle all
 * apply. Nothing is written to the brief.
 */
function runDeclaredTestFloor(
  plan: Record<string, unknown>,
  walkOptions: EvaluateVerifyAcOptions,
  resolveDeclared: (projectRoot: string) => DeclaredTestCommand | null,
  provenance: { readonly prNumber: number | null; readonly mergeCommit: string },
): DeclaredTestFloorResult | null {
  const contract = resolveAcceptanceCommandRecords(plan, {
    captureFromNarratives: walkOptions.captureFromNarratives,
  });
  if (contract.commands.length > 0 || contract.blocking.length > 0) {
    return null;
  }
  const projectRoot = resolve(walkOptions.projectRoot ?? process.cwd());
  const declared = resolveDeclared(projectRoot);
  if (declared === null) {
    return { admitted: null, outcome: DECLARED_TEST_FLOOR_NONE, walk: null, predicate: null };
  }
  const where = describeDeclaredTestCommand(declared, projectRoot);
  const built = declaredTestFloorRecord(declared);
  if ("refused" in built) {
    return {
      admitted: null,
      outcome: `declared test command refused: ${built.refused} (${where}); nothing was run (#7047)`,
      walk: null,
      predicate: null,
    };
  }
  const record = built.record;
  const floorWalk = evaluateVerifyAcFromPlan(plan, {
    ...walkOptions,
    completionFloorRecord: record,
  });
  const verdict = resolveAcceptanceVerdict({
    ...floorWalk,
    completionContext:
      provenance.mergeCommit.length > 0 || provenance.prNumber !== null
        ? {
            mergeCommit: provenance.mergeCommit.length > 0 ? provenance.mergeCommit : null,
            prNumber: provenance.prNumber,
          }
        : undefined,
  });
  const quoted = `\`${record.command}\``;
  if (floorWalk.ok && !walkReportsZeroVerified(floorWalk, verdict.predicate)) {
    return {
      admitted: {
        ok: true,
        message:
          `scope:complete: declared test command passed (#7047): ${quoted} (${where}); ` +
          `the acceptance clauses are not individually verified\n${floorWalk.message}`,
        reports: [],
        servedFrom: floorWalk.servedFrom ?? "executed",
        predicate: verdict.predicate,
      },
      outcome: "",
      walk: floorWalk,
      predicate: verdict.predicate,
    };
  }
  const refused = (floorWalk.rejected ?? []).find((row) => row.command === record.command);
  const run = floorWalk.runs.find((row) => row.command === record.command);
  let outcome: string;
  if (refused !== undefined) {
    outcome = `declared test command refused: ${refused.reason} — ${quoted} (${where}); nothing was run (#7047)`;
  } else if (run !== undefined && !run.ok) {
    outcome =
      `declared test command failed: ${quoted} (${where}), exit ${String(run.exitCode)}` +
      `${lastOutputLines(run)} (#7047)`;
  } else if (run === undefined) {
    outcome = `declared test command did not run: ${quoted} (${where}) (#7047)`;
  } else {
    outcome = `declared test command passed, but the acceptance walk still refused: ${quoted} (${where}) (#7047)`;
  }
  return { admitted: null, outcome, walk: floorWalk, predicate: verdict.predicate };
}

/** Options for the scope:complete acceptance walk. */
export interface ScopeCompleteAcceptanceWalkOptions extends EvaluateVerifyAcOptions {
  /**
   * The completion floor's command source (#7047). scope:complete passes
   * `resolveDeclaredTestCommand` from the consumer test lane; it is injected,
   * not imported here, because that module's import graph reaches back into
   * this one. Absent means no floor runs.
   */
  readonly resolveDeclaredTestCommand?: (projectRoot: string) => DeclaredTestCommand | null;
}

/**
 * Hard precondition for scope:complete (#3357 / #3267 / #3284).
 *
 * Runs the same verify:ac walk check uses, through the one shared option profile and
 * the one shared verdict resolver (#3497) — so scope:complete can no longer report a
 * different story than verify:ac about the same artifact. Disposition on plan items
 * does not skip it. Briefs with no stamped plan.acceptance and no executable commands
 * keep the legacy #3267 "nothing to run" pass so existing evidence-only fixtures stay
 * valid.
 */
export function evaluateScopeCompleteAcceptanceWalk(
  plan: Record<string, unknown>,
  options: ScopeCompleteAcceptanceWalkOptions = {},
): AcceptanceEvidenceGateResult {
  const stamped = plan.acceptance !== undefined;
  const profile = resolveAcceptanceGateProfile("complete");
  const { resolveDeclaredTestCommand: resolveDeclared, ...verifyOptions } = options;
  const walkOptions: EvaluateVerifyAcOptions = {
    ...verifyOptions,
    checkIntegrated: profile.checkIntegrated,
    captureFromNarratives: options.captureFromNarratives ?? profile.captureFromNarratives,
    reuseMode: options.reuseMode ?? profile.reuseMode,
  };
  const walk = evaluateVerifyAcFromPlan(plan, walkOptions);
  const rejectedCount = walk.rejected?.length ?? 0;
  const hadWork = walk.runs.length > 0 || walk.commands.length > 0 || rejectedCount > 0;
  const servedFrom = walk.servedFrom ?? "executed";
  if (!stamped && !hadWork) {
    return {
      ok: true,
      message: "Acceptance walk not required (no stamped plan.acceptance) (#3357)",
      reports: [],
      servedFrom: "executed",
    };
  }
  // #5393: thread merge+pr into clause-walk-failed remedy selection.
  const prov = readCompletionProvenance(plan);
  const mergeCommit =
    prov !== null && typeof prov.mergeCommit === "string" ? prov.mergeCommit.trim() : "";
  const prNumber =
    prov !== null &&
    typeof prov.prNumber === "number" &&
    Number.isFinite(prov.prNumber) &&
    prov.prNumber > 0
      ? prov.prNumber
      : null;
  const verdict = resolveAcceptanceVerdict({
    ...walk,
    completionContext:
      mergeCommit.length > 0 || prNumber !== null
        ? { mergeCommit: mergeCommit.length > 0 ? mergeCommit : null, prNumber }
        : undefined,
  });
  const historical = isHistoricalShipCloseout(plan);
  const clauseLess = isClauseLessAcceptance(plan);
  if (walk.ok) {
    // #4870: refuse the #4866 zero-verified print on complete unless a green
    // executable oracle ran. verify:ac / #3826 stay unreverted.
    // #5477: rapid check may waive the same print for an in-diff completed
    // walk under the lifecycle-maintenance set (see rapid-zero-verified).
    // #6644: with a clause walk, the rule is decided from the counts (granted
    // clauses are already left out of them), not from the printed lead.
    if (walkReportsZeroVerified(walk, verdict.predicate)) {
      // #5403 Stage-2 (a): clause-less + merge provenance admits without inventing commands.
      if (historical && clauseLess) {
        return {
          ok: true,
          message: HISTORICAL_SHIP_CLOSEOUT_ADMIT_MESSAGE,
          reports: [],
          servedFrom,
          predicate: "empty-pass",
        };
      }
      // #7047: a clause-bearing brief with no effective command gets one more
      // ordinary walk with the project's declared test command as a floor.
      const floor =
        clauseLess || resolveDeclared === undefined
          ? null
          : runDeclaredTestFloor(plan, walkOptions, resolveDeclared, {
              prNumber,
              mergeCommit,
            });
      if (floor !== null && floor.admitted !== null) {
        return floor.admitted;
      }
      // #7047: every clause-bearing refusal shows the clause list and grant
      // command (#6644), whether or not this run stamped delivered provenance.
      const finalWalk = floor?.walk ?? walk;
      const floorLine = floor === null ? "" : `${floor.outcome}\n`;
      const remediation = scopeCompleteRemediation(
        plan,
        unresolvedClauseRows(finalWalk.clauseOutcomes ?? walk.clauseOutcomes ?? []),
      );
      return {
        ok: false,
        message:
          `${SCOPE_COMPLETE_ZERO_VERIFIED_NOTICE}` +
          `${floorLine}${remediation}\n${finalWalk.message}`,
        reports: [],
        servedFrom: finalWalk.servedFrom ?? servedFrom,
        predicate: floor?.predicate ?? verdict.predicate,
      };
    }
    return {
      ok: true,
      message: walk.message,
      reports: [],
      servedFrom,
      predicate: verdict.predicate,
    };
  }
  // #5403 Stage-2 (a): empty-acceptance / soft_empty on clause-less historical ship.
  if (
    historical &&
    clauseLess &&
    (verdict.predicate === "empty-acceptance" || verdict.predicate === "empty-pass")
  ) {
    return {
      ok: true,
      message: HISTORICAL_SHIP_CLOSEOUT_ADMIT_MESSAGE,
      reports: [],
      servedFrom,
      predicate: "empty-pass",
    };
  }
  const remediation = scopeCompleteRemediation(
    plan,
    unresolvedClauseRows(walk.clauseOutcomes ?? []),
  );
  return {
    ok: false,
    // Name the check that refused and the value it read BEFORE the standing
    // contract, so the first line the operator sees is the actual cause (#3497).
    message:
      `scope:complete refused acceptance — ${formatAcceptanceVerdict(verdict)}\n` +
      `${remediation}\n${walk.message}`,
    reports: [],
    servedFrom,
    predicate: verdict.predicate,
  };
}

/**
 * Optional caller context. Stamp / ancestry fields are ignored: this gate is
 * read-only over the plan it is given (#5120). Prospective merge stamps live on
 * stampMergeFromCompletionProvenance.
 */
export interface EvaluateAcceptanceEvidenceGateOptions {
  readonly projectRoot?: string;
  readonly runGit?: GitRunner;
  readonly verifyAncestry?: MergeAncestryVerifier;
  readonly recorded_by?: string;
  readonly recorded_at?: string;
}

/**
 * Fail closed when any non-terminal plan item lacks suitable evidence or a human-origin disposition.
 * Read-only: evaluates persisted evidence only. Does not stamp x-directive/evidence
 * (#4732 / #5120). Prospective merge stamps are a scope:complete persist-path step.
 */
export function evaluateAcceptanceEvidenceGate(
  plan: Record<string, unknown>,
  _options: EvaluateAcceptanceEvidenceGateOptions = {},
): AcceptanceEvidenceGateResult {
  const reports: CriterionAcceptanceReport[] = [];
  walkItems(plan.items, "plan.items", reports, clauseBindingKeysFromPlan(plan));

  const blockers = reports.filter((r) => r.outcome === "missing" || r.outcome === "invalid");

  if (blockers.length === 0) {
    const lines = reports
      .filter((r) => r.outcome === "evidence" || r.outcome === "disposition")
      .map(
        (r) => `  - ${r.path} ${fenceUntrustedAcceptanceText(r.title)}: ${r.outcome} (${r.detail})`,
      );
    const summary =
      lines.length > 0
        ? `Acceptance evidence gate passed (#3240):\n${lines.join("\n")}`
        : "Acceptance evidence gate passed (#3240): no non-terminal criteria";
    return { ok: true, message: summary, reports };
  }

  const lines = blockers.map(
    (r) => `  - ${r.path} ${fenceUntrustedAcceptanceText(r.title)}: ${r.detail}`,
  );
  return {
    ok: false,
    message:
      `Acceptance evidence required for scope:complete (#3240 / #3305). ` +
      `${blockers.length} criterion/criteria missing suitable evidence or disposition:\n` +
      `${lines.join("\n")}\n` +
      `Each non-terminal plan item needs ${ACCEPTANCE_EVIDENCE_KEY} ` +
      `{kind: test|review|merge|deploy|smoke|uat|observed_behavior, pointer, recorded_at, recorded_by} ` +
      `or ${ACCEPTANCE_DISPOSITION_KEY} {disposition: waived|deferred|not_applicable, reason, provenance ${DISPOSITION_PROVENANCE_SHAPE}, recorded_at}. ` +
      `Bare evidence/disposition keys are not valid (#1620 / #3305). ` +
      `merge/review alone cannot satisfy smoke|uat|deploy|observed_behavior criteria. ` +
      `Write evidence/disposition on the plan item at the reported path; ` +
      `this gate does not read evidence/disposition from plan.acceptance.clauses[].`,
    reports,
  };
}

/**
 * Format a short multi-line listing of evidence/disposition for every criterion
 * (including already-terminal) for complete success output.
 */
export function formatAcceptanceCompletionListing(
  reports: readonly CriterionAcceptanceReport[],
): string {
  if (reports.length === 0) {
    return "Acceptance criteria: (none)";
  }
  const lines = reports.map((r) => {
    const label = fenceUntrustedAcceptanceText(r.title);
    if (r.outcome === "evidence" && r.evidence) {
      return `  - ${r.path} ${label}: evidence kind=${r.evidence.kind} pointer=${fenceUntrustedAcceptanceText(r.evidence.pointer)}`;
    }
    if (r.outcome === "disposition" && r.disposition) {
      return (
        `  - ${r.path} ${label}: disposition=${r.disposition.disposition} ` +
        `reason=${fenceUntrustedAcceptanceText(r.disposition.reason)}`
      );
    }
    return `  - ${r.path} ${label}: ${r.outcome} (${r.detail})`;
  });
  return `Acceptance criteria:\n${lines.join("\n")}`;
}
