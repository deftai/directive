/**
 * Parent-requirement coverage map for scope:decompose semantic fidelity (#3238 / epic #3237).
 *
 * When a parent scope authors stable requirement IDs, a decomposition draft must
 * declare a machine-readable coverage map for every ID. Dispositions are a closed
 * enum (covered | deferred | split | behavioral_delta) with required side fields.
 * Negative invariants cannot be silently dropped: omit → fail closed; intentional
 * change requires disposition behavioral_delta with a linked delta record.
 *
 * No LLM/prose semantic-equivalence judgment — structure only (Q1/Q7/Q8 locks).
 */

export const COVERAGE_DISPOSITIONS = ["covered", "deferred", "split", "behavioral_delta"] as const;

export type CoverageDisposition = (typeof COVERAGE_DISPOSITIONS)[number];

export const BEHAVIORAL_DELTA_CHANGE_KINDS = [
  "reorder_stages",
  "remove_invariant",
  "weaken_invariant",
  "add_terminal_outcome",
  "remove_fallback",
  "change_fallback_order",
  "other",
] as const;

export type BehavioralDeltaChangeKind = (typeof BEHAVIORAL_DELTA_CHANGE_KINDS)[number];

const DISPOSITION_SET = new Set<string>(COVERAGE_DISPOSITIONS);
const CHANGE_KIND_SET = new Set<string>(BEHAVIORAL_DELTA_CHANGE_KINDS);

type JsonObj = Record<string, unknown>;

export interface ParentRequirement {
  readonly id: string;
  readonly title: string;
  readonly negativeInvariant: boolean;
  readonly path: string;
}

export interface DeferredProvenance {
  readonly reason: string;
  readonly target_story_id?: string;
  readonly target_path?: string;
}

export interface CoverageMapEntry {
  readonly parent_requirement_id: string;
  readonly disposition: CoverageDisposition;
  readonly child_story_ids?: readonly string[];
  readonly provenance?: DeferredProvenance;
  readonly split_group?: string;
  readonly part?: string;
  readonly delta_id?: string;
}

export interface BehavioralDeltaRecord {
  readonly delta_id: string;
  readonly parent_requirement_ids: readonly string[];
  readonly change_kind: BehavioralDeltaChangeKind;
  readonly summary: string;
  readonly before: string;
  readonly after: string;
  readonly rationale: string;
}

export interface CoverageEntryReport {
  readonly parent_requirement_id: string;
  readonly disposition: string | null;
  readonly ok: boolean;
  readonly detail: string;
  readonly negative_invariant: boolean;
}

export interface CoverageReport {
  readonly schema: "deft.decompose.coverage_report.v1";
  readonly ok: boolean;
  readonly parent_requirement_ids: readonly string[];
  readonly negative_invariant_ids: readonly string[];
  readonly entries: readonly CoverageEntryReport[];
  readonly uncovered: readonly string[];
  readonly errors: readonly string[];
}

export interface CoverageValidationResult {
  readonly ok: boolean;
  readonly report: CoverageReport;
  readonly errors: readonly string[];
}

function asRecord(value: unknown): JsonObj | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as JsonObj;
  }
  return null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function asStrList(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") return value.trim().length > 0 ? [value.trim()] : [];
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter((s) => s.length > 0);
  }
  return [];
}

function isNegativeInvariant(item: JsonObj): boolean {
  if (item.negative_invariant === true || item.negativeInvariant === true) return true;
  const kind = item.kind ?? item.type;
  if (typeof kind === "string" && kind.trim().toLowerCase() === "negative_invariant") {
    return true;
  }
  const narrative = asRecord(item.narrative);
  if (narrative !== null) {
    if (narrative.NegativeInvariant === true || narrative.negative_invariant === true) {
      return true;
    }
  }
  return false;
}

/**
 * Collect authored parent requirement IDs (Q1).
 * Sources: plan.items (nested) with id; plan.requirements; plan.metadata.requirement_ids.
 */
