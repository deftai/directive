/** Parent-side substantiation deposit + fail-closed evaluator (#3651 / ADR-006). */

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
  | "envelope-omits-target";

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

function independentlyCleared(markerId: string, clearances: readonly AuditClearance[]): boolean {
  return clearances.some(
    (c) => c.markerId === markerId && c.clearedByRole === "critic" && c.targetsMarker,
  );
}

export function evaluateParentAudit(deposit: ParentAuditDeposit): {
  ok: boolean;
  failures: AuditFailure[];
} {
  const failures: AuditFailure[] = [];

  for (const premise of deposit.premises) {
    if (!premise.loadBearing) continue;
    if (!premise.sha || !premise.pointer || !premise.reading) {
      failures.push({
        code: "missing-token",
        detail: `premise ${premise.markerId} is missing sha, pointer, or reading`,
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
    .filter((p) => p.loadBearing && !independentlyCleared(p.markerId, deposit.clearances))
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
    if (bind.allAcceptMap && computedUnresolved.length > 0) {
      failures.push({
        code: "bind-unresolved",
        detail: `all-accept bind with unresolved markers ${computedUnresolved.join(",")}`,
      });
    }
  }

  return { ok: failures.length === 0, failures };
}
