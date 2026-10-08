import { describe, expect, it } from "vitest";
import {
  authorizedClosedFindingMap,
  buildPainCoverageDeposit,
  type ClosedFindingEntry,
  type ClosureAuthority,
  closedFindingCompositeKey,
  defaultFindingClassUnderMaterialityBar,
  evaluateClosedFindingsResidualRefuse,
  evaluateClosedFindingsUnify,
  evaluateParentAudit,
  extractOperativeAuditTargets,
  extractOperativeClosedFindings,
  formatAuditToken,
  formatClosedFindingsField,
  freezeClosedFindingsForDispatch,
  isClosedFindingSuppressionEligible,
  type ParentAuditDeposit,
  type PostedCriticFinding,
  painMarkerId,
  parseAuditToken,
  parseRestatesRelation,
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

  it("defaults unpromoted sharpens to footnote under ship-ready (#5488)", () => {
    expect(
      defaultFindingClassUnderMaterialityBar({
        materialityBar: "ship-ready",
        rawClass: "sharpens-framing",
      }),
    ).toBe("footnote");
    expect(
      defaultFindingClassUnderMaterialityBar({
        materialityBar: "ship-ready",
        rawClass: "sharpens-framing",
        operatorPromoted: true,
      }),
    ).toBe("sharpens-framing");
    expect(
      defaultFindingClassUnderMaterialityBar({
        materialityBar: "open",
        rawClass: "sharpens-framing",
      }),
    ).toBe("sharpens-framing");
    expect(
      defaultFindingClassUnderMaterialityBar({
        materialityBar: "ship-ready",
        rawClass: "blocks-the-design",
      }),
    ).toBe("blocks-the-design");
  });
});

const SRC = 6064586516;

function entry(
  findingId: string,
  disposition: ClosedFindingEntry["disposition"] = "accepted",
  title?: string,
): ClosedFindingEntry {
  return {
    sourceCommentId: SRC,
    findingId,
    disposition,
    ...(title !== undefined ? { title } : {}),
  };
}

function authMap(
  entries: readonly ClosedFindingEntry[],
  kind: ClosureAuthority["kind"] = "completed-successor-take",
): Map<string, ClosedFindingEntry> {
  const authority = new Map<string, ClosureAuthority>();
  for (const row of entries) {
    authority.set(closedFindingCompositeKey(row), { kind });
  }
  return authorizedClosedFindingMap(entries, authority);
}