export function extractParentRequirements(parent: unknown): ParentRequirement[] {
  const root = asRecord(parent);
  if (root === null) return [];
  const plan = asRecord(root.plan) ?? root;
  const byId = new Map<string, ParentRequirement>();

  function add(id: string, title: string, negativeInvariant: boolean, path: string): void {
    const trimmed = id.trim();
    if (!trimmed) return;
    const existing = byId.get(trimmed);
    if (existing !== undefined) {
      if (negativeInvariant && !existing.negativeInvariant) {
        byId.set(trimmed, { ...existing, negativeInvariant: true });
      }
      return;
    }
    byId.set(trimmed, {
      id: trimmed,
      title: title.trim() || trimmed,
      negativeInvariant,
      path,
    });
  }

  function visitItems(items: unknown, prefix: string): void {
    if (!Array.isArray(items)) return;
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const obj = item as JsonObj;
      const path = `${prefix}[${i}]`;
      if (isNonEmptyString(obj.id)) {
        add(obj.id, String(obj.title ?? obj.id), isNegativeInvariant(obj), path);
      }
      visitItems(obj.items, `${path}.items`);
      visitItems(obj.subItems, `${path}.subItems`);
    }
  }

  visitItems(plan.items, "plan.items");

  const requirements = plan.requirements;
  if (Array.isArray(requirements)) {
    for (let i = 0; i < requirements.length; i += 1) {
      const req = requirements[i];
      if (typeof req === "string" && req.trim()) {
        add(req, req, false, `plan.requirements[${i}]`);
        continue;
      }
      if (typeof req === "object" && req !== null && !Array.isArray(req)) {
        const obj = req as JsonObj;
        if (isNonEmptyString(obj.id)) {
          add(
            obj.id,
            String(obj.title ?? obj.id),
            isNegativeInvariant(obj),
            `plan.requirements[${i}]`,
          );
        }
      }
    }
  }

  const metadata = asRecord(plan.metadata);
  if (metadata !== null) {
    for (const id of asStrList(metadata.requirement_ids ?? metadata.requirementIds)) {
      add(id, id, false, "plan.metadata.requirement_ids");
    }
  }

  return [...byId.values()];
}

function parseDisposition(raw: unknown): CoverageDisposition | null {
  if (typeof raw !== "string") return null;
  const norm = raw.trim().toLowerCase();
  return DISPOSITION_SET.has(norm) ? (norm as CoverageDisposition) : null;
}

function parseChangeKind(raw: unknown): BehavioralDeltaChangeKind | null {
  if (typeof raw !== "string") return null;
  const norm = raw.trim().toLowerCase().replace(/-/g, "_");
  return CHANGE_KIND_SET.has(norm) ? (norm as BehavioralDeltaChangeKind) : null;
}

/**
 * Normalize draft.coverage_map from object-map or array form into entry list.
 */
