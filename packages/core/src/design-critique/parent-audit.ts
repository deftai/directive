/** Parent-side substantiation deposit + fail-closed evaluator (#3651 / ADR-006). */

import { classifyPosition } from "./citation-grammar.js";

export type AuditReading = "measured" | "asserted";
export type AuditRole = "parent" | "critic" | "triage";

export type AuditPremise = {
  markerId: string;
  sha?: string;
  pointer?: string;
  reading?: AuditReading;
  introducedByRole: AuditRole;
  /** Changes classification, residual, or next-build contract. */
  loadBearing: boolean;
};

export type AuditClearance = {
  markerId: string;
  clearedByRole: AuditRole;
  /** Critic artifact names this marker as its audit target. */
  targetsMarker: boolean;
};

export type AuditEnvelope = {
  /** Marker ids listed on `audit-targets:`. Empty means the field was omitted. */
  auditTargets: string[];
  /** Envelope explicitly set `audit-targets: none`. */
  declaredNone: boolean;
};

export type AuditBindAttempt = {
  allAcceptMap: boolean;
  /** Marker ids the bind record still lists as unresolved. */
  unresolvedMarkerIds: string[];
};

export type ParentAuditDeposit = {
  premises: readonly AuditPremise[];
  clearances: readonly AuditClearance[];
  envelopes: readonly AuditEnvelope[];
  /** Ids the next critic envelope must name. */
  namedAuditTargets?: readonly string[];
  bindAttempt?: AuditBindAttempt;
};

export type AuditFailureCode =
  | "missing-token"
  | "parent-self-clear"
  | "silent-clear"
  | "bind-unresolved"
  | "envelope-omits-target"
  | "marker-collision";

export type AuditFailure = {
  code: AuditFailureCode;
  detail: string;
};

const TOKEN_RE =
  /^audit:([A-Za-z0-9._-]+) sha=([0-9a-fA-F]{7,40}) pointer=(\S+) reading=(measured|asserted)$/;

export function parseAuditToken(token: string): {
  markerId: string;
  sha: string;
  pointer: string;
  reading: AuditReading;
} | null {
  const match = TOKEN_RE.exec(token.trim());
  if (!match) return null;
  return {
    markerId: match[1] ?? "",
    sha: match[2] ?? "",
    pointer: match[3] ?? "",
    reading: (match[4] ?? "asserted") as AuditReading,
  };
}

export function formatAuditToken(parts: {
  markerId: string;
  sha: string;
  pointer: string;
  reading: AuditReading;
}): string {
  return `audit:${parts.markerId} sha=${parts.sha} pointer=${parts.pointer} reading=${parts.reading}`;
}

function independentlyCleared(
  markerId: string,
  clearances: readonly AuditClearance[],
  colliding: ReadonlySet<string>,
): boolean {
  if (colliding.has(markerId)) return false;
  return clearances.some(
    (c) => c.markerId === markerId && c.clearedByRole === "critic" && c.targetsMarker,
  );
}

function collidingMarkerIds(premises: readonly AuditPremise[]): Set<string> {
  const counts = new Map<string, number>();
  for (const premise of premises) {
    if (!premise.loadBearing) continue;
    counts.set(premise.markerId, (counts.get(premise.markerId) ?? 0) + 1);
  }
  return new Set([...counts.entries()].filter(([, n]) => n > 1).map(([id]) => id));
}

