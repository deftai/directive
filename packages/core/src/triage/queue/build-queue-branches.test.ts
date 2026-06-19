import { describe, expect, it } from "vitest";
import { buildQueue, latestDecisionsByIssue } from "./build-queue.js";
import type { AuditEntry, CachedIssue } from "./types.js";

const REPO = "owner/repo";

function issue(n: number, overrides: Partial<CachedIssue> = {}): CachedIssue {
  return {
    number: n,
    title: overrides.title ?? `Issue ${n}`,
    state: overrides.state ?? "open",
    labels: overrides.labels ?? [],
    updatedAt: overrides.updatedAt ?? "2026-05-17T20:00:00Z",
    createdAt: overrides.createdAt ?? "",
    metadataRank: overrides.metadataRank ?? null,
    continuation: overrides.continuation ?? false,
    continuationOrder: overrides.continuationOrder ?? "",
    bucketDeficit: overrides.bucketDeficit ?? null,
    blocked: overrides.blocked ?? false,
  };
}

function audit(n: number, decision: string, timestamp: string): AuditEntry {
  return {
    decision_id: "id",
    timestamp,
    repo: REPO,
    issue_number: n,
    decision,
    actor: "tester",
  };
}

describe("latestDecisionsByIssue branches", () => {
  it("skips entries without numeric issue_number", () => {
    const map = latestDecisionsByIssue([
      { ...audit(1, "defer", "t2"), issue_number: undefined as unknown as number },
      audit(2, "accept", "t1"),
    ]);
    expect(map.size).toBe(1);
    expect(map.get(2)?.decision).toBe("accept");
  });

  it("keeps latest timestamp per issue", () => {
    const map = latestDecisionsByIssue([
      audit(3, "defer", "2026-05-01T00:00:00Z"),
      audit(3, "accept", "2026-05-02T00:00:00Z"),
    ]);
    expect(map.get(3)?.decision).toBe("accept");
  });
});

describe("buildQueue branches", () => {
  it("drops net-new issues when finishBeforeStart and wipAtCap", () => {
    const items = buildQueue([issue(1), issue(2, { continuation: true })], [], {
      repo: REPO,
      queue: {
        finishBeforeStart: true,
        wipAtCap: true,
        continuationNumbers: new Set([2]),
      },
    });
    expect(items.map((row) => row.number)).toEqual([2]);
  });

  it("routes blocked issues to BLOCKED bucket unless includeBlocked", () => {
    const blockedOnly = buildQueue([issue(5, { blocked: true })], [], {
      repo: REPO,
      queue: { blockedIssueNumbers: new Set([5]) },
    });
    expect(blockedOnly[0]?.group).toBe("BLOCKED");

    const included = buildQueue([issue(5, { blocked: true })], [], {
      repo: REPO,
      queue: { blockedIssueNumbers: new Set([5]), includeBlocked: true },
    });
    expect(included[0]?.group).not.toBe("BLOCKED");
  });

  it("routes orphan issues to ORPHAN bucket", () => {
    const items = buildQueue([issue(7)], [], {
      repo: REPO,
      queue: { orphanIssueNumbers: new Set([7]) },
    });
    expect(items[0]?.group).toBe("ORPHAN");
  });

  it("respects queue limit and resolves rank from maps", () => {
    const items = buildQueue(
      [issue(1, { metadataRank: 9 }), issue(2), issue(3)],
      [audit(1, "defer", "t1")],
      {
        repo: REPO,
        queue: {
          limit: 2,
          rankByNumber: new Map([[2, 1]]),
          deficitByNumber: new Map([[2, 3]]),
          continuationOrderByNumber: new Map([[2, "b"]]),
          rankingLabels: ["urgent"],
        },
      },
    );
    expect(items).toHaveLength(2);
  });

  it("skips issues without numeric number field", () => {
    const bad = { ...issue(1), number: undefined as unknown as number };
    expect(buildQueue([bad], [], { repo: REPO })).toEqual([]);
  });
});