export function parseCoverageMap(raw: unknown): { entries: CoverageMapEntry[]; errors: string[] } {
  const errors: string[] = [];
  const entries: CoverageMapEntry[] = [];

  if (raw === null || raw === undefined) {
    return { entries, errors };
  }

  const pushEntry = (parentId: string, body: JsonObj, loc: string): void => {
    const disposition = parseDisposition(body.disposition);
    if (disposition === null) {
      errors.push(
        `${loc}: disposition must be one of ${COVERAGE_DISPOSITIONS.join("|")} ` +
          `(got ${JSON.stringify(body.disposition ?? null)})`,
      );
      return;
    }

    const entry: {
      parent_requirement_id: string;
      disposition: CoverageDisposition;
      child_story_ids?: string[];
      provenance?: DeferredProvenance;
      split_group?: string;
      part?: string;
      delta_id?: string;
    } = {
      parent_requirement_id: parentId,
      disposition,
    };

    const childIds = asStrList(body.child_story_ids ?? body.childStoryIds ?? body.story_ids);
    if (childIds.length > 0) entry.child_story_ids = childIds;

    if (disposition === "deferred") {
      const provRaw = asRecord(body.provenance) ?? body;
      const reason = provRaw.reason ?? body.reason;
      const targetStory =
        provRaw.target_story_id ??
        provRaw.targetStoryId ??
        body.target_story_id ??
        body.targetStoryId;
      const targetPath =
        provRaw.target_path ?? provRaw.targetPath ?? body.target_path ?? body.targetPath;
      if (!isNonEmptyString(reason)) {
        errors.push(`${loc}: disposition deferred requires provenance.reason`);
      } else if (!isNonEmptyString(targetStory) && !isNonEmptyString(targetPath)) {
        errors.push(
          `${loc}: disposition deferred requires provenance.target_story_id and/or target_path`,
        );
      } else {
        entry.provenance = {
          reason: String(reason).trim(),
          ...(isNonEmptyString(targetStory) ? { target_story_id: targetStory.trim() } : {}),
          ...(isNonEmptyString(targetPath) ? { target_path: targetPath.trim() } : {}),
        };
      }
    }

    if (disposition === "split") {
      const group = body.split_group ?? body.splitGroup;
      const part = body.part;
      if (!isNonEmptyString(group)) {
        errors.push(`${loc}: disposition split requires split_group`);
      } else {
        entry.split_group = group.trim();
      }
      if (part === null || part === undefined || String(part).trim() === "") {
        errors.push(`${loc}: disposition split requires part`);
      } else {
        entry.part = String(part).trim();
      }
    }

    if (disposition === "behavioral_delta") {
      const deltaId = body.delta_id ?? body.deltaId;
      if (!isNonEmptyString(deltaId)) {
        errors.push(
          `${loc}: disposition behavioral_delta requires delta_id (separate approval hook)`,
        );
      } else {
        entry.delta_id = deltaId.trim();
      }
    }

    entries.push(entry as CoverageMapEntry);
  };

  if (Array.isArray(raw)) {
    for (let i = 0; i < raw.length; i += 1) {
      const item = raw[i];
      const loc = `coverage_map[${i}]`;
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        errors.push(`${loc}: entry must be an object`);
        continue;
      }
      const obj = item as JsonObj;
      const parentId = obj.parent_requirement_id ?? obj.parentRequirementId ?? obj.id;
      if (!isNonEmptyString(parentId)) {
        errors.push(`${loc}: parent_requirement_id is required`);
        continue;
      }
      pushEntry(parentId.trim(), obj, loc);
    }
    return { entries, errors };
  }

  const map = asRecord(raw);
  if (map === null) {
    errors.push("coverage_map must be an object map or array of entries");
    return { entries, errors };
  }

  for (const [key, value] of Object.entries(map)) {
    const loc = `coverage_map[${key}]`;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      errors.push(`${loc}: entry must be an object`);
      continue;
    }
    const obj = value as JsonObj;
    const parentId = obj.parent_requirement_id ?? obj.parentRequirementId ?? key;
    if (!isNonEmptyString(parentId)) {
      errors.push(`${loc}: parent_requirement_id is required`);
      continue;
    }
    pushEntry(String(parentId).trim(), obj, loc);
  }
  return { entries, errors };
}

/**
 * Parse draft.behavioral_deltas (array). Records missing required fields are rejected.
 */