export function evaluateParentAudit(deposit: ParentAuditDeposit): {
  ok: boolean;
  failures: AuditFailure[];
} {
  const failures: AuditFailure[] = [];
  const colliding = collidingMarkerIds(deposit.premises);
  for (const id of colliding) {
    failures.push({
      code: "marker-collision",
      detail: `load-bearing premises share marker ${id}`,
    });
  }

  for (const premise of deposit.premises) {
    if (!premise.loadBearing) continue;
    if (!premise.sha || !premise.pointer || !premise.reading) {
      failures.push({
        code: "missing-token",
        detail: `premise ${premise.markerId} is missing sha, pointer, or reading`,
      });
      continue;
    }
    const token = formatAuditToken({
      markerId: premise.markerId,
      sha: premise.sha,
      pointer: premise.pointer,
      reading: premise.reading,
    });
    if (!parseAuditToken(token)) {
      failures.push({
        code: "missing-token",
        detail: `premise ${premise.markerId} token failed grammar`,
      });
    }
  }

  for (const clearance of deposit.clearances) {
    if (clearance.clearedByRole === "parent") {
      failures.push({
        code: "parent-self-clear",
        detail: `parent cleared marker ${clearance.markerId}`,
      });
    }
  }

  const computedUnresolved = deposit.premises
    .filter(
      (p) => p.loadBearing && !independentlyCleared(p.markerId, deposit.clearances, colliding),
    )
    .map((p) => p.markerId);

  const named = deposit.namedAuditTargets ?? [];
  if (named.length > 0) {
    if (deposit.envelopes.length === 0) {
      failures.push({
        code: "envelope-omits-target",
        detail: `no envelope named audit targets ${named.join(",")}`,
      });
    }
    for (const envelope of deposit.envelopes) {
      if (envelope.declaredNone) {
        failures.push({
          code: "envelope-omits-target",
          detail: "envelope declared none while named audit targets exist",
        });
        continue;
      }
      for (const id of named) {
        if (!envelope.auditTargets.includes(id)) {
          failures.push({
            code: "envelope-omits-target",
            detail: `envelope omitted audit target ${id}`,
          });
        }
      }
    }
  }

  const bind = deposit.bindAttempt;
  if (bind) {
    const declared = new Set(bind.unresolvedMarkerIds);
    for (const id of computedUnresolved) {
      if (!declared.has(id)) {
        failures.push({
          code: "silent-clear",
          detail: `marker ${id} dropped from unresolved without critic clearance`,
        });
      }
    }
    const unresolvedForBind = [...new Set([...computedUnresolved, ...bind.unresolvedMarkerIds])];
    if (bind.allAcceptMap && unresolvedForBind.length > 0) {
      failures.push({
        code: "bind-unresolved",
        detail: `all-accept bind with unresolved markers ${unresolvedForBind.join(",")}`,
      });
    }
  }

  return { ok: failures.length === 0, failures };
}

export function painMarkerId(painId: string): string {
  return `pain-${painId}`;
}

const AUDIT_TARGETS_RE = /(?:^|\n)[ \t]*audit-targets:[ \t]*([^\n]*)/gi;

/** Latest operative `audit-targets:` field, or null when none is operative. */
export function extractOperativeAuditTargets(body: string): AuditEnvelope | null {
  const re = new RegExp(AUDIT_TARGETS_RE.source, "gi");
  let last: AuditEnvelope | null = null;
  for (const match of body.matchAll(re)) {
    const offset = match.index ?? 0;
    const inner = match[0].search(/audit-targets:/i);
    const tokenOffset = offset + (inner >= 0 ? inner : 0);
    if (classifyPosition(body, tokenOffset) !== null) continue;
    const raw = (match[1] ?? "").trim();
    if (/^none$/i.test(raw)) {
      last = { auditTargets: [], declaredNone: true };
      continue;
    }
    const auditTargets = raw.split(/[, \t]+/).filter((part) => part.length > 0);
    last = { auditTargets, declaredNone: false };
  }
  return last;
}

function leanSha(leanCommentId: number): string {
  const hex = leanCommentId.toString(16);
  return hex.length >= 7 ? hex.slice(0, 40) : hex.padStart(7, "0");
}

/**
 * Deferred pain cites are unresolved ADR-006 markers until a critic targets them.
 * Relief cites are asserted premises for a later critic; they are not this bind.
 */
