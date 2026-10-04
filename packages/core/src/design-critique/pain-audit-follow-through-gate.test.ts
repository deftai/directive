/**
 * Colocated coverage for pain-audit-follow-through-gate (#5233 / #1310).
 * Integration fixtures also live in leftover-pain.test.ts.
 */
import { describe, expect, it } from "vitest";
import { isSuccessorLeanBody } from "./completed-arc-record.js";
import {
  evaluateAccumulatedPainAuditFollowThrough,
  evaluatePainAuditFollowThrough,
  extractOperativeFindingClasses,
  extractOperativeHarvestChanged,
  hashBoundRemedyBytes,
} from "./pain-audit-follow-through-gate.js";

describe("pain-audit-follow-through-gate (#5233)", () => {
  it("maps finding classes through evaluatePainAuditFollowThrough", () => {
    expect(
      evaluatePainAuditFollowThrough({
        findingClasses: ["blocking"],
        harvestChanged: false,
      }).postRetractionThenHandoff,
    ).toBe(true);
    expect(
      evaluatePainAuditFollowThrough({
        findingClasses: ["sharpening"],
        harvestChanged: true,
      }).newBindLeanAndAudit,
    ).toBe(true);
    expect(
      evaluatePainAuditFollowThrough({
        findingClasses: [],
        harvestChanged: false,
      }).bindableWithoutExtraLean,
    ).toBe(true);
  });

  it("parses carriers and hashes Bound-remedy identity", () => {
    expect(extractOperativeFindingClasses("finding-classes: none\n")).toMatchObject({
      ok: true,
      explicitEmpty: true,
    });
    expect(extractOperativeFindingClasses("finding-classes: \n")?.ok).toBe(false);
    expect(
      extractOperativeFindingClasses("finding-classes: blocking\nfinding-classes: none\n")?.ok,
    ).toBe(false);
    expect(extractOperativeHarvestChanged("harvest-changed: false\n")).toEqual({
      ok: true,
      harvestChanged: false,
    });
    const a = "**Lean:** x\n\n## Bound remedy\n\n1. one\n\nrelieves: P1\n";
    const b = "**Lean:** x\n\n## Bound remedy\n\n1. two\n\nrelieves: P1\n";
    const hyphen = "**Lean:** x\n\n## Bound-remedy\n\n1. one\n\nrelieves: P9\n";
    const checkbox = "**Lean:** x\n\n## Bound remedy\n\n- [ ] one\n\nrelieves: P1\n";
    expect(hashBoundRemedyBytes(a)).not.toBe(hashBoundRemedyBytes(b));
    expect(hashBoundRemedyBytes(a)).toBe(hashBoundRemedyBytes(hyphen));
    expect(hashBoundRemedyBytes(a)).toBe(hashBoundRemedyBytes(checkbox));
  });

  it("refuses missing carrier on a targeting audit for the cited harvest", () => {
    const lean = {
      id: 10,
      body: "**Lean:** bind.\n\n## Bound remedy\n\n1. harvest\n\nrelieves: P1\n",
    };
    const audit = {
      id: 11,
      body: "role: critic\n\naudit-targets: pain-P1\n",
    };
    const gate = evaluateAccumulatedPainAuditFollowThrough({
      comments: [lean, audit],
      citedLeanId: 10,
      assertedPainIds: ["P1"],
      isSuccessorLeanBody,
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.recovery).toBe("add-carrier");
      expect(gate.detail).toContain("missing carrier");
    }
  });
});
