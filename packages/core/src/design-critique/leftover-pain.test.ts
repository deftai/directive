import { describe, expect, it } from "vitest";
import { evaluateAutoStampPath1Write } from "./auto-stamp-path1.js";
import { scanPainCites } from "./citation-grammar.js";
import { evaluateCompletedArcRecord, type ThreadComment } from "./completed-arc-record.js";
import {
  assertedPainIdsFromCites,
  bindLeanPredecessorValid,
  dualStopCapNotation,
  evaluateBoundRemedyCites,
  evaluateContinueRemainder,
  evaluateDualStopPostBudget,
  evaluateFinishStillPossible,
  evaluatePainAuditFollowThrough,
  evaluatePainCitePlacement,
  evaluateYoloLeftoverRecommendation,
  evaluateYoloStandingLeftoverScope,
  mapCarriesAssertedPainCoverage,
  recordingCommentOpensSuccessorLean,
  recordLeftoverIssueNumber,
} from "./leftover-pain.js";

describe("yolo leftover-pain handling (#4593)", () => {
  it("recommends one leftover path when yolo unrelieved recut still has remainder", () => {
    expect(
      evaluateYoloLeftoverRecommendation({
        yoloMode: true,
        uncitedOrDoesNotRelieve: true,
        recutHasDeliverableRemainder: true,
      }),
    ).toEqual({ recommendLeftoverPath: true });
    expect(
      evaluateYoloLeftoverRecommendation({
        yoloMode: true,
        uncitedOrDoesNotRelieve: true,
        recutHasDeliverableRemainder: false,
      }).recommendLeftoverPath,
    ).toBe(false);
    expect(
      evaluateYoloLeftoverRecommendation({
        yoloMode: false,
        uncitedOrDoesNotRelieve: true,
        recutHasDeliverableRemainder: true,
      }).recommendLeftoverPath,
    ).toBe(false);
  });

  it("records leftover issue number from parent issue-create output only", () => {
    expect(recordLeftoverIssueNumber({ number: 4602 })).toBe(4602);
    expect(recordLeftoverIssueNumber(null)).toBeNull();
    expect(recordLeftoverIssueNumber({ number: 0 })).toBeNull();
    expect(recordLeftoverIssueNumber({ number: -1 })).toBeNull();
  });

  it("continues the remainder only while Dual-stop posts remain and finish is possible", () => {
    expect(
      evaluateContinueRemainder({
        leftoverFiled: true,
        dualStopPostsRemaining: 3,
        finishStillPossible: true,
      }).continueCurrentArc,
    ).toBe(true);
    expect(
      evaluateContinueRemainder({
        leftoverFiled: true,
        dualStopPostsRemaining: 0,
        finishStillPossible: true,
      }).continueCurrentArc,
    ).toBe(false);
    expect(
      evaluateContinueRemainder({
        leftoverFiled: true,
        dualStopPostsRemaining: 2,
        finishStillPossible: false,
      }).continueCurrentArc,
    ).toBe(false);
  });

  it("keeps finish possible on strictly fewer blocking findings and halts on repeat primary", () => {
    expect(
      evaluateFinishStillPossible({
        blockingCounts: [3, 1],
        primaryBlockingHeadings: ["blocks-the-design A", "blocks-the-design B"],
      }),
    ).toEqual({ finishStillPossible: true, haltOnRepeatPrimary: false });
    expect(
      evaluateFinishStillPossible({
        blockingCounts: [2, 2],
        primaryBlockingHeadings: ["blocks-the-design A", "blocks-the-design B"],
      }).finishStillPossible,
    ).toBe(false);
    expect(
      evaluateFinishStillPossible({
        blockingCounts: [3, 1],
        primaryBlockingHeadings: ["blocks-the-design A", "blocks-the-design A"],
      }),
    ).toEqual({ finishStillPossible: false, haltOnRepeatPrimary: true });
    expect(
      evaluateFinishStillPossible({
        blockingCounts: [3, 4, 2],
        primaryBlockingHeadings: [
          "blocks-the-design A",
          "blocks-the-design B",
          "blocks-the-design C",
        ],
      }).finishStillPossible,
    ).toBe(false);
    expect(
      evaluateFinishStillPossible({
        blockingCounts: [3, 2, 1],
        primaryBlockingHeadings: [
          "blocks-the-design A",
          "blocks-the-design B",
          "blocks-the-design C",
        ],
      }).finishStillPossible,
    ).toBe(true);
  });

  it("cites operator-deferred only for unmet ids and relieves only for covered ids", () => {
    const cites = scanPainCites(
      "**Lean:** bind.\n\nrelieves: P1\noperator-deferred: P2 #4602\n",
    ).cites;
    expect(
      evaluateBoundRemedyCites({
        unmetIds: ["P2"],
        coveredIds: ["P1"],
        cites,
        issueNumber: 4593,
      }).ok,
    ).toBe(true);
    expect(
      evaluateBoundRemedyCites({
        unmetIds: ["P2"],
        coveredIds: ["P1"],
        cites: scanPainCites("relieves: P2\n").cites,
      }).ok,
    ).toBe(false);
    expect(
      evaluateBoundRemedyCites({
        unmetIds: ["P2"],
        coveredIds: ["P1"],
        cites: scanPainCites("operator-deferred: P1 #4602\n").cites,
      }).ok,
    ).toBe(false);
    expect(
      evaluateBoundRemedyCites({
        unmetIds: ["P2"],
        coveredIds: ["P1"],
        cites: scanPainCites("operator-deferred: P2\n").cites,
        issueNumber: 4593,
      }).ok,
    ).toBe(false);
    expect(
      evaluateBoundRemedyCites({
        unmetIds: ["P2"],
        coveredIds: ["P1"],
        cites: scanPainCites("operator-deferred: P2 #4593\n").cites,
        issueNumber: 4593,
      }).ok,
    ).toBe(false);
  });

  it("places operative cites on bind and retraction leans, not intermediate recuts", () => {
    const bind = evaluatePainCitePlacement({
      kind: "bind",
      body: "**Lean:** bind.\n\nrelieves: P1\noperator-deferred: P2 #4602\n",
    });
    expect(bind.allowed).toBe(true);
    expect(bind.operativeCiteCount).toBe(2);
    const retraction = evaluatePainCitePlacement({
      kind: "retraction",
      body: "**Lean:** retract.\n\ndoes-not-relieve: P1\n",
    });
    expect(retraction.allowed).toBe(true);
    expect(retraction.operativeCiteCount).toBe(1);
    const intermediate = evaluatePainCitePlacement({
      kind: "intermediate",
      body: "**Lean:** recut.\n\nrelieves: P1\n",
    });
    expect(intermediate.allowed).toBe(false);
    const intermediateInline = evaluatePainCitePlacement({
      kind: "intermediate",
      body: "**Lean:** recut.\n\n" + "`relieves: P1`" + "\n",
    });
    expect(intermediateInline.allowed).toBe(true);
    expect(intermediateInline.operativeCiteCount).toBe(0);
  });

  it("follows pain-audit classes: retract, footnote-bindable, record, or new bind", () => {
    expect(
      evaluatePainAuditFollowThrough({
        findingClasses: ["blocking"],
        harvestChanged: false,
      }),
    ).toMatchObject({
      postRetractionThenHandoff: true,
      spendsNumberedDualStopPost: false,
      isRelief: false,
    });
    expect(
      evaluatePainAuditFollowThrough({
        findingClasses: ["footnote"],
        harvestChanged: false,
      }),
    ).toMatchObject({
      bindableWithoutExtraLean: true,
      newBindLeanAndAudit: false,
    });
    expect(
      evaluatePainAuditFollowThrough({
        findingClasses: ["sharpening"],
        harvestChanged: false,
      }),
    ).toMatchObject({
      recordingOnlyParentComment: true,
      movesCriticEnvelopes: false,
      spendsNumberedDualStopPost: false,
      bindableWithoutExtraLean: true,
    });
    expect(
      evaluatePainAuditFollowThrough({
        findingClasses: ["sharpening"],
        harvestChanged: true,
      }),
    ).toMatchObject({
      newBindLeanAndAudit: true,
      spendsNumberedDualStopPost: true,
      movesCriticEnvelopes: true,
      bindableWithoutExtraLean: false,
    });
    expect(recordingCommentOpensSuccessorLean("role: parent\n\nSharpening note.\n")).toBe(false);
    expect(recordingCommentOpensSuccessorLean("**Lean:** must not.\n")).toBe(true);
  });

  it("treats yolo standing as all-accept confirm on a split lean, not split/handoff/waiver", () => {
    expect(
      evaluateYoloStandingLeftoverScope({
        allAcceptMap: true,
        leanCarriesOperatorConfirmedSplit: true,
      }),
    ).toEqual({
      confirmsAllAcceptMap: true,
      confirmsSplit: false,
      waivesPainCoverage: false,
      confirmsHandoff: false,
    });
    expect(
      evaluateYoloStandingLeftoverScope({
        allAcceptMap: true,
        leanCarriesOperatorConfirmedSplit: false,
      }).confirmsAllAcceptMap,
    ).toBe(false);
  });

  it("refuses a bind lean whose predecessor already relieves those ids", () => {
    expect(
      bindLeanPredecessorValid({
        predecessorRelievesIds: ["P1"],
        bindRelievesIds: ["P1"],
      }),
    ).toBe(false);
    expect(
      bindLeanPredecessorValid({
        predecessorRelievesIds: [],
        bindRelievesIds: ["P1"],
      }),
    ).toBe(true);
  });

  it("defaults Dual-stop to 6 posts for spend N=1 and does not refill at Handoff", () => {
    expect(dualStopCapNotation(6)).toBe("Dual-stop cap: 6 posts");
    expect(dualStopCapNotation(6)).not.toBe("Dual-stop cap: N=6");
    const after = evaluateDualStopPostBudget({
      spendSeats: 1,
      criticPostsUsed: 4,
      operatorRaisedCap: null,
      afterHandoff: true,
    });
    expect(after).toEqual({
      numberedCap: 6,
      postsRemaining: 2,
      refilled: false,
      notation: "posts",
    });
    const n3 = evaluateDualStopPostBudget({
      spendSeats: 3,
      criticPostsUsed: 3,
      operatorRaisedCap: null,
      afterHandoff: false,
    });
    expect(n3.numberedCap).toBe(3);
    expect(n3.postsRemaining).toBe(0);
  });

  it("computes asserted coverage as relieves plus different-issue deferred", () => {
    const relieves = "**Lean:** bind.\n\nrelieves: P1\n";
    const deferred = "**Lean:** bind.\n\noperator-deferred: P1 #4602\n";
    const sameIssue = "**Lean:** bind.\n\noperator-deferred: P1 #4593\n";
    const unrelieved = "**Lean:** leftover.\n\ndoes-not-relieve: P1\n";
    expect(mapCarriesAssertedPainCoverage(relieves, ["P1"], 4593)).toBe(true);
    expect(mapCarriesAssertedPainCoverage(deferred, ["P1"], 4593)).toBe(true);
    expect(mapCarriesAssertedPainCoverage(sameIssue, ["P1"], 4593)).toBe(false);
    expect(mapCarriesAssertedPainCoverage(unrelieved, ["P1"], 4593)).toBe(false);
    expect(assertedPainIdsFromCites(scanPainCites(deferred).cites, ["P1"], 4593)).toEqual(["P1"]);
  });

  it("keeps #4592 path-1 refuse; leftover recommend is not ingest-ready", () => {
    const stop1: ThreadComment = {
      id: 5691827130,
      body:
        "model: grok-4.6\nrole: triage\n\n" +
        "design-critique: warranted, because leftover.\n\npain: P1\n",
    };
    const lean: ThreadComment = {
      id: 5691827138,
      body: "**Lean:** recut.\n\nSpec-path: next-build is not this body.\n",
    };
    const live = evaluateCompletedArcRecord({
      comments: [stop1, lean],
      issueNumber: 4593,
    });
    expect(live).toMatchObject({ status: "blocked", reason: "missing-record" });
    const path1 = evaluateAutoStampPath1Write({
      comments: [stop1, lean],
      issueNumber: 4593,
    });
    expect(path1.writePath1).toBe(false);
    expect(path1.writeIngestReadyRemainingSet).toBe(false);
    expect(path1.candidate).toMatchObject({
      status: "blocked",
      reason: "unrelieved-pain",
    });
    expect(
      evaluateYoloLeftoverRecommendation({
        yoloMode: true,
        uncitedOrDoesNotRelieve: true,
        recutHasDeliverableRemainder: true,
      }).recommendLeftoverPath,
    ).toBe(true);
  });

  it("skips conflicting dispositions and honors a Dual-stop raise", () => {
    const mixed = scanPainCites("relieves: P1\noperator-deferred: P1 #4602\n").cites;
    expect(assertedPainIdsFromCites(mixed, ["P1"], 4593)).toEqual([]);
    const raised = evaluateDualStopPostBudget({
      spendSeats: 1,
      criticPostsUsed: 6,
      operatorRaisedCap: 9,
      afterHandoff: false,
    });
    expect(raised.numberedCap).toBe(9);
    expect(raised.postsRemaining).toBe(3);
    const other = evaluateDualStopPostBudget({
      spendSeats: 2,
      criticPostsUsed: 0,
      operatorRaisedCap: null,
      afterHandoff: false,
    });
    expect(other.numberedCap).toBe(0);
    expect(
      evaluatePainAuditFollowThrough({
        findingClasses: [],
        harvestChanged: false,
      }).bindableWithoutExtraLean,
    ).toBe(true);
    expect(
      assertedPainIdsFromCites(scanPainCites("relieves: P1\n").cites, ["P1"], undefined),
    ).toEqual(["P1"]);
    expect(
      assertedPainIdsFromCites(scanPainCites("operator-deferred: P1\n").cites, ["P1"], 4593),
    ).toEqual([]);
  });
});
