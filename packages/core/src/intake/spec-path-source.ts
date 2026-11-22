/**
 * Spec-path harvest, source record and live identity resolver (#6333).
 *
 * A Spec-path brief is harvested from the accepted lean: the Bound remedy items
 * followed by the Acceptance Criteria items, or one slice label, or the items
 * with no label. Ingest records where the harvest came from so `verify:ac` can
 * compare a brief that is not yet on the merge base with the lean itself.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scan } from "../cache/scanner.js";
import {
  evaluateCompletedArcRecord,
  type ThreadComment,
  threadCommentFromRow,
} from "../design-critique/completed-arc-record.js";
import {
  hashHarvestIdentity,
  hashHarvestIdentityPreFold,
} from "../design-critique/pain-audit-follow-through-gate.js";
import { type CompletedProcess, call } from "../scm/call.js";
import {
  commentsForArcRead,
  criteriaListUnits,
  mayWriteCriteriaOnlyRecord,
} from "./admitted-source-units.js";
import type { CheckboxItem } from "./markdown-scanners.js";
import {
  readSpecPathLeanStructure,
  specPathLeanHarvestRefusal,
} from "./spec-path-harvest-check.js";

/** plan.metadata key for the Spec-path source record (#6333 item 4). */
export const SPEC_PATH_SOURCE_KEY = "x-directive/spec-path-source" as const;
export const SPEC_PATH_SOURCE_SCHEMA = "deft.scope.spec-path-source.v1" as const;

export interface SpecPathSourceRecord {
  /** `owner/name` of the issue that holds the completed-arc record. */
  readonly repo: string;
  /** Issue whose completed-arc record cites the lean (the parent for a slice). */
  readonly issue: number;
  readonly leanCommentId: number;
  /** `hashHarvestIdentity` of the cited lean at ingest. */
  readonly harvestDigest: string;
  /** Slice label, or null for the issue's own (unlabeled) harvest. */
  readonly slice: string | null;
  /**
   * `criteria-only` when `leanCommentId` is a not-warranted record comment that
   * carries an Acceptance Criteria list (#6609 item 6). A record without `kind`
   * is a lean record, as before.
   */
  readonly kind?: "criteria-only";
}