describe("closed-findings later-arc demotion (#5489 Prefer-A Bound)", () => {
  it("parses operative closed-findings with composite identity; titles display-only", () => {
    const body =
      "model: x\nrole: parent\n\n" +
      `closed-findings: ${SRC}/C1 accepted "prior seam", ${SRC}/C2 deferred\n`;
    const rows = extractOperativeClosedFindings(body);
    expect(rows).toEqual([
      { sourceCommentId: SRC, findingId: "C1", disposition: "accepted", title: "prior seam" },
      { sourceCommentId: SRC, findingId: "C2", disposition: "deferred" },
    ]);
    expect(extractOperativeClosedFindings(`> closed-findings: ${SRC}/C1 accepted\n`)).toEqual([]);
    expect(extractOperativeClosedFindings(`closed-findings: ${SRC}/C1 accepted-pending\n`)).toEqual(
      [],
    );
  });

  it("parses bullet closed-findings under the field", () => {
    const body =
      "closed-findings:\n" +
      `- ${SRC}/C1 accepted\n` +
      `- ${SRC}/C2 fixed-in-body "edge"\n\n` +
      "pain: P1\n";
    expect(extractOperativeClosedFindings(body)).toEqual([
      { sourceCommentId: SRC, findingId: "C1", disposition: "accepted" },
      { sourceCommentId: SRC, findingId: "C2", disposition: "fixed-in-body", title: "edge" },
    ]);
  });

  it("freezes Round-1 dispatch snapshot and formats the field", () => {
    const frozen = freezeClosedFindingsForDispatch([entry("C1"), entry("C2", "skipped")]);
    expect(formatClosedFindingsField(frozen)).toBe(
      `closed-findings: ${SRC}/C1 accepted, ${SRC}/C2 skipped`,
    );
  });

  it("closure authority: bare defer and none are not suppression-eligible", () => {
    expect(
      isClosedFindingSuppressionEligible(entry("C1", "deferred"), {
        kind: "completed-successor-take",
      }),
    ).toBe(false);
    expect(isClosedFindingSuppressionEligible(entry("C1", "accepted"), { kind: "none" })).toBe(
      false,
    );
    expect(
      isClosedFindingSuppressionEligible(entry("C1", "deferred"), {
        kind: "explicit-operator-closure",
      }),
    ).toBe(true);
    expect(
      isClosedFindingSuppressionEligible(entry("C1", "accepted"), {
        kind: "completed-successor-take",
      }),
    ).toBe(true);
  });

  it("match key is composite + explicit restates; bare local id is not enough", () => {
    expect(parseRestatesRelation(`restates: ${SRC}/C1\n`)).toEqual({
      sourceCommentId: SRC,
      findingId: "C1",
    });
    expect(parseRestatesRelation(`restates: ${SRC}/C1-\n`)).toEqual({
      sourceCommentId: SRC,
      findingId: "C1-",
    });
    expect(parseRestatesRelation(`restates: ${SRC}/C1.\n`)).toEqual({
      sourceCommentId: SRC,
      findingId: "C1.",
    });
    expect(parseRestatesRelation("> restates: 6064586516/C1\n")).toBeNull();
    const authorized = authMap([entry("C1")]);
    const posted: PostedCriticFinding[] = [
      {
        localId: "C1",
        classification: "sharpens-framing",
        restates: null,
        evidenceBearingReopen: false,
      },
    ];
    const unified = evaluateClosedFindingsUnify({ authorizedClosed: authorized, posted });
    expect(unified.findings[0]?.demoted).toBe(false);
    expect(unified.findings[0]?.residual).toBe(true);
  });

  it("demotes authorized unchanged restatement via declared relation (fixture c)", () => {
    const authorized = authMap([entry("C1")]);
    const posted: PostedCriticFinding[] = [
      {
        localId: "C9",
        classification: "sharpens-framing",
        restates: { sourceCommentId: SRC, findingId: "C1" },
        evidenceBearingReopen: false,
      },
    ];
    const unified = evaluateClosedFindingsUnify({ authorizedClosed: authorized, posted });
    expect(unified.ok).toBe(true);
    expect(unified.censusLocalIds).toEqual(["C9"]);
    expect(unified.findings[0]).toMatchObject({
      demoted: true,
      residual: false,
      classification: "footnote",
      take: "footnote",
      adr006EquivalenceAsserted: true,
    });
  });

  it("renamed declared restatement still demotes (fixture e)", () => {
    const authorized = authMap([entry("C1", "accepted", "old title")]);
    const posted: PostedCriticFinding[] = [
      {
        localId: "C2",
        classification: "blocks-the-design",
        restates: { sourceCommentId: SRC, findingId: "C1" },
        evidenceBearingReopen: false,
      },
    ];
    const unified = evaluateClosedFindingsUnify({ authorizedClosed: authorized, posted });
    expect(unified.findings[0]?.demoted).toBe(true);
  });

  it("same local id / different source without declared relation is not auto-suppressed (fixture d)", () => {
    const authorized = authMap([entry("C1")]);
    const posted: PostedCriticFinding[] = [
      {
        localId: "C1",
        classification: "blocks-the-design",
        restates: { sourceCommentId: 6064755548, findingId: "C1" },
        evidenceBearingReopen: false,
      },
    ];
    const unified = evaluateClosedFindingsUnify({ authorizedClosed: authorized, posted });
    expect(unified.findings[0]?.demoted).toBe(false);
    expect(unified.findings[0]?.residual).toBe(true);
  });

  it("evidence-bearing reopen survives demotion and residual refuse (fixture b)", () => {
    const authorized = authMap([entry("C1")]);
    const posted: PostedCriticFinding[] = [
      {
        localId: "C1",
        classification: "blocks-the-design",
        restates: { sourceCommentId: SRC, findingId: "C1" },
        evidenceBearingReopen: true,
      },
    ];
    const unified = evaluateClosedFindingsUnify({ authorizedClosed: authorized, posted });
    expect(unified.findings[0]?.demoted).toBe(false);
    expect(unified.findings[0]?.residual).toBe(true);
    const refuse = evaluateClosedFindingsResidualRefuse({
      authorizedClosed: authorized,
      residual: posted,
    });
    expect(refuse.refuse).toBe(false);
  });

  it("intervening body edit new finding without restates stays open (fixture a)", () => {
    const authorized = authMap([entry("C1")]);
    const posted: PostedCriticFinding[] = [
      {
        localId: "C2",
        classification: "sharpens-framing",
        restates: null,
        evidenceBearingReopen: false,
      },
    ];
    const unified = evaluateClosedFindingsUnify({ authorizedClosed: authorized, posted });
    expect(unified.findings[0]?.demoted).toBe(false);
    expect(unified.findings[0]?.residual).toBe(true);
  });

  it("fixture-level refuse consumer rejects authorized unchanged restatement residual", () => {
    const authorized = authMap([entry("C1")]);
    const residual: PostedCriticFinding[] = [
      {
        localId: "C3",
        classification: "sharpens-framing",
        restates: { sourceCommentId: SRC, findingId: "C1" },
        evidenceBearingReopen: false,
      },
    ];
    const refuse = evaluateClosedFindingsResidualRefuse({
      authorizedClosed: authorized,
      residual,
    });
    expect(refuse).toEqual({
      refuse: true,
      code: "authorized-unchanged-restatement",
      detail: `residual C3 restates authorized closed ${SRC}/C1 without reopen evidence`,
    });
  });

  it("never silently drops posted headings from the census", () => {
    const authorized = authMap([entry("C1")]);
    const posted: PostedCriticFinding[] = [
      {
        localId: "A",
        classification: "footnote",
        restates: null,
        evidenceBearingReopen: false,
      },
      {
        localId: "B",
        classification: "sharpens-framing",
        restates: { sourceCommentId: SRC, findingId: "C1" },
        evidenceBearingReopen: false,
      },
    ];
    const unified = evaluateClosedFindingsUnify({ authorizedClosed: authorized, posted });
    expect(unified.censusLocalIds).toEqual(["A", "B"]);
    expect(unified.findings).toHaveLength(2);
  });
});
