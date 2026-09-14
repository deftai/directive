import { describe, expect, it } from "vitest";
import {
  buildPainCoverageDeposit,
  evaluateParentAudit,
  extractOperativeAuditTargets,
  formatAuditToken,
  type ParentAuditDeposit,
  painMarkerId,
  parseAuditToken,
} from "./parent-audit.js";

const TOKEN = formatAuditToken({
  markerId: "c9",
  sha: "8bb1e528",
  pointer: "content/contracts/design-critique.md:38-45",
  reading: "asserted",
});

function okDeposit(overrides: Partial<ParentAuditDeposit> = {}): ParentAuditDeposit {
  return {
    premises: [
      {
        markerId: "c9",
        sha: "8bb1e528",
        pointer: "content/contracts/design-critique.md:38-45",
        reading: "asserted",
        introducedByRole: "parent",
        loadBearing: true,
      },
    ],
    clearances: [{ markerId: "c9", clearedByRole: "critic", targetsMarker: true }],
    envelopes: [{ auditTargets: ["c9"], declaredNone: false }],
    namedAuditTargets: ["c9"],
    bindAttempt: { allAcceptMap: true, unresolvedMarkerIds: [] },
    ...overrides,
  };
}

describe("design-critique parent-side substantiation (#3651)", () => {
  it("parses the token grammar", () => {
    expect(parseAuditToken(TOKEN)).toEqual({
      markerId: "c9",
      sha: "8bb1e528",
      pointer: "content/contracts/design-critique.md:38-45",
      reading: "asserted",
    });
    expect(parseAuditToken("audit:c9 missing-fields")).toBeNull();
  });

  it("passes a critic-cleared load-bearing premise", () => {
    const result = evaluateParentAudit(okDeposit());
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("clears a marker from critic targeting with no verdict field (#4442)", () => {
    const clearance = okDeposit().clearances[0];
    expect(Object.keys(clearance).sort()).toEqual(["clearedByRole", "markerId", "targetsMarker"]);
    expect(clearance).not.toHaveProperty("verdict");
    const result = evaluateParentAudit(okDeposit());
    expect(result.ok).toBe(true);
  });

  it("fails closed on a missing token", () => {
    const result = evaluateParentAudit(
      okDeposit({
        premises: [
          {
            markerId: "c9",
            introducedByRole: "parent",
            loadBearing: true,
          },
        ],
        bindAttempt: { allAcceptMap: false, unresolvedMarkerIds: ["c9"] },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.code === "missing-token")).toBe(true);
  });

  it("fails closed when a parent clears its own marker", () => {
    const result = evaluateParentAudit(
      okDeposit({
        clearances: [{ markerId: "c9", clearedByRole: "parent", targetsMarker: true }],
        bindAttempt: { allAcceptMap: false, unresolvedMarkerIds: ["c9"] },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.code === "parent-self-clear")).toBe(true);
  });

  it("fails closed when a marker is silently cleared", () => {
    const result = evaluateParentAudit(
      okDeposit({
        clearances: [],
        bindAttempt: { allAcceptMap: false, unresolvedMarkerIds: [] },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.code === "silent-clear")).toBe(true);
  });

  it("fails closed on all-accept bind with unresolved markers", () => {
    const result = evaluateParentAudit(
      okDeposit({
        clearances: [],
        bindAttempt: { allAcceptMap: true, unresolvedMarkerIds: ["c9"] },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.code === "bind-unresolved")).toBe(true);
  });

  it("fails closed when the envelope omits a named audit target", () => {
    const result = evaluateParentAudit(
      okDeposit({
        envelopes: [{ auditTargets: [], declaredNone: true }],
        bindAttempt: { allAcceptMap: false, unresolvedMarkerIds: ["c9"] },
        clearances: [],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.code === "envelope-omits-target")).toBe(true);
  });

  it("does not let one critic clearance launder a second unaudited premise", () => {
    const result = evaluateParentAudit({
      premises: [
        {
          markerId: "a",
          sha: "8bb1e528",
          pointer: "comment:1",
          reading: "measured",
          introducedByRole: "parent",
          loadBearing: true,
        },
        {
          markerId: "b",
          sha: "8bb1e528",
          pointer: "comment:2",
          reading: "asserted",
          introducedByRole: "parent",
          loadBearing: true,
        },
      ],
      clearances: [{ markerId: "a", clearedByRole: "critic", targetsMarker: true }],
      envelopes: [{ auditTargets: ["a", "b"], declaredNone: false }],
      namedAuditTargets: ["a", "b"],
      bindAttempt: { allAcceptMap: true, unresolvedMarkerIds: ["b"] },
    });
    expect(result.ok).toBe(false);
    expect(
      result.failures.some((f) => f.code === "bind-unresolved" && f.detail.includes("b")),
    ).toBe(true);
  });

  it("fails closed when bind declares unresolved markers that computed missed", () => {
    const result = evaluateParentAudit(
      okDeposit({
        bindAttempt: { allAcceptMap: true, unresolvedMarkerIds: ["ghost"] },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.code === "bind-unresolved")).toBe(true);
  });

  it("fails closed when sha or pointer fail the token grammar", () => {
    const result = evaluateParentAudit(
      okDeposit({
        premises: [
          {
            markerId: "c9",
            sha: "not-a-sha",
            pointer: "content/contracts/design-critique.md:38-45",
            reading: "asserted",
            introducedByRole: "parent",
            loadBearing: true,
          },
        ],
        bindAttempt: { allAcceptMap: false, unresolvedMarkerIds: ["c9"] },
        clearances: [],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.code === "missing-token")).toBe(true);
  });

  it("fails closed when two load-bearing premises share one marker id", () => {
    const result = evaluateParentAudit({
      premises: [
        {
          markerId: "c9",
          sha: "8bb1e528",
          pointer: "comment:1",
          reading: "measured",
          introducedByRole: "parent",
          loadBearing: true,
        },
        {
          markerId: "c9",
          sha: "8bb1e528",
          pointer: "comment:2",
          reading: "asserted",
          introducedByRole: "parent",
          loadBearing: true,
        },
      ],
      clearances: [{ markerId: "c9", clearedByRole: "critic", targetsMarker: true }],
      envelopes: [{ auditTargets: ["c9"], declaredNone: false }],
      namedAuditTargets: ["c9"],
      bindAttempt: { allAcceptMap: true, unresolvedMarkerIds: [] },
    });
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.code === "marker-collision")).toBe(true);
    expect(result.failures.some((f) => f.code === "bind-unresolved")).toBe(true);
  });
});

describe("pain-coverage parent audit (#4496)", () => {
  it("parses an operative audit-targets field and ignores a quoted copy", () => {
    expect(extractOperativeAuditTargets("role: critic\naudit-targets: pain-P1\n")).toEqual({
      auditTargets: ["pain-P1"],
      declaredNone: false,
    });
    expect(extractOperativeAuditTargets("> audit-targets: pain-P1\n")).toBeNull();
  });

  it("keeps operator-deferred unresolved until a critic targets it", () => {
    const unresolved = evaluateParentAudit(
      buildPainCoverageDeposit({
        leanCommentId: 5654755223,
        deferredPainIds: ["P1"],
        criticEnvelopes: [],
      }),
    );
    expect(unresolved.ok).toBe(false);
    expect(unresolved.failures.some((row) => row.code === "bind-unresolved")).toBe(true);
    expect(painMarkerId("P1")).toBe("pain-P1");

    const cleared = evaluateParentAudit(
      buildPainCoverageDeposit({
        leanCommentId: 5654755223,
        deferredPainIds: ["P1"],
        criticEnvelopes: [{ auditTargets: ["pain-P1"], declaredNone: false }],
      }),
    );
    expect(cleared.ok).toBe(true);
  });

  it("fails closed when a parent clears a deferred pain marker", () => {
    const result = evaluateParentAudit(
      buildPainCoverageDeposit({
        leanCommentId: 5654755223,
        deferredPainIds: ["P1"],
        criticEnvelopes: [{ auditTargets: ["pain-P1"], declaredNone: false }],
        parentClearedMarkerIds: ["pain-P1"],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.failures.some((row) => row.code === "parent-self-clear")).toBe(true);
  });
});
