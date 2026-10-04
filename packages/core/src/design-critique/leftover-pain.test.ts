import { describe, expect, it } from "vitest";
import { evaluateAutoStampPath1Write } from "./auto-stamp-path1.js";
import { scanPainCites } from "./citation-grammar.js";
import {
  evaluateCompletedArcRecord,
  isSuccessorLeanBody,
  type ThreadComment,
} from "./completed-arc-record.js";
import {
  assertedPainIdsFromCites,
  bindLeanPredecessorValid,
  deriveReservedPainAuditPostsUsed,
  dualStopCapNotation,
  dualStopReservedLiteracyRecordLine,
  evaluateBoundRemedyCites,
  evaluateContinueRemainder,
  evaluateDualStopParentPath,
  evaluateDualStopPostBudget,
  evaluateFinishStillPossible,
  evaluatePainAuditDispatchFill,
  evaluatePainAuditFollowThrough,
  evaluatePainCitePlacement,
  evaluateReservedSlotLiteracyRecording,
  evaluateVerificationPathBeforePanelDeposit,
  evaluateYoloLeftoverRecommendation,
  evaluateYoloStandingLeftoverScope,
  mapCarriesAssertedPainCoverage,
  painAuditDispatchAuditTargetsLine,
  recordingCommentOpensSuccessorLean,
  recordLeftoverIssueNumber,
  verificationPathRecordLine,
} from "./leftover-pain.js";
import {
  evaluateAccumulatedPainAuditFollowThrough,
  extractOperativeFindingClasses,
  extractOperativeHarvestChanged,
  hashBoundRemedyBytes,
} from "./pain-audit-follow-through-gate.js";
import { N1_SPEND, N3_SPEND } from "./spend.js";

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
      movesCriticEnvelopes: false,
      isRelief: false,
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

  it("allows same-P* overlap only when harvestChanged and operative Recut (#5284)", () => {
    expect(
      bindLeanPredecessorValid({
        predecessorRelievesIds: ["P1"],
        bindRelievesIds: ["P1"],
        harvestChanged: false,
        operativelyRecutSupersedesPriorSuccessorLean: true,
      }),
    ).toBe(false);
    expect(
      bindLeanPredecessorValid({
        predecessorRelievesIds: ["P1"],
        bindRelievesIds: ["P1"],
        harvestChanged: true,
        operativelyRecutSupersedesPriorSuccessorLean: false,
      }),
    ).toBe(false);
    expect(
      bindLeanPredecessorValid({
        predecessorRelievesIds: ["P1"],
        bindRelievesIds: ["P1"],
        harvestChanged: true,
        operativelyRecutSupersedesPriorSuccessorLean: true,
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

  it("admits leftover-pain Dual-stop parent path as numbered remaining OR reserved slot (#4522)", () => {
    const spentAsserted = {
      spendSeats: 3,
      criticPostsUsed: 3,
      operatorRaisedCap: null,
      afterHandoff: false,
      mapCarriesAssertedPainCoverage: true,
    };
    expect(
      evaluateDualStopParentPath({
        ...spentAsserted,
        reservedPainAuditPostsUsed: 0,
      }),
    ).toEqual({
      postsRemaining: 0,
      inCapWithoutRaise: true,
      admit: true,
    });
    expect(
      evaluateDualStopParentPath({
        ...spentAsserted,
        reservedPainAuditPostsUsed: 1,
      }),
    ).toEqual({
      postsRemaining: 0,
      inCapWithoutRaise: false,
      admit: false,
    });
    expect(
      evaluateDualStopParentPath({
        ...spentAsserted,
        mapCarriesAssertedPainCoverage: false,
        reservedPainAuditPostsUsed: 0,
      }).admit,
    ).toBe(false);
  });

  it("derives reserved-slot use from criticEnvelopes after the earliest asserted lean (#4522)", () => {
    const earliest: ThreadComment = {
      id: 10,
      body: "**Lean:** bind.\n\nrelieves: P1\n",
    };
    const firstAudit: ThreadComment = {
      id: 20,
      body: "model: grok-4.6\nrole: critic\n\naudit-targets: pain-P1\n",
    };
    const recut: ThreadComment = {
      id: 30,
      body: "**Lean:** Recut-supersedes 10.\n\nrelieves: P1\n",
    };
    const unassertedLean: ThreadComment = {
      id: 12,
      body: "**Lean:** recut.\n\nSpec-path: next-build is not this body.\n",
    };
    const declaredNone: ThreadComment = {
      id: 15,
      body: "model: grok-4.6\nrole: critic\n\naudit-targets: none\n",
    };
    const otherMarker: ThreadComment = {
      id: 16,
      body: "model: grok-4.6\nrole: critic\n\naudit-targets: pain-P2\n",
    };
    const comments = [earliest, unassertedLean, declaredNone, otherMarker, firstAudit, recut];
    expect(
      deriveReservedPainAuditPostsUsed({
        comments,
        afterCommentId: earliest.id,
        assertedPainIds: ["P1"],
      }),
    ).toBe(1);
    const reservedUsedAfterRecut = deriveReservedPainAuditPostsUsed({
      comments,
      afterCommentId: recut.id,
      assertedPainIds: ["P1"],
    });
    expect(reservedUsedAfterRecut).toBe(1);
    expect(
      evaluateDualStopParentPath({
        spendSeats: 3,
        criticPostsUsed: 3,
        operatorRaisedCap: null,
        afterHandoff: false,
        mapCarriesAssertedPainCoverage: true,
        reservedPainAuditPostsUsed: deriveReservedPainAuditPostsUsed({
          comments,
          afterCommentId: earliest.id,
          assertedPainIds: ["P1"],
        }),
      }).admit,
    ).toBe(false);
    expect(
      evaluateDualStopParentPath({
        spendSeats: 3,
        criticPostsUsed: 3,
        operatorRaisedCap: null,
        afterHandoff: false,
        mapCarriesAssertedPainCoverage: true,
        reservedPainAuditPostsUsed: reservedUsedAfterRecut,
      }).admit,
    ).toBe(false);
  });

  it("does not count a cancelled prior arc's pain-audit as reserved-slot use (#4522)", () => {
    const priorLean: ThreadComment = {
      id: 10,
      body: "**Lean:** bind.\n\nrelieves: P1\n",
    };
    const priorAudit: ThreadComment = {
      id: 20,
      body: "model: grok-4.6\nrole: critic\n\naudit-targets: pain-P1\n",
    };
    const cancelled: ThreadComment = {
      id: 25,
      body: "model: grok-4.6\nrole: parent\n\ndesign-critique: cancelled, because dominated\n",
    };
    const currentLean: ThreadComment = {
      id: 30,
      body: "**Lean:** bind.\n\nrelieves: P1\n",
    };
    const currentAudit: ThreadComment = {
      id: 35,
      body: "model: grok-4.6\nrole: critic\n\naudit-targets: pain-P1\n",
    };
    const recut: ThreadComment = {
      id: 40,
      body: "**Lean:** Recut-supersedes 30.\n\nrelieves: P1\n",
    };
    const comments = [priorLean, priorAudit, cancelled, currentLean];
    expect(
      deriveReservedPainAuditPostsUsed({
        comments,
        afterCommentId: currentLean.id,
        assertedPainIds: ["P1"],
      }),
    ).toBe(0);
    const sameArc = [priorLean, priorAudit, cancelled, currentLean, currentAudit, recut];
    expect(
      deriveReservedPainAuditPostsUsed({
        comments: sameArc,
        afterCommentId: recut.id,
        assertedPainIds: ["P1"],
      }),
    ).toBe(1);
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

  it("fills pain-audit dispatch with operative audit-targets; English is not targeting (#4648)", () => {
    const filledLine = painAuditDispatchAuditTargetsLine(["pain-P1"]);
    expect(filledLine).toBe("audit-targets: pain-P1");
    expect(painAuditDispatchAuditTargetsLine([])).toBe("audit-targets: none");
    expect(painAuditDispatchAuditTargetsLine(["pain-P1", "pain-P2"])).toBe(
      "audit-targets: pain-P1, pain-P2",
    );
    const filledBody = `model: grok-4.6\nrole: critic\n\n${filledLine}\n`;
    expect(
      evaluatePainAuditDispatchFill({
        body: filledBody,
        requiredMarkerIds: ["pain-P1"],
      }).filled,
    ).toBe(true);
    const english =
      "model: grok-4.6\nrole: critic\n\n## Pain-audit of relieves: P1\n\nFootnote-only.\n";
    expect(
      evaluatePainAuditDispatchFill({
        body: english,
        requiredMarkerIds: ["pain-P1"],
      }).filled,
    ).toBe(false);
    expect(
      evaluatePainAuditDispatchFill({
        body: "role: critic\n> audit-targets: pain-P1\n",
        requiredMarkerIds: ["pain-P1"],
      }).filled,
    ).toBe(false);
    expect(
      evaluatePainAuditDispatchFill({
        body: "role: critic\naudit-targets: none\n",
        requiredMarkerIds: ["pain-P1"],
      }).filled,
    ).toBe(false);
    expect(
      evaluatePainAuditDispatchFill({
        body: "role: critic\naudit-targets: none\n",
        requiredMarkerIds: [],
      }).filled,
    ).toBe(true);
  });

  it("later-arc bind lean needs a critic after that lean id; predecessor critic is not clearance (#4648)", () => {
    const stop1: ThreadComment = {
      id: 5704192180,
      body:
        "model: grok-4.6\nrole: triage\n\n" +
        "design-critique: warranted, because leftover stamp.\n\npain: P1\n",
    };
    const predLean: ThreadComment = {
      id: 5701370883,
      body: "**Lean:** recut.\n\nSpec-path: next-build contract is not this body.\n\nrelieves: P1\n",
    };
    const predCritic: ThreadComment = {
      id: 5701918171,
      body: "model: grok-4.6\nrole: critic\n\naudit-targets: pain-P1\n",
    };
    const laterLean: ThreadComment = {
      id: 5703783181,
      body: "**Lean:** recut.\n\nSpec-path: next-build contract is not this body.\n\nrelieves: P1\n",
    };
    const path1 = evaluateAutoStampPath1Write({
      comments: [stop1, predLean, predCritic, laterLean],
      issueNumber: 4628,
    });
    expect(path1.writePath1).toBe(false);
    expect(path1.writeIngestReadyRemainingSet).toBe(false);
    expect(path1.candidate).toMatchObject({
      status: "blocked",
      reason: "unresolved-pain-audit",
    });
    const live = evaluateCompletedArcRecord({
      comments: [stop1, predLean, predCritic, laterLean],
      issueNumber: 4628,
    });
    expect(live).toMatchObject({ status: "blocked", reason: "missing-record" });
  });

  it("asserted relieves plus different-issue deferred stay unresolved until a later critic (#4648)", () => {
    const lean: ThreadComment = {
      id: 5691827200,
      body:
        "**Lean:** recut.\n\nSpec-path: next-build contract is not this body.\n\n" +
        "relieves: P1\noperator-deferred: P2 #4602\n",
    };
    expect(assertedPainIdsFromCites(scanPainCites(lean.body).cites, ["P1", "P2"], 4593)).toEqual([
      "P1",
      "P2",
    ]);
    const stopBoth: ThreadComment = {
      id: 5691827100,
      body:
        "model: grok-4.6\nrole: triage\n\n" +
        "design-critique: warranted, because leftover.\n\npain: P1, P2\n",
    };
    const path1 = evaluateAutoStampPath1Write({
      comments: [stopBoth, lean],
      issueNumber: 4593,
    });
    expect(path1.writePath1).toBe(false);
    expect(path1.candidate).toMatchObject({
      status: "blocked",
      reason: "unresolved-pain-audit",
    });
  });
});

describe("reserved-slot literacy + verification-path (#5188)", () => {
  it("owes dual-stop-reserved literacy only for N≥3 with non-vacuous pain", () => {
    expect(
      evaluateReservedSlotLiteracyRecording({
        spend: N3_SPEND,
        painIds: ["P1", "P2"],
      }),
    ).toEqual({
      owed: true,
      recordLine: dualStopReservedLiteracyRecordLine(),
    });
    expect(dualStopReservedLiteracyRecordLine()).toContain("dual-stop-reserved:");
    expect(dualStopReservedLiteracyRecordLine()).toContain("evaluateDualStopParentPath");
    expect(
      evaluateReservedSlotLiteracyRecording({
        spend: N1_SPEND,
        painIds: ["P1"],
      }),
    ).toEqual({ owed: false, recordLine: null });
    expect(
      evaluateReservedSlotLiteracyRecording({
        spend: N3_SPEND,
        painIds: [],
      }),
    ).toEqual({ owed: false, recordLine: null });
  });

  it("keeps second reserved pain-audit raise-by-design after first use", () => {
    const spentAsserted = {
      spendSeats: 3,
      criticPostsUsed: 3,
      operatorRaisedCap: null,
      afterHandoff: false,
      mapCarriesAssertedPainCoverage: true,
    };
    expect(
      evaluateDualStopParentPath({
        ...spentAsserted,
        reservedPainAuditPostsUsed: 0,
      }).admit,
    ).toBe(true);
    expect(
      evaluateDualStopParentPath({
        ...spentAsserted,
        reservedPainAuditPostsUsed: 1,
      }),
    ).toEqual({
      postsRemaining: 0,
      inCapWithoutRaise: false,
      admit: false,
    });
  });

  it("defaults verification-path to pin-read; refuses missing line on process-only dest", () => {
    const pin = verificationPathRecordLine({
      kind: "pin-read",
      dispatchSha: "5a311bf5cb976ccaacdcfe939e630878135ab819",
    });
    expect(pin).toBe(
      "verification-path: pin-read git show 5a311bf5cb976ccaacdcfe939e630878135ab819:; dest cwd-without-occupy",
    );
    expect(
      evaluateVerificationPathBeforePanelDeposit({
        processOnlyDest: true,
        recordedLine: pin,
      }),
    ).toEqual({ ok: true });
    expect(
      evaluateVerificationPathBeforePanelDeposit({
        processOnlyDest: true,
        recordedLine: null,
      }),
    ).toEqual({ ok: false, reason: "missing-verification-path" });
    expect(
      evaluateVerificationPathBeforePanelDeposit({
        processOnlyDest: true,
        recordedLine: "   ",
      }),
    ).toEqual({ ok: false, reason: "missing-verification-path" });
    expect(
      evaluateVerificationPathBeforePanelDeposit({
        processOnlyDest: false,
        recordedLine: null,
      }),
    ).toEqual({ ok: true });
    const provisioned = verificationPathRecordLine({
      kind: "provisioned",
      path: "pnpm exec vitest run packages/core/src/design-critique",
    });
    expect(provisioned).toContain("verification-path: provisioned ");
    expect(
      evaluateVerificationPathBeforePanelDeposit({
        processOnlyDest: true,
        recordedLine: provisioned,
      }),
    ).toEqual({ ok: true });
  });

  it("refuses launch-probe and other non-closed verification-path junk", () => {
    expect(
      evaluateVerificationPathBeforePanelDeposit({
        processOnlyDest: true,
        recordedLine: "verification-path: launch-probe",
      }),
    ).toEqual({ ok: false, reason: "invalid-verification-path" });
    expect(
      evaluateVerificationPathBeforePanelDeposit({
        processOnlyDest: true,
        recordedLine: "verification-path: junk-token",
      }),
    ).toEqual({ ok: false, reason: "invalid-verification-path" });
    expect(
      evaluateVerificationPathBeforePanelDeposit({
        processOnlyDest: true,
        recordedLine: "verification-path: pin-read",
      }),
    ).toEqual({ ok: false, reason: "invalid-verification-path" });
    expect(
      evaluateVerificationPathBeforePanelDeposit({
        processOnlyDest: true,
        recordedLine: "verification-path: provisioned",
      }),
    ).toEqual({ ok: false, reason: "invalid-verification-path" });
  });
});

describe("pain-audit follow-through gate Prefer-A Bound (#5233)", () => {
  const STOP1_ID = 5900000001;
  const LEAN_ID = 5900000100;
  const TABLE_ID = 5900000200;
  const SYNTHESIS_ID = 5900000300;
  /** Historical #5192 blocking ceiling id. */
  const BLOCKING_AUDIT_ID = 5919579871;
  /** Historical #5192 harvest-changing ceiling id. */
  const HARVEST_AUDIT_ID = 5938850553;

  const stop1: ThreadComment = {
    id: STOP1_ID,
    body:
      "role: parent\n\ndesign-critique: warranted, because adverse follow-through gap.\n\n" +
      "pain: P1\n",
  };

  function leanWithRemedy(id: number, remedy: string): ThreadComment {
    return {
      id,
      body:
        "**Lean:** Prefer-A Bound.\n\nSpec-path: Bound-remedy\n\n## Bound remedy\n\n" +
        remedy +
        "\n\nrelieves: P1\n",
    };
  }

  function synthesisFor(leanId: number): ThreadComment {
    return {
      id: SYNTHESIS_ID,
      body:
        "model: grok-4.6\nrole: parent\n\n" +
        "design-critique: synthesis accepted, because agents agreed (empty disagreement set)\n\n" +
        `Citing successor lean ${leanId} and verified-claims table ${TABLE_ID}.\n`,
    };
  }

  const table: ThreadComment = {
    id: TABLE_ID,
    body: "## Verified-claims table\n\n| # | Claim |\n",
  };

  function critic(id: number, body: string): ThreadComment {
    return { id, body: `model: grok-4.6\nrole: critic\n\n${body}` };
  }

  it("parses closed finding-classes and harvest-changed; fences ignore quotes", () => {
    expect(extractOperativeFindingClasses("finding-classes: none\n")).toEqual({
      ok: true,
      classes: [],
      explicitEmpty: true,
    });
    expect(extractOperativeFindingClasses("finding-classes: blocking, footnote\n")).toEqual({
      ok: true,
      classes: ["blocking", "footnote"],
      explicitEmpty: false,
    });
    expect(extractOperativeFindingClasses("finding-classes: none, blocking\n")?.ok).toBe(false);
    expect(extractOperativeFindingClasses("finding-classes: \n")?.ok).toBe(false);
    expect(
      extractOperativeFindingClasses("finding-classes: blocking\nfinding-classes: none\n")?.ok,
    ).toBe(false);
    expect(extractOperativeHarvestChanged("harvest-changed: true\n")).toEqual({
      ok: true,
      harvestChanged: true,
    });
    expect(extractOperativeHarvestChanged("harvest-changed: maybe\n")?.ok).toBe(false);
    expect(extractOperativeFindingClasses("```\nfinding-classes: blocking\n```\n")).toBeNull();
    expect(extractOperativeHarvestChanged("> harvest-changed: true\n")).toBeNull();
  });

  it("hashes Bound-remedy list titles; hyphen heading and relieves churn are stable", () => {
    const a = leanWithRemedy(1, "1. first harvest\n");
    const b = leanWithRemedy(2, "1. first harvest\n");
    const c = leanWithRemedy(3, "1. changed harvest\n");
    expect(hashBoundRemedyBytes(a.body)).toBe(hashBoundRemedyBytes(b.body));
    expect(hashBoundRemedyBytes(a.body)).not.toBe(hashBoundRemedyBytes(c.body));
    const hyphen =
      "**Lean:** Prefer-A Bound.\n\n## Bound-remedy\n\n1. first harvest\n\nrelieves: P9\n";
    expect(hashBoundRemedyBytes(hyphen)).toBe(hashBoundRemedyBytes(a.body));
  });

  it("refuses raw #5192 blocking ceiling 5919579871 without follow-through clearance", () => {
    const lean = leanWithRemedy(LEAN_ID, "1. original harvest\n");
    const audit = critic(
      BLOCKING_AUDIT_ID,
      "audit-targets: pain-P1\nfinding-classes: blocking\nharvest-changed: false\n",
    );
    const handoff: ThreadComment = {
      id: BLOCKING_AUDIT_ID + 1,
      body: "role: parent\n\nHandoff\n\nretraction map posted.\n",
    };
    const comments = [stop1, lean, table, audit, handoff, synthesisFor(LEAN_ID)];
    const verdict = evaluateCompletedArcRecord({ comments, issueNumber: 5192 });
    expect(verdict).toMatchObject({ status: "blocked", reason: "unresolved-pain-audit" });
    if (verdict.status === "blocked") {
      expect(verdict.detail).toContain("blocking audit");
      expect(verdict.detail).toContain(String(BLOCKING_AUDIT_ID));
      expect(verdict.detail).toContain("Handoff is not clearance");
    }
    expect(
      evaluateAutoStampPath1Write({ comments: [stop1, lean, audit, handoff], issueNumber: 5192 })
        .writePath1,
    ).toBe(false);
  });

  it("refuses raw #5192 harvest-changing ceiling 5938850553 until digest changes + later audit", () => {
    const lean = leanWithRemedy(LEAN_ID, "1. original harvest\n");
    const audit = critic(
      HARVEST_AUDIT_ID,
      "audit-targets: pain-P1\nfinding-classes: sharpening\nharvest-changed: true\n",
    );
    const comments = [stop1, lean, table, audit, synthesisFor(LEAN_ID)];
    const verdict = evaluateCompletedArcRecord({ comments, issueNumber: 5192 });
    expect(verdict).toMatchObject({ status: "blocked", reason: "unresolved-pain-audit" });
    if (verdict.status === "blocked") {
      expect(verdict.detail).toContain("harvest-changing");
      expect(verdict.detail).toContain(String(HARVEST_AUDIT_ID));
      expect(verdict.detail).toContain("byte-identical lean rotation does not discharge");
    }
  });

  it("does not let byte-identical lean rotation discharge harvest-changing", () => {
    const lean1 = leanWithRemedy(LEAN_ID, "1. same bytes\n");
    // Chronological id between leans (historical ceiling 5938850553 is shape-only here).
    const audit = critic(
      LEAN_ID + 10,
      "audit-targets: pain-P1\nfinding-classes: sharpening\nharvest-changed: true\n",
    );
    const lean2 = leanWithRemedy(LEAN_ID + 50, "1. same bytes\n");
    const laterAudit = critic(
      lean2.id + 1,
      "audit-targets: pain-P1\nfinding-classes: none\nharvest-changed: false\n",
    );
    expect(hashBoundRemedyBytes(lean1.body)).toBe(hashBoundRemedyBytes(lean2.body));
    const comments = [
      stop1,
      lean1,
      audit,
      lean2,
      table,
      laterAudit,
      {
        id: SYNTHESIS_ID + 10,
        body:
          "model: grok-4.6\nrole: parent\n\n" +
          "design-critique: synthesis accepted, because agents agreed (empty disagreement set)\n\n" +
          `Citing successor lean ${lean2.id} and verified-claims table ${TABLE_ID}.\n`,
      },
    ];
    expect(evaluateCompletedArcRecord({ comments, issueNumber: 5233 })).toMatchObject({
      status: "blocked",
      reason: "unresolved-pain-audit",
    });
  });

  it("does not let a later footnote-only audit launder prior blocking", () => {
    const lean = leanWithRemedy(LEAN_ID, "1. harvest\n");
    const blocking = critic(
      BLOCKING_AUDIT_ID,
      "audit-targets: pain-P1\nfinding-classes: blocking\nharvest-changed: false\n",
    );
    const footnote = critic(
      BLOCKING_AUDIT_ID + 5,
      "audit-targets: pain-P1\nfinding-classes: footnote\nharvest-changed: false\n",
    );
    const gate = evaluateAccumulatedPainAuditFollowThrough({
      comments: [lean, blocking, footnote],
      citedLeanId: LEAN_ID,
      assertedPainIds: ["P1"],
      isSuccessorLeanBody,
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.recovery).toBe("retraction-handoff");
      expect(gate.detail).toContain("blocking");
    }
  });

  it("refuses missing carrier on a targeting audit", () => {
    const lean = leanWithRemedy(LEAN_ID, "1. harvest\n");
    const bare = critic(LEAN_ID + 1, "audit-targets: pain-P1\n");
    const comments = [stop1, lean, table, bare, synthesisFor(LEAN_ID)];
    const verdict = evaluateCompletedArcRecord({ comments, issueNumber: 5233 });
    expect(verdict).toMatchObject({ status: "blocked", reason: "unresolved-pain-audit" });
    if (verdict.status === "blocked") {
      expect(verdict.detail).toContain("missing carrier");
    }
  });

  it("ignores parent-understated finding-classes; critic blocking still refuses", () => {
    const lean = leanWithRemedy(LEAN_ID, "1. harvest\n");
    const audit = critic(
      BLOCKING_AUDIT_ID,
      "audit-targets: pain-P1\nfinding-classes: blocking\nharvest-changed: false\n",
    );
    const parentUnderstate: ThreadComment = {
      id: BLOCKING_AUDIT_ID + 2,
      body: "role: parent\n\nfinding-classes: none\nharvest-changed: false\n",
    };
    const comments = [stop1, lean, table, audit, parentUnderstate, synthesisFor(LEAN_ID)];
    expect(evaluateCompletedArcRecord({ comments, issueNumber: 5233 })).toMatchObject({
      status: "blocked",
      reason: "unresolved-pain-audit",
    });
  });

  it("completes after genuine Bound-remedy change plus later clear audit", () => {
    const lean1 = leanWithRemedy(LEAN_ID, "1. original harvest\n");
    // Chronological id between leans; ceiling 5938850553 shape covered in refuse fixture.
    const adverse = critic(
      LEAN_ID + 10,
      "audit-targets: pain-P1\nfinding-classes: sharpening\nharvest-changed: true\n",
    );
    const lean2 = {
      id: LEAN_ID + 50,
      body:
        leanWithRemedy(LEAN_ID + 50, "1. changed harvest after audit\n").body +
        `disposes critic ${adverse.id}\n`,
    };
    const later = critic(
      lean2.id + 1,
      "audit-targets: pain-P1\nfinding-classes: none\nharvest-changed: false\n",
    );
    expect(hashBoundRemedyBytes(lean1.body)).not.toBe(hashBoundRemedyBytes(lean2.body));
    const comments = [
      stop1,
      lean1,
      adverse,
      lean2,
      table,
      later,
      {
        id: SYNTHESIS_ID + 20,
        body:
          "model: grok-4.6\nrole: parent\n\n" +
          "design-critique: synthesis accepted, because agents agreed (empty disagreement set)\n\n" +
          `Citing successor lean ${lean2.id} and verified-claims table ${TABLE_ID}.\n`,
      },
    ];
    expect(evaluateCompletedArcRecord({ comments, issueNumber: 5233 })).toMatchObject({
      status: "complete",
      citedLeanId: lean2.id,
    });
    expect(
      evaluateAutoStampPath1Write({
        comments: [stop1, lean1, adverse, lean2, later],
        issueNumber: 5233,
      }).writePath1,
    ).toBe(true);
  });

  it("refuses changed digest without citing the prior harvest-changing audit", () => {
    const lean1 = leanWithRemedy(LEAN_ID, "1. original harvest\n");
    const adverse = critic(
      LEAN_ID + 10,
      "audit-targets: pain-P1\nfinding-classes: sharpening\nharvest-changed: true\n",
    );
    const lean2 = leanWithRemedy(LEAN_ID + 50, "1. changed harvest after audit\n");
    const later = critic(
      lean2.id + 1,
      "audit-targets: pain-P1\nfinding-classes: none\nharvest-changed: false\n",
    );
    expect(
      evaluateCompletedArcRecord({
        comments: [
          stop1,
          lean1,
          adverse,
          lean2,
          table,
          later,
          {
            id: SYNTHESIS_ID + 21,
            body:
              "model: grok-4.6\nrole: parent\n\n" +
              "design-critique: synthesis accepted, because agents agreed (empty disagreement set)\n\n" +
              `Citing successor lean ${lean2.id} and verified-claims table ${TABLE_ID}.\n`,
          },
        ],
        issueNumber: 5233,
      }),
    ).toMatchObject({ status: "blocked", reason: "unresolved-pain-audit" });
  });

  it("refuses non-harvest sharpening without a recording parent takes comment", () => {
    const lean = leanWithRemedy(LEAN_ID, "1. harvest\n");
    const sharpen = critic(
      LEAN_ID + 1,
      "audit-targets: pain-P1\nfinding-classes: sharpening\nharvest-changed: false\n",
    );
    expect(
      evaluateAccumulatedPainAuditFollowThrough({
        comments: [lean, sharpen],
        citedLeanId: LEAN_ID,
        assertedPainIds: ["P1"],
        isSuccessorLeanBody,
      }),
    ).toMatchObject({ ok: false, recovery: "record-parent-takes" });
    const bareCite: ThreadComment = {
      id: LEAN_ID + 2,
      body: `role: parent\n\nsynthesis mentions ${sharpen.id} only\n`,
    };
    expect(
      evaluateAccumulatedPainAuditFollowThrough({
        comments: [lean, sharpen, bareCite],
        citedLeanId: LEAN_ID,
        assertedPainIds: ["P1"],
        isSuccessorLeanBody,
      }),
    ).toMatchObject({ ok: false, recovery: "record-parent-takes" });
    const recorded: ThreadComment = {
      id: LEAN_ID + 3,
      body: `role: parent\n\nrecorded takes for audit ${sharpen.id}\n`,
    };
    expect(
      evaluateAccumulatedPainAuditFollowThrough({
        comments: [lean, sharpen, recorded],
        citedLeanId: LEAN_ID,
        assertedPainIds: ["P1"],
        isSuccessorLeanBody,
      }).ok,
    ).toBe(true);
  });

  it("keeps footnote-only / clear carrier bindable on the cited harvest", () => {
    const lean = leanWithRemedy(LEAN_ID, "1. harvest\n");
    const clear = critic(
      LEAN_ID + 1,
      "audit-targets: pain-P1\nfinding-classes: none\nharvest-changed: false\n",
    );
    expect(
      evaluateCompletedArcRecord({
        comments: [stop1, lean, table, clear, synthesisFor(LEAN_ID)],
        issueNumber: 5233,
      }),
    ).toMatchObject({ status: "complete", citedLeanId: LEAN_ID });
  });
});