export function buildPainCoverageDeposit(input: {
  readonly leanCommentId: number;
  readonly deferredPainIds: readonly string[];
  readonly criticEnvelopes: readonly AuditEnvelope[];
  readonly parentClearedMarkerIds?: readonly string[];
}): ParentAuditDeposit {
  const premises: AuditPremise[] = input.deferredPainIds.map((painId) => ({
    markerId: painMarkerId(painId),
    sha: leanSha(input.leanCommentId),
    pointer: `lean:${input.leanCommentId}`,
    reading: "asserted",
    introducedByRole: "parent",
    loadBearing: true,
  }));
  const named = premises.map((row) => row.markerId);
  const clearances: AuditClearance[] = [];
  for (const envelope of input.criticEnvelopes) {
    for (const id of envelope.auditTargets) {
      if (named.includes(id)) {
        clearances.push({ markerId: id, clearedByRole: "critic", targetsMarker: true });
      }
    }
  }
  for (const id of input.parentClearedMarkerIds ?? []) {
    clearances.push({ markerId: id, clearedByRole: "parent", targetsMarker: true });
  }
  const independentlyClearedIds = new Set(
    clearances
      .filter((row) => row.clearedByRole === "critic" && row.targetsMarker)
      .map((row) => row.markerId),
  );
  const unresolved = named.filter((id) => !independentlyClearedIds.has(id));
  return {
    premises,
    clearances,
    envelopes: input.criticEnvelopes,
    namedAuditTargets: named,
    bindAttempt: { allAcceptMap: true, unresolvedMarkerIds: unresolved },
  };
}

export const CLOSED_FINDING_DISPOSITIONS = [
  "accepted",
  "deferred",
  "skipped",
  "fixed-in-body",
] as const;

export type ClosedFindingDisposition = (typeof CLOSED_FINDING_DISPOSITIONS)[number];

export type ClosedFindingEntry = {
  readonly sourceCommentId: number;
  readonly findingId: string;
  /** Display-only; never a match key. */
  readonly title?: string;
  readonly disposition: ClosedFindingDisposition;
};

export type ClosedFindingCompositeId = {
  readonly sourceCommentId: number;
  readonly findingId: string;
};

export type ClosureAuthority =
  | { readonly kind: "completed-successor-take" }
  | { readonly kind: "explicit-operator-closure" }
  | { readonly kind: "none" };

export type ClosedFindingClass = "blocks-the-design" | "sharpens-framing" | "footnote";

export type PostedCriticFinding = {
  readonly localId: string;
  readonly classification: ClosedFindingClass;
  readonly restates: ClosedFindingCompositeId | null;
  readonly evidenceBearingReopen: boolean;
};

export type UnifiedFinding = {
  readonly localId: string;
  readonly classification: ClosedFindingClass;
  readonly restates: ClosedFindingCompositeId | null;
  readonly demoted: boolean;
  readonly residual: boolean;
  readonly take: "disposition-carrying" | "footnote" | "omit-not-residual";
  readonly adr006EquivalenceAsserted: boolean;
};

export type ClosedFindingsUnifyResult = {
  readonly ok: boolean;
  readonly findings: readonly UnifiedFinding[];
  readonly censusLocalIds: readonly string[];
  readonly failures: readonly { code: string; detail: string }[];
};

export type ClosedFindingsResidualRefuse = {
  readonly refuse: boolean;
  readonly code: "authorized-unchanged-restatement" | null;
  readonly detail: string | null;
};

const CLOSED_FINDINGS_LINE_RE = /(?:^|\n)[ \t]*closed-findings:[ \t]*([^\n]*)/gi;
// End-of-token after disposition so accepted-pending is not accepted.
const CLOSED_FINDING_ENTRY_RE =
  /(\d{8,})\s*\/\s*([A-Za-z0-9._-]+)\s+(accepted|deferred|skipped|fixed-in-body)(?![A-Za-z0-9_-])(?:\s+"([^"]*)")?/gi;