/** `kind` of a criteria-only record (#6609 item 6). */
export const SPEC_PATH_SOURCE_KIND_CRITERIA_ONLY = "criteria-only" as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Read a well-formed source record from a plan, else null (#6333). */
export function readSpecPathSourceRecord(plan: unknown): SpecPathSourceRecord | null {
  const raw = asRecord(asRecord(asRecord(plan)?.metadata)?.[SPEC_PATH_SOURCE_KEY]);
  if (raw === null || raw.schema !== SPEC_PATH_SOURCE_SCHEMA) {
    return null;
  }
  const { repo, issue, leanCommentId, harvestDigest, slice, kind } = raw;
  if (kind !== undefined && kind !== SPEC_PATH_SOURCE_KIND_CRITERIA_ONLY) {
    return null;
  }
  if (
    typeof repo !== "string" ||
    !/^[^/\s]+\/[^/\s]+$/.test(repo) ||
    typeof issue !== "number" ||
    !Number.isSafeInteger(issue) ||
    issue < 1 ||
    typeof leanCommentId !== "number" ||
    !Number.isSafeInteger(leanCommentId) ||
    leanCommentId < 1 ||
    typeof harvestDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(harvestDigest) ||
    !(slice === null || (typeof slice === "string" && slice.length > 0))
  ) {
    return null;
  }
  return {
    repo,
    issue,
    leanCommentId,
    harvestDigest,
    slice,
    ...(kind === SPEC_PATH_SOURCE_KIND_CRITERIA_ONLY ? { kind } : {}),
  };
}

/** Write the source record onto plan.metadata (#6333 item 4). */
export function attachSpecPathSourceRecord(
  plan: Record<string, unknown>,
  record: SpecPathSourceRecord,
): void {
  const meta = asRecord(plan.metadata) ?? {};
  meta[SPEC_PATH_SOURCE_KEY] = {
    schema: SPEC_PATH_SOURCE_SCHEMA,
    repo: record.repo,
    issue: record.issue,
    leanCommentId: record.leanCommentId,
    harvestDigest: record.harvestDigest,
    slice: record.slice,
    ...(record.kind !== undefined ? { kind: record.kind } : {}),
  };
  plan.metadata = meta;
}

export type SpecPathHarvestSelection =
  | { readonly kind: "unlabeled" }
  | { readonly kind: "label"; readonly label: string };

export type SpecPathHarvestResult =
  | {
      readonly ok: true;
      readonly items: readonly CheckboxItem[];
      readonly sourceText: string;
      readonly constraintLines: readonly string[];
      readonly harvestDigest: string;
      /** Every label the lean's Slices section names (empty when none). */
      readonly labels: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: string;
      /** Slice labels of the lean, set when every item belongs to a slice (#7085). */
      readonly labels?: readonly string[];
    };

/** harvestSpecPathLean reason when every item belongs to a slice label (#7085). */
export const ALL_ITEMS_SLICED_REASON =
  "every harvested item of the cited lean belongs to a slice label";

/**
 * Harvest a Spec-path lean (#6333 items 1 and 6). Bound remedy items come first,
 * then Acceptance Criteria items; an item title already harvested is not
 * repeated. With a Slices section, `unlabeled` takes the items with no label
 * and `label` takes the items of that label.
 */
export function harvestSpecPathLean(
  leanBody: string,
  selection: SpecPathHarvestSelection,
): SpecPathHarvestResult {
  // #7001: the checks that do not depend on a slice label are shared with the
  // completed-arc reader, so a lean that fails them is refused before the record.
  const refusal = specPathLeanHarvestRefusal(leanBody);
  if (refusal !== null) {
    return { ok: false, reason: refusal };
  }
  // Each indented continuation line is folded into its item (#7001). Every list
  // position keeps its own row (repeated titles included) so a slice reference
  // names the item at that position; duplicate titles are folded only inside
  // the selected harvest.
  const lean = readSpecPathLeanStructure(leanBody);
  const { boundRows, acceptanceRows } = lean;
  const tagged: { ref: string; item: CheckboxItem }[] = [
    ...boundRows.map((item, index) => ({ ref: `B${index + 1}`, item })),
    ...acceptanceRows.map((item, index) => ({ ref: `A${index + 1}`, item })),
  ];

  const labelOf = new Map<string, string>();
  const labels: string[] = [];
  if (lean.slices.present) {
    for (const assignment of lean.slices.assignments) {
      labels.push(assignment.label);
      for (const ref of assignment.refs) {
        labelOf.set(`${ref.list}${ref.index}`, assignment.label);
      }
    }
  } else if (selection.kind === "label") {
    return {
      ok: false,
      reason: `cited lean has no Slices section, so it has no slice '${selection.label}'`,
    };
  }
  if (selection.kind === "label" && !labels.includes(selection.label)) {
    return {
      ok: false,
      reason: `cited lean Slices section has no slice '${selection.label}' (labels: ${labels.join(", ")})`,
    };
  }

  const wanted = selection.kind === "label" ? selection.label : undefined;
  const seen = new Set<string>();
  const items: CheckboxItem[] = [];
  for (const row of tagged) {
    if (labelOf.get(row.ref) === wanted && !seen.has(row.item.title)) {
      seen.add(row.item.title);
      items.push(row.item);
    }
  }
  if (items.length === 0) {
    if (selection.kind === "label") {
      return { ok: false, reason: `cited lean slice '${selection.label}' has no items` };
    }
    return { ok: false, reason: ALL_ITEMS_SLICED_REASON, labels };
  }

  let sourceText: string;
  if (lean.slices.present) {
    sourceText = `${items.map((item) => `- ${item.title}`).join("\n")}\n`;
  } else {
    sourceText =
      lean.acceptanceSourceText === null || acceptanceRows.length === 0
        ? lean.boundSourceText
        : `${lean.boundSourceText.trimEnd()}\n\n## Acceptance Criteria\n${lean.acceptanceSourceText}`;
  }
  return {
    ok: true,
    items,
    sourceText,
    constraintLines: lean.constraintLines,
    harvestDigest: hashHarvestIdentity(leanBody),
    labels,
  };
}

export type SpecPathLiveIdentities =
  | { readonly ok: true; readonly identities: readonly string[] }
  | { readonly ok: false; readonly kind: "unavailable" | "mismatch"; readonly reason: string };

/**
 * Live identities for a recorded brief (#6333 item 4): resolve the lean through
 * the completed-arc record of the source issue, refuse a recorded lean id that
 * differs from the cited lean, and harvest the same selection ingest used.
 * Each title gets the ingest quarantine transform.
 */
export function resolveSpecPathLiveIdentities(input: {
  readonly comments: readonly ThreadComment[];
  readonly record: SpecPathSourceRecord;
}): SpecPathLiveIdentities {
  const { record } = input;
  // The same arc reader as ingest (#6609): a later criteria-only record comment
  // is not a successor lean, so it must not break an unchanged brief.
  const verdict = evaluateCompletedArcRecord({
    comments: commentsForArcRead(input.comments),
    issueNumber: record.issue,
  });
  if (verdict.status !== "complete") {
    const detail =
      verdict.status === "blocked" ? `${verdict.reason}: ${verdict.detail}` : "not in a design arc";
    return {
      ok: false,
      kind: "mismatch",
      reason: `completed-arc record of #${record.issue} does not resolve a cited lean (${detail})`,
    };
  }
  if (verdict.citedLeanId !== record.leanCommentId) {
    return {
      ok: false,
      kind: "mismatch",
      reason:
        `recorded lean id ${record.leanCommentId} differs from the cited lean ` +
        `${verdict.citedLeanId} of #${record.issue}`,
    };
  }
  const lean = input.comments.find((comment) => comment.id === verdict.citedLeanId);
  const harvest = harvestSpecPathLean(
    lean?.body ?? "",
    record.slice === null ? { kind: "unlabeled" } : { kind: "label", label: record.slice },
  );
  if (!harvest.ok) {
    return { ok: false, kind: "mismatch", reason: harvest.reason };
  }
  // The lean must still be the one ingest recorded (an in-place edit after
  // ingest moves the harvest digest even when the pin is edited to follow it).
  if (harvest.harvestDigest !== record.harvestDigest) {
    return {
      ok: false,
      kind: "mismatch",
      reason:
        `lean ${record.leanCommentId} of #${record.issue} changed after ingest ` +
        `(harvest digest ${harvest.harvestDigest.slice(0, 12)} is not the recorded ${record.harvestDigest.slice(0, 12)})`,
    };
  }
  const identities: string[] = [];
  for (const item of harvest.items) {
    const scanned = scan(item.title);
    if (scanned.flags.some((flag) => flag.severity === "hard-fail")) {
      return {
        ok: false,
        kind: "mismatch",
        reason: "quarantine scanner hard-fail on a harvested lean item",
      };
    }
    identities.push(scanned.transformed_content);
  }
  return { ok: true, identities };
}

/** One REST page of issue comments; injectable for tests. */
export type SpecPathCommentPageFetch = (path: string) => CompletedProcess;

function defaultCommentPageFetch(path: string): CompletedProcess {
  return call("github-issue", "api", [path], { timeout: 30 });
}

/**
 * Read the source issue comment thread over REST (#6333 item 4). Returns a
 * failure on an outage or an unparseable page; never a partial thread.
 */
export function fetchSpecPathSourceComments(
  record: SpecPathSourceRecord,
  fetchPage: SpecPathCommentPageFetch = defaultCommentPageFetch,
):
  | { readonly ok: true; readonly comments: ThreadComment[] }
  | { readonly ok: false; readonly reason: string } {
  const comments: ThreadComment[] = [];
  for (let page = 1; page <= 50; page += 1) {
    const path = `repos/${record.repo}/issues/${record.issue}/comments?per_page=100&page=${page}`;
    let result: CompletedProcess;
    try {
      result = fetchPage(path);
    } catch (exc) {
      return {
        ok: false,
        reason: `forge outage: ${exc instanceof Error ? exc.message : String(exc)}`,
      };
    }
    if (result.returncode !== 0) {
      const detail = (result.stderr || "").trim() || `exit ${result.returncode}`;
      return { ok: false, reason: `forge outage: ${detail}` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return { ok: false, reason: `comments page ${page} for #${record.issue} is not JSON` };
    }
    if (!Array.isArray(parsed)) {
      return { ok: false, reason: `comments page ${page} for #${record.issue} is not a list` };
    }
    for (const entry of parsed) {
      const row = asRecord(entry);
      if (row !== null && typeof row.id === "number" && typeof row.body === "string") {
        comments.push(threadCommentFromRow(row.id, row.body, row));
      }
    }
    if (parsed.length < 100) {
      return { ok: true, comments };
    }
  }
  return { ok: false, reason: `comments for #${record.issue} exceed the page cap` };
}

function readRestJson(
  fetchPage: SpecPathCommentPageFetch,
  path: string,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: string } {
  let result: CompletedProcess;
  try {
    result = fetchPage(path);
  } catch (exc) {
    return {
      ok: false,
      reason: `forge outage: ${exc instanceof Error ? exc.message : String(exc)}`,
    };
  }
  if (result.returncode !== 0) {
    return {
      ok: false,
      reason: `forge outage: ${(result.stderr || "").trim() || `exit ${result.returncode}`}`,
    };
  }
  try {
    return { ok: true, value: JSON.parse(result.stdout) as unknown };
  } catch {
    return { ok: false, reason: `${path} is not JSON` };
  }
}

function loginOf(row: Record<string, unknown> | null): string | null {
  const login = asRecord(row?.user)?.login;
  return typeof login === "string" && login.length > 0 ? login : null;
}

/**
 * Live identities of a criteria-only record (#6609 item 6): fetch the record
 * comment by id, check it still has the recorded harvest digest, that its
 * author is the issue's author or still has write access (the existing
 * collaborator-permission lookup), and read its items with the same unit rule
 * ingest used. Each item gets the ingest quarantine transform.
 */
export function fetchCriteriaOnlyLiveIdentities(
  record: SpecPathSourceRecord,
  fetchPage: SpecPathCommentPageFetch = defaultCommentPageFetch,
): SpecPathLiveIdentities {
  const commentRead = readRestJson(
    fetchPage,
    `repos/${record.repo}/issues/comments/${record.leanCommentId}`,
  );
  if (!commentRead.ok) {
    return { ok: false, kind: "unavailable", reason: commentRead.reason };
  }
  const comment = asRecord(commentRead.value);
  const body = typeof comment?.body === "string" ? comment.body : null;
  if (body === null) {
    return {
      ok: false,
      kind: "mismatch",
      reason: `criteria-only record comment ${record.leanCommentId} of #${record.issue} has no body`,
    };
  }
  const issueRead = readRestJson(fetchPage, `repos/${record.repo}/issues/${record.issue}`);
  if (!issueRead.ok) {
    return { ok: false, kind: "unavailable", reason: issueRead.reason };
  }
  const allowed = mayWriteCriteriaOnlyRecord({
    login: loginOf(comment),
    issueAuthor: loginOf(asRecord(issueRead.value)),
    repo: record.repo,
    reader: {
      getJson: (path) => {
        const read = readRestJson(fetchPage, path);
        return read.ok ? { ok: true, value: read.value } : { ok: false, detail: read.reason };
      },
    },
  });
  if (!allowed) {
    return {
      ok: false,
      kind: "mismatch",
      reason:
        `criteria-only record comment ${record.leanCommentId} of #${record.issue} is not by the ` +
        "issue's author or an account with write access",
    };
  }
  // The criteria-only route reads its items unfolded, so its digest stays the
  // pre-fold identity (#7001).
  const digest = hashHarvestIdentityPreFold(body);
  if (digest !== record.harvestDigest) {
    return {
      ok: false,
      kind: "mismatch",
      reason:
        `criteria-only record ${record.leanCommentId} of #${record.issue} changed after ingest ` +
        `(harvest digest ${digest.slice(0, 12)} is not the recorded ${record.harvestDigest.slice(0, 12)})`,
    };
  }
  const items = criteriaListUnits(body);
  if (items.length === 0) {
    return {
      ok: false,
      kind: "mismatch",
      reason: `criteria-only record ${record.leanCommentId} of #${record.issue} has no Acceptance Criteria list`,
    };
  }
  const identities: string[] = [];
  for (const item of items) {
    const scanned = scan(item);
    if (scanned.flags.some((flag) => flag.severity === "hard-fail")) {
      return {
        ok: false,
        kind: "mismatch",
        reason: "quarantine scanner hard-fail on a criteria-only record item",
      };
    }
    identities.push(scanned.transformed_content);
  }
  return { ok: true, identities };
}

/**
 * Live admitted-source text of a brief for the activation check (#6609 item 7),
 * as `verify:ac` fetches it: a Spec-path brief reads its Overview harvest, a
 * body-route brief the live origin issue body over REST. Failure is returned.
 */
export function fetchPlanAdmittedSourceText(
  plan: Record<string, unknown>,
  fetchPage: SpecPathCommentPageFetch = defaultCommentPageFetch,
): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string } {
  const meta = asRecord(plan.metadata);
  if (meta !== null && Object.hasOwn(meta, "issueBody") && typeof meta.issueBody === "string") {
    const overview = asRecord(plan.narratives)?.Overview;
    return typeof overview === "string" && overview.trim().length > 0
      ? { ok: true, text: overview }
      : {
          ok: false,
          reason:
            "Spec-path Bound-remedy harvest unavailable (Overview empty); refuse offline / restore from git",
        };
  }
  const refs = Array.isArray(plan.references) ? plan.references : [];
  let issueUri: string | null = null;
  for (const entry of refs) {
    const row = asRecord(entry);
    if (row?.type === "x-xbrief/github-issue" && typeof row.uri === "string") {
      issueUri = row.uri;
      break;
    }
  }
  if (issueUri === null) {
    return { ok: false, reason: "no github-issue reference on the brief for live REST" };
  }
  const match = /github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/i.exec(issueUri);
  if (match === null) {
    return { ok: false, reason: `unparseable github-issue uri: ${issueUri}` };
  }
  const read = readRestJson(fetchPage, `repos/${match[1]}/${match[2]}/issues/${match[3]}`);
  if (!read.ok) {
    return { ok: false, reason: read.reason };
  }
  const body = asRecord(read.value)?.body;
  return { ok: true, text: typeof body === "string" ? body : "" };
}

/** Default verify:ac live resolver: REST thread, then the resolver above (#6333). */
export function fetchSpecPathLiveIdentities(
  record: SpecPathSourceRecord,
  fetchPage?: SpecPathCommentPageFetch,
): SpecPathLiveIdentities {
  if (record.kind === SPEC_PATH_SOURCE_KIND_CRITERIA_ONLY) {
    return fetchCriteriaOnlyLiveIdentities(record, fetchPage);
  }
  const thread = fetchSpecPathSourceComments(record, fetchPage);
  if (!thread.ok) {
    return { ok: false, kind: "unavailable", reason: thread.reason };
  }
  return resolveSpecPathLiveIdentities({ comments: thread.comments, record });
}

/**
 * Slice labels already recorded by briefs for one parent and lean (#6333 item
 * 6): label -> brief path relative to the lifecycle root. Cancelled briefs do
 * not hold a label.
 */
export function findSpecPathSliceHolders(
  lifecycleRoot: string,
  key: { readonly repo: string; readonly issue: number; readonly leanCommentId: number },
): Map<string, string> {
  const holders = new Map<string, string>();
  for (const folder of ["proposed", "pending", "active", "completed"]) {
    const dir = join(lifecycleRoot, folder);
    if (!existsSync(dir)) {
      continue;
    }
    let names: string[];
    try {
      names = readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .sort();
    } catch {
      continue;
    }
    for (const name of names) {
      let record: SpecPathSourceRecord | null = null;
      try {
        const data = asRecord(JSON.parse(readFileSync(join(dir, name), "utf8")));
        record = readSpecPathSourceRecord(data?.plan);
      } catch {
        continue;
      }
      if (
        record !== null &&
        record.slice !== null &&
        record.repo.toLowerCase() === key.repo.toLowerCase() &&
        record.issue === key.issue &&
        record.leanCommentId === key.leanCommentId &&
        !holders.has(record.slice)
      ) {
        holders.set(record.slice, `${folder}/${name}`);
      }
    }
  }
  return holders;
}
