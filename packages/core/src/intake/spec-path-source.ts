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
} from "../design-critique/completed-arc-record.js";
import { hashHarvestIdentity } from "../design-critique/pain-audit-follow-through-gate.js";
import { type CompletedProcess, call } from "../scm/call.js";
import {
  type CheckboxItem,
  extractBoundRemedyHarvest,
  leanAcceptanceCriteriaItems,
  parseLeanSlices,
  sliceLeanAcceptanceCriteriaSection,
} from "./markdown-scanners.js";

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
}

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
  const { repo, issue, leanCommentId, harvestDigest, slice } = raw;
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
  return { repo, issue, leanCommentId, harvestDigest, slice };
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
  | { readonly ok: false; readonly reason: string };

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
  const bound = extractBoundRemedyHarvest(leanBody);
  if (bound.items.length === 0) {
    return { ok: false, reason: "cited successor lean has no Bound-remedy list" };
  }
  const acceptance = leanAcceptanceCriteriaItems(leanBody);
  const tagged: { ref: string; item: CheckboxItem }[] = [];
  const seen = new Set<string>();
  bound.items.forEach((item, index) => {
    seen.add(item.title);
    tagged.push({ ref: `B${index + 1}`, item });
  });
  acceptance.forEach((item, index) => {
    if (!seen.has(item.title)) {
      seen.add(item.title);
      tagged.push({ ref: `A${index + 1}`, item });
    }
  });

  const slices = parseLeanSlices(leanBody);
  const labelOf = new Map<string, string>();
  const labels: string[] = [];
  if (slices.present) {
    if (slices.errors.length > 0) {
      return { ok: false, reason: `cited lean Slices section: ${slices.errors.join("; ")}` };
    }
    for (const assignment of slices.assignments) {
      labels.push(assignment.label);
      for (const ref of assignment.refs) {
        const size = ref.list === "B" ? bound.items.length : acceptance.length;
        const key = `${ref.list}${ref.index}`;
        if (ref.index > size) {
          return {
            ok: false,
            reason: `cited lean Slices section: slice '${assignment.label}' names ${key}, which is not a harvested item`,
          };
        }
        const prior = labelOf.get(key);
        if (prior !== undefined) {
          return {
            ok: false,
            reason: `cited lean Slices section: ${key} is assigned to both '${prior}' and '${assignment.label}'`,
          };
        }
        labelOf.set(key, assignment.label);
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
  const items = tagged.filter((row) => labelOf.get(row.ref) === wanted).map((row) => row.item);
  if (items.length === 0) {
    return {
      ok: false,
      reason:
        selection.kind === "label"
          ? `cited lean slice '${selection.label}' has no items`
          : "every harvested item of the cited lean belongs to a slice label",
    };
  }

  let sourceText: string;
  if (slices.present) {
    sourceText = `${items.map((item) => `- ${item.title}`).join("\n")}\n`;
  } else {
    const acSlice = acceptance.length > 0 ? sliceLeanAcceptanceCriteriaSection(leanBody) : null;
    sourceText =
      acSlice === null
        ? bound.sourceText
        : `${bound.sourceText.replace(/\s+$/, "")}\n\n## Acceptance Criteria\n${acSlice}`;
  }
  return {
    ok: true,
    items,
    sourceText,
    constraintLines: bound.constraintLines,
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
  const verdict = evaluateCompletedArcRecord({
    comments: input.comments,
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
        comments.push({ id: row.id, body: row.body });
      }
    }
    if (parsed.length < 100) {
      return { ok: true, comments };
    }
  }
  return { ok: false, reason: `comments for #${record.issue} exceed the page cap` };
}

/** Default verify:ac live resolver: REST thread, then the resolver above (#6333). */
export function fetchSpecPathLiveIdentities(
  record: SpecPathSourceRecord,
  fetchPage?: SpecPathCommentPageFetch,
): SpecPathLiveIdentities {
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