// End-of-token lookahead (not \b): trailing -/. are valid findingId chars and
// would otherwise backtrack off the complete token before a word boundary.
const RESTATES_RE =
  /(?:^|\n)[ \t]*restates:[ \t]*(\d{8,})\s*\/\s*([A-Za-z0-9._-]+)(?![A-Za-z0-9._-])/gi;

export function closedFindingCompositeKey(id: ClosedFindingCompositeId): string {
  return `${id.sourceCommentId}/${id.findingId}`;
}

export function parseRestatesRelation(body: string): ClosedFindingCompositeId | null {
  const re = new RegExp(RESTATES_RE.source, "gi");
  let last: ClosedFindingCompositeId | null = null;
  for (const match of body.matchAll(re)) {
    const offset = match.index ?? 0;
    const inner = match[0].search(/restates:/i);
    const tokenOffset = offset + (inner >= 0 ? inner : 0);
    if (classifyPosition(body, tokenOffset) !== null) continue;
    const sourceCommentId = Number(match[1]);
    const findingId = match[2] ?? "";
    if (!Number.isSafeInteger(sourceCommentId) || sourceCommentId <= 0 || findingId.length === 0) {
      continue;
    }
    last = { sourceCommentId, findingId };
  }
  return last;
}

function parseClosedFindingEntriesFromSlice(slice: string): ClosedFindingEntry[] {
  const entries: ClosedFindingEntry[] = [];
  const seen = new Set<string>();
  const re = new RegExp(CLOSED_FINDING_ENTRY_RE.source, "gi");
  for (const match of slice.matchAll(re)) {
    const sourceCommentId = Number(match[1]);
    const findingId = match[2] ?? "";
    const disposition = (match[3] ?? "").toLowerCase() as ClosedFindingDisposition;
    const title = match[4];
    if (!Number.isSafeInteger(sourceCommentId) || sourceCommentId <= 0 || findingId.length === 0) {
      continue;
    }
    if (!CLOSED_FINDING_DISPOSITIONS.includes(disposition)) continue;
    const key = closedFindingCompositeKey({ sourceCommentId, findingId });
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      sourceCommentId,
      findingId,
      disposition,
      ...(title !== undefined && title.length > 0 ? { title } : {}),
    });
  }
  return entries;
}