export function parseBehavioralDeltas(raw: unknown): {
  deltas: BehavioralDeltaRecord[];
  errors: string[];
  byId: Map<string, BehavioralDeltaRecord>;
} {
  const errors: string[] = [];
  const deltas: BehavioralDeltaRecord[] = [];
  const byId = new Map<string, BehavioralDeltaRecord>();

  if (raw === null || raw === undefined) {
    return { deltas, errors, byId };
  }
  if (!Array.isArray(raw)) {
    errors.push("behavioral_deltas must be an array");
    return { deltas, errors, byId };
  }

  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    const loc = `behavioral_deltas[${i}]`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      errors.push(`${loc}: must be an object`);
      continue;
    }
    const obj = item as JsonObj;
    const deltaId = obj.delta_id ?? obj.deltaId;
    const changeKind = parseChangeKind(obj.change_kind ?? obj.changeKind);
    const parentIds = asStrList(obj.parent_requirement_ids ?? obj.parentRequirementIds);
    const summary = obj.summary;
    const before = obj.before;
    const after = obj.after;
    const rationale = obj.rationale;

    const fieldErrors: string[] = [];
    if (!isNonEmptyString(deltaId)) fieldErrors.push("delta_id");
    if (parentIds.length === 0) fieldErrors.push("parent_requirement_ids[]");
    if (changeKind === null) {
      fieldErrors.push(`change_kind (${BEHAVIORAL_DELTA_CHANGE_KINDS.join("|")})`);
    }
    if (!isNonEmptyString(summary)) fieldErrors.push("summary");
    if (!isNonEmptyString(before)) fieldErrors.push("before");
    if (!isNonEmptyString(after)) fieldErrors.push("after");
    if (!isNonEmptyString(rationale)) fieldErrors.push("rationale");

    if (fieldErrors.length > 0) {
      errors.push(`${loc}: missing/invalid fields: ${fieldErrors.join(", ")}`);
      continue;
    }

    const id = String(deltaId).trim();
    if (byId.has(id)) {
      errors.push(`${loc}: duplicate delta_id '${id}'`);
      continue;
    }

    const record: BehavioralDeltaRecord = {
      delta_id: id,
      parent_requirement_ids: parentIds,
      change_kind: changeKind as BehavioralDeltaChangeKind,
      summary: String(summary).trim(),
      before: String(before).trim(),
      after: String(after).trim(),
      rationale: String(rationale).trim(),
    };
    deltas.push(record);
    byId.set(id, record);
  }

  return { deltas, errors, byId };
}

/**
 * Validate coverage map against parent requirements and optional story ids.
 * When the parent authors zero requirement IDs, validation is a no-op success
 * (backward compatible with pre-#3238 drafts).
 */
