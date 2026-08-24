import { describe, expect, it } from "vitest";
import {
  evaluateParentAudit,
  formatAuditToken,
  type ParentAuditDeposit,
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
});