export function extractOperativeClosedFindings(body: string): ClosedFindingEntry[] {
  const re = new RegExp(CLOSED_FINDINGS_LINE_RE.source, "gi");
  let lastSlice: string | null = null;
  for (const match of body.matchAll(re)) {
    const offset = match.index ?? 0;
    const inner = match[0].search(/closed-findings:/i);
    const tokenOffset = offset + (inner >= 0 ? inner : 0);
    if (classifyPosition(body, tokenOffset) !== null) continue;
    const inline = (match[1] ?? "").trim();
    const afterLineStart = (match.index ?? 0) + match[0].length;
    const rest = body.slice(afterLineStart);
    const lines: string[] = [];
    if (inline.length > 0) lines.push(inline);
    let sawBullet = false;
    for (const line of rest.split(/\r?\n/)) {
      if (/^\s*$/.test(line)) {
        if (inline.length > 0 || sawBullet) break;
        continue;
      }
      if (/^\s*#{1,6}\s/.test(line)) break;
      if (/^\s*[A-Za-z][\w-]*:\s*/.test(line) && !/^\s*[-*+]/.test(line)) break;
      if (/^\s*[-*+]\s+/.test(line)) {
        sawBullet = true;
        lines.push(line.replace(/^\s*[-*+]\s+/, "").trim());
        continue;
      }
      if (inline.length === 0 && !sawBullet) {
        // Non-bullet continuation after a bare field is not a closed-findings list.
        break;
      }
      break;
    }
    lastSlice = lines.join("\n");
  }
  if (lastSlice === null) return [];
  return parseClosedFindingEntriesFromSlice(lastSlice);
}

export function freezeClosedFindingsForDispatch(
  entries: readonly ClosedFindingEntry[],
): readonly ClosedFindingEntry[] {
  return entries.map((row) => ({
    sourceCommentId: row.sourceCommentId,
    findingId: row.findingId,
    disposition: row.disposition,
    ...(row.title !== undefined ? { title: row.title } : {}),
  }));
}

export function formatClosedFindingsField(entries: readonly ClosedFindingEntry[]): string {
  if (entries.length === 0) return "closed-findings:";
  const parts = entries.map((row) => {
    const base = `${row.sourceCommentId}/${row.findingId} ${row.disposition}`;
    return row.title !== undefined && row.title.length > 0 ? `${base} "${row.title}"` : base;
  });
  return `closed-findings: ${parts.join(", ")}`;
}

export function isClosedFindingSuppressionEligible(
  entry: ClosedFindingEntry,
  authority: ClosureAuthority,
): boolean {
  if (authority.kind === "none") return false;
  if (authority.kind === "explicit-operator-closure") return true;
  return entry.disposition !== "deferred";
}

export function authorizedClosedFindingMap(
  entries: readonly ClosedFindingEntry[],
  authorityByKey: ReadonlyMap<string, ClosureAuthority>,
): Map<string, ClosedFindingEntry> {
  const out = new Map<string, ClosedFindingEntry>();
  for (const entry of entries) {
    const key = closedFindingCompositeKey(entry);
    const authority = authorityByKey.get(key) ?? { kind: "none" };
    if (!isClosedFindingSuppressionEligible(entry, authority)) continue;
    out.set(key, entry);
  }
  return out;
}

export function evaluateClosedFindingsUnify(input: {
  readonly authorizedClosed: ReadonlyMap<string, ClosedFindingEntry>;
  readonly posted: readonly PostedCriticFinding[];
}): ClosedFindingsUnifyResult {
  const failures: { code: string; detail: string }[] = [];
  const findings: UnifiedFinding[] = [];
  const censusLocalIds: string[] = [];

  for (const posted of input.posted) {
    censusLocalIds.push(posted.localId);
    const restates = posted.restates;
    const key = restates ? closedFindingCompositeKey(restates) : null;
    const authorized = key !== null ? input.authorizedClosed.get(key) : undefined;
    const demote =
      authorized !== undefined &&
      restates !== null &&
      posted.evidenceBearingReopen === false &&
      (posted.classification === "blocks-the-design" ||
        posted.classification === "sharpens-framing");

    if (demote) {
      findings.push({
        localId: posted.localId,
        classification: "footnote",
        restates,
        demoted: true,
        residual: false,
        take: "footnote",
        adr006EquivalenceAsserted: true,
      });
      continue;
    }

    const residual =
      posted.classification === "blocks-the-design" || posted.classification === "sharpens-framing";
    findings.push({
      localId: posted.localId,
      classification: posted.classification,
      restates,
      demoted: false,
      residual,
      take: residual ? "disposition-carrying" : "footnote",
      adr006EquivalenceAsserted: false,
    });
  }

  if (censusLocalIds.length !== input.posted.length) {
    failures.push({
      code: "silent-drop",
      detail: "posted critic heading missing from census",
    });
  }

  return {
    ok: failures.length === 0,
    findings,
    censusLocalIds,
    failures,
  };
}

export function evaluateClosedFindingsResidualRefuse(input: {
  readonly authorizedClosed: ReadonlyMap<string, ClosedFindingEntry>;
  readonly residual: readonly PostedCriticFinding[];
}): ClosedFindingsResidualRefuse {
  for (const row of input.residual) {
    if (row.classification === "footnote") continue;
    if (row.restates === null) continue;
    if (row.evidenceBearingReopen) continue;
    const key = closedFindingCompositeKey(row.restates);
    if (!input.authorizedClosed.has(key)) continue;
    return {
      refuse: true,
      code: "authorized-unchanged-restatement",
      detail: `residual ${row.localId} restates authorized closed ${key} without reopen evidence`,
    };
  }
  return { refuse: false, code: null, detail: null };
}
