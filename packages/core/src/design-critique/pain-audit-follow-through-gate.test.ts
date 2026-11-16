/**
 * Colocated coverage for pain-audit-follow-through-gate (#5233 / #1310).
 * Integration fixtures also live in leftover-pain.test.ts.
 */
import { describe, expect, it } from "vitest";
import { isSuccessorLeanBody } from "./completed-arc-record.js";
import {
  auditCountsForLean,
  evaluateAccumulatedPainAuditFollowThrough,
  evaluatePainAuditFollowThrough,
  extractOperativeFindingClasses,
  extractOperativeHarvestChanged,
  extractOperativeHarvestDigest,
  hashBoundRemedyBytes,
  hashHarvestIdentity,
  leanHasAcceptanceOrSlices,
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

describe("harvest identity and the harvest-digest count rule (#6333 item 3)", () => {
  const plainLean = "**Lean:** bind.\n\n## Bound remedy\n\n1. harvest\n\nrelieves: P1\n";
  const acLean =
    "**Lean:** bind.\n\n## Bound remedy\n\n1. harvest\n\n" +
    "## Acceptance Criteria\n- Given a lean, then both lists are harvested.\n\nrelieves: P1\n";
  const slicedLean = `${plainLean}\n## Slices\n- slice-a: B1\n`;

  function audit(extra = ""): string {
    return `role: critic\n\naudit-targets: pain-P1\nfinding-classes: footnote\nharvest-changed: false\n${extra}`;
  }

  function gate(leanBody: string, auditBody: string) {
    return evaluateAccumulatedPainAuditFollowThrough({
      comments: [
        { id: 10, body: leanBody },
        { id: 11, body: auditBody },
      ],
      citedLeanId: 10,
      assertedPainIds: ["P1"],
      isSuccessorLeanBody,
    });
  }

  it("keeps the Bound-remedy digest for a lean with neither list nor Slices", () => {
    expect(leanHasAcceptanceOrSlices(plainLean)).toBe(false);
    expect(hashHarvestIdentity(plainLean)).toBe(hashBoundRemedyBytes(plainLean));
  });

  it("covers both lists and the Slices section", () => {
    expect(leanHasAcceptanceOrSlices(acLean)).toBe(true);
    expect(leanHasAcceptanceOrSlices(slicedLean)).toBe(true);
    expect(hashHarvestIdentity(acLean)).not.toBe(hashBoundRemedyBytes(acLean));
    const editedAc = acLean.replace("both lists are harvested", "one list is harvested");
    expect(hashHarvestIdentity(editedAc)).not.toBe(hashHarvestIdentity(acLean));
    const editedSlices = slicedLean.replace("slice-a", "slice-b");
    expect(hashHarvestIdentity(editedSlices)).not.toBe(hashHarvestIdentity(slicedLean));
  });

  it("reads the operative harvest-digest carrier", () => {
    const digest = "b".repeat(64);
    expect(extractOperativeHarvestDigest(`harvest-digest: sha256:${digest}\n`)).toEqual({
      ok: true,
      digest,
    });
    expect(extractOperativeHarvestDigest(`harvest-digest: ${digest.toUpperCase()}\n`)).toEqual({
      ok: true,
      digest,
    });
    expect(extractOperativeHarvestDigest("no carrier\n")).toBeNull();
    expect(extractOperativeHarvestDigest("```\nharvest-digest: sha256:x\n```\n")).toBeNull();
    expect(extractOperativeHarvestDigest("harvest-digest: sha256:short\n")?.ok).toBe(false);
    expect(
      extractOperativeHarvestDigest(
        `harvest-digest: sha256:${digest}\nharvest-digest: sha256:${"c".repeat(64)}\n`,
      )?.ok,
    ).toBe(false);
  });

  it("counts a digestless audit only for a lean with no Acceptance Criteria list and no Slices", () => {
    expect(auditCountsForLean({ auditBody: audit(), leanBody: plainLean })).toBe(true);
    expect(auditCountsForLean({ auditBody: audit(), leanBody: acLean })).toBe(false);
    expect(auditCountsForLean({ auditBody: audit(), leanBody: slicedLean })).toBe(false);
    expect(gate(plainLean, audit()).ok).toBe(true);
    const refused = gate(acLean, audit());
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.recovery).toBe("add-carrier");
      expect(refused.detail).toContain("no targeting audit counts for lean 10");
      expect(refused.detail).toContain(`sha256:${hashHarvestIdentity(acLean)}`);
    }
  });

  it("counts an audit only when its recorded digest equals the lean's current digest", () => {
    const recorded = `harvest-digest: sha256:${hashHarvestIdentity(acLean)}\n`;
    expect(gate(acLean, audit(recorded)).ok).toBe(true);
    const editedAfterAudit = acLean.replace("both lists are harvested", "one list is harvested");
    expect(gate(editedAfterAudit, audit(recorded)).ok).toBe(false);
    const stalePlain = `harvest-digest: sha256:${"d".repeat(64)}\n`;
    expect(gate(plainLean, audit(stalePlain)).ok).toBe(false);
    expect(gate(plainLean, audit("harvest-digest: nonsense\n")).ok).toBe(false);
  });

  it("does not let a stale audit of an earlier lean text block a fresh counting audit", () => {
    const oldLean = acLean.replace("both lists are harvested", "one list is harvested");
    const staleBlocking =
      "role: critic\n\naudit-targets: pain-P1\nfinding-classes: blocking\nharvest-changed: false\n" +
      `harvest-digest: sha256:${hashHarvestIdentity(oldLean)}\n`;
    const fresh = audit(`harvest-digest: sha256:${hashHarvestIdentity(acLean)}\n`);
    const result = evaluateAccumulatedPainAuditFollowThrough({
      comments: [
        { id: 10, body: acLean },
        { id: 11, body: staleBlocking },
        { id: 12, body: fresh },
      ],
      citedLeanId: 10,
      assertedPainIds: ["P1"],
      isSuccessorLeanBody,
    });
    expect(result.ok).toBe(true);
  });
});