export function validateCoverageMap(opts: {
  parent: unknown;
  draft: unknown;
  storyIds?: readonly string[];
}): CoverageValidationResult {
  const requirements = extractParentRequirements(opts.parent);
  const parentIds = requirements.map((r) => r.id);
  const negativeIds = requirements.filter((r) => r.negativeInvariant).map((r) => r.id);
  const reqById = new Map(requirements.map((r) => [r.id, r]));

  const draft = asRecord(opts.draft) ?? {};
  const parseErrors: string[] = [];

  const { entries, errors: mapErrors } = parseCoverageMap(draft.coverage_map ?? draft.coverageMap);
  parseErrors.push(...mapErrors);

  const { byId: deltasById, errors: deltaErrors } = parseBehavioralDeltas(
    draft.behavioral_deltas ?? draft.behavioralDeltas,
  );
  parseErrors.push(...deltaErrors);

  const entryReports: CoverageEntryReport[] = [];
  const errors: string[] = [...parseErrors];
  const coveredIds = new Set<string>();

  // split_group → parent_id → set of parts
  const splitParts = new Map<string, Map<string, Set<string>>>();

  if (parentIds.length === 0) {
    const report: CoverageReport = {
      schema: "deft.decompose.coverage_report.v1",
      ok: parseErrors.length === 0,
      parent_requirement_ids: [],
      negative_invariant_ids: [],
      entries: [],
      uncovered: [],
      errors: parseErrors,
    };
    return { ok: report.ok, report, errors: parseErrors };
  }

  if (entries.length === 0 && parseErrors.length === 0) {
    errors.push(
      "coverage_map is required when the parent authors requirement IDs; " +
        `uncovered: ${parentIds.join(", ")}`,
    );
  }

  const knownStories = opts.storyIds !== undefined ? new Set(opts.storyIds) : null;

  for (const entry of entries) {
    const req = reqById.get(entry.parent_requirement_id);
    const isNeg = req?.negativeInvariant === true;
    const loc = `coverage_map[${entry.parent_requirement_id}]`;

    if (req === undefined) {
      const detail = `unknown parent_requirement_id '${entry.parent_requirement_id}' (not authored on parent)`;
      errors.push(`${loc}: ${detail}`);
      entryReports.push({
        parent_requirement_id: entry.parent_requirement_id,
        disposition: entry.disposition,
        ok: false,
        detail,
        negative_invariant: false,
      });
      continue;
    }

    coveredIds.add(entry.parent_requirement_id);

    if (entry.child_story_ids !== undefined && knownStories !== null) {
      for (const sid of entry.child_story_ids) {
        if (!knownStories.has(sid)) {
          errors.push(`${loc}: child_story_ids references unknown story '${sid}'`);
        }
      }
    }

    // deferred.target_story_id may name a future story outside this draft; do not
    // require membership in storyIds (target_path alone is also valid provenance).

    if (entry.disposition === "split") {
      const group = entry.split_group ?? "";
      const part = entry.part ?? "";
      let byParent = splitParts.get(group);
      if (byParent === undefined) {
        byParent = new Map();
        splitParts.set(group, byParent);
      }
      let parts = byParent.get(entry.parent_requirement_id);
      if (parts === undefined) {
        parts = new Set();
        byParent.set(entry.parent_requirement_id, parts);
      }
      parts.add(part);
    }

    if (entry.disposition === "behavioral_delta") {
      const deltaId = entry.delta_id;
      if (!isNonEmptyString(deltaId)) {
        // Already reported at parse time; keep entry report.
        entryReports.push({
          parent_requirement_id: entry.parent_requirement_id,
          disposition: entry.disposition,
          ok: false,
          detail: "missing delta_id",
          negative_invariant: isNeg,
        });
        continue;
      }
      const delta = deltasById.get(deltaId);
      if (delta === undefined) {
        const detail =
          `behavioral_delta delta_id '${deltaId}' has no linked record in behavioral_deltas ` +
          `(separate approval hook)`;
        errors.push(`${loc}: ${detail}`);
        entryReports.push({
          parent_requirement_id: entry.parent_requirement_id,
          disposition: entry.disposition,
          ok: false,
          detail,
          negative_invariant: isNeg,
        });
        continue;
      }
      if (!delta.parent_requirement_ids.includes(entry.parent_requirement_id)) {
        const detail =
          `behavioral_delta '${deltaId}' does not list parent_requirement_id ` +
          `'${entry.parent_requirement_id}'`;
        errors.push(`${loc}: ${detail}`);
        entryReports.push({
          parent_requirement_id: entry.parent_requirement_id,
          disposition: entry.disposition,
          ok: false,
          detail,
          negative_invariant: isNeg,
        });
        continue;
      }
    }

    entryReports.push({
      parent_requirement_id: entry.parent_requirement_id,
      disposition: entry.disposition,
      ok: true,
      detail: `disposition=${entry.disposition}`,
      negative_invariant: isNeg,
    });
  }

  // Incomplete split groups: each parent_id under a split_group needs ≥2 distinct parts.
  for (const [group, byParent] of splitParts) {
    for (const [parentId, parts] of byParent) {
      if (parts.size < 2) {
        errors.push(
          `coverage_map split_group '${group}' for '${parentId}' is incomplete ` +
            `(need ≥2 distinct parts; got ${parts.size}: ${[...parts].join(", ") || "(none)"})`,
        );
      }
    }
  }

  const uncovered = parentIds.filter((id) => !coveredIds.has(id));
  if (uncovered.length > 0) {
    errors.push(`uncovered parent requirement IDs: ${uncovered.join(", ")}`);
    for (const id of uncovered) {
      const req = reqById.get(id);
      const isNeg = req?.negativeInvariant === true;
      if (isNeg) {
        errors.push(
          `negative invariant '${id}' omitted without coverage or behavioral_delta ` +
            `(silent removal is forbidden)`,
        );
      }
      entryReports.push({
        parent_requirement_id: id,
        disposition: null,
        ok: false,
        detail: isNeg ? "negative invariant uncovered (silent removal)" : "uncovered",
        negative_invariant: isNeg,
      });
    }
  }

  const report: CoverageReport = {
    schema: "deft.decompose.coverage_report.v1",
    ok: errors.length === 0,
    parent_requirement_ids: parentIds,
    negative_invariant_ids: negativeIds,
    entries: entryReports,
    uncovered,
    errors,
  };

  return { ok: report.ok, report, errors };
}

/** Format a single-line machine-readable coverage report for CLI stdout. */
export function formatCoverageReportLine(report: CoverageReport): string {
  return `COVERAGE_REPORT ${JSON.stringify(report)}`;
}
