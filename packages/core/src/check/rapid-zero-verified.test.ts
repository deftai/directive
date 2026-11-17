import { describe, expect, it } from "vitest";
import {
  acceptanceWalkReportsZeroVerified,
  parseJustCompletedWalkTarget,
  rapidCheckRejectsZeroVerifiedWalk,
  scopeCompleteRejectsZeroVerifiedWalk,
} from "./rapid-zero-verified.js";
import type { CollectedChangeSet } from "./session-completed-ac.js";

const ZERO_WALK =
  "verify:ac clause walk (#3323): 0 verified, 5 unverifiable, 0 failed\n" +
  "verify:ac passed (#3284) (0 verified, 5 unverifiable) [rung=derived]\n";

/** #6374: the zero-verified green lead no longer says "passed". */
const NO_EVIDENCE_LEAD =
  "verify:ac: no acceptance evidence yet (#3284) (0 verified, 5 unverifiable) [rung=derived]";

const NO_EVIDENCE_WALK =
  "verify:ac clause walk (#3323): 0 verified, 5 unverifiable, 0 failed\n" + `${NO_EVIDENCE_LEAD}\n`;

describe("zero-verified detector reads the #6374 no-evidence lead", () => {
  it("matches the new lead alone, as quiet output shows only the first line", () => {
    expect(acceptanceWalkReportsZeroVerified(NO_EVIDENCE_LEAD)).toBe(true);
    expect(
      acceptanceWalkReportsZeroVerified(
        "verify:ac: no acceptance evidence yet (#3284) served_from=cache (0 verified, 1 unverifiable) [rung=derived]",
      ),
    ).toBe(true);
    expect(acceptanceWalkReportsZeroVerified(NO_EVIDENCE_WALK)).toBe(true);
  });

  it("does not match the new words without a zero-verified count", () => {
    expect(
      acceptanceWalkReportsZeroVerified("verify:ac: no acceptance evidence yet (#3284) [rung=x]"),
    ).toBe(false);
  });

  it("gives rapid check (#4866) the same refusal as for the old lead", () => {
    for (const text of [NO_EVIDENCE_LEAD, NO_EVIDENCE_WALK, ZERO_WALK]) {
      expect(rapidCheckRejectsZeroVerifiedWalk({ mode: "rapid", gateId: "verify:ac", text })).toBe(
        true,
      );
    }
    expect(
      rapidCheckRejectsZeroVerifiedWalk({
        mode: "full",
        gateId: "verify:ac",
        text: NO_EVIDENCE_LEAD,
      }),
    ).toBe(false);
  });

  it("gives scope:complete (#4870) the same result as for the old lead", () => {
    for (const predicate of ["empty-pass", "unclassified", "executable-pass"]) {
      expect(scopeCompleteRejectsZeroVerifiedWalk({ text: NO_EVIDENCE_LEAD, predicate })).toBe(
        scopeCompleteRejectsZeroVerifiedWalk({ text: ZERO_WALK, predicate }),
      );
    }
    expect(
      scopeCompleteRejectsZeroVerifiedWalk({ text: NO_EVIDENCE_LEAD, predicate: "empty-pass" }),
    ).toBe(true);
  });
});

describe("acceptanceWalkReportsZeroVerified (#4866)", () => {
  it("matches a zero-verified clause walk and pass lead", () => {
    expect(acceptanceWalkReportsZeroVerified(ZERO_WALK)).toBe(true);
    expect(
      acceptanceWalkReportsZeroVerified(
        "verify:ac clause walk (#3323): 0 verified, 2 unverifiable, 0 failed",
      ),
    ).toBe(true);
    expect(
      acceptanceWalkReportsZeroVerified(
        "verify:ac passed (#3284) (0 verified, 2 unverifiable) [rung=derived]",
      ),
    ).toBe(true);
    expect(
      acceptanceWalkReportsZeroVerified(
        "verify:ac passed (#3284) served_from=cache (0 verified, 1 unverifiable) [rung=derived]",
      ),
    ).toBe(true);
  });

  it("does not match a positive count, a tens count, or a clause-less pass", () => {
    expect(
      acceptanceWalkReportsZeroVerified(
        "verify:ac passed (#3284) (1 verified, 0 unverifiable) [rung=derived]",
      ),
    ).toBe(false);
    expect(
      acceptanceWalkReportsZeroVerified(
        "verify:ac clause walk (#3323): 10 verified, 0 unverifiable, 0 failed",
      ),
    ).toBe(false);
    expect(
      acceptanceWalkReportsZeroVerified(
        "verify:ac passed (#3284) (10 verified, 0 unverifiable) [rung=derived]",
      ),
    ).toBe(false);
    expect(acceptanceWalkReportsZeroVerified("verify:ac passed (#3284) [rung=derived]")).toBe(
      false,
    );
    expect(
      acceptanceWalkReportsZeroVerified(
        "verify:ac soft_empty (#3334) [rung=project_floor]: no acceptance stamped",
      ),
    ).toBe(false);
  });
});

describe("rapidCheckRejectsZeroVerifiedWalk (#4866)", () => {
  it("rejects only a rapid product-AC gate whose walk reports zero verified", () => {
    expect(
      rapidCheckRejectsZeroVerifiedWalk({
        mode: "rapid",
        gateId: "verify:ac",
        text: ZERO_WALK,
      }),
    ).toBe(true);
    expect(
      rapidCheckRejectsZeroVerifiedWalk({
        mode: "rapid",
        gateId: "verify:literal-ac",
        text: ZERO_WALK,
      }),
    ).toBe(true);
  });

  it("does not treat unverifiable rows as a verify:ac failure outside that rapid check", () => {
    expect(
      rapidCheckRejectsZeroVerifiedWalk({
        mode: "full",
        gateId: "verify:ac",
        text: ZERO_WALK,
      }),
    ).toBe(false);
    expect(
      rapidCheckRejectsZeroVerifiedWalk({
        mode: "pressure",
        gateId: "verify:ac",
        text: ZERO_WALK,
      }),
    ).toBe(false);
    expect(
      rapidCheckRejectsZeroVerifiedWalk({
        mode: "rapid",
        gateId: "verify:branch",
        text: ZERO_WALK,
      }),
    ).toBe(false);
    expect(
      rapidCheckRejectsZeroVerifiedWalk({
        mode: "rapid",
        gateId: "verify:ac",
        text: "verify:ac passed (#3284) (1 verified, 4 unverifiable) [rung=derived]",
      }),
    ).toBe(false);
    expect(
      rapidCheckRejectsZeroVerifiedWalk({
        mode: "rapid",
        gateId: "verify:ac",
        text: "verify:ac passed (#3284) [rung=stated]",
      }),
    ).toBe(false);
  });
});

describe("scopeCompleteRejectsZeroVerifiedWalk (#4870)", () => {
  it("refuses a zero-verified print when the walk was not executable-pass", () => {
    expect(
      scopeCompleteRejectsZeroVerifiedWalk({
        text: ZERO_WALK,
        predicate: "empty-pass",
      }),
    ).toBe(true);
    expect(
      scopeCompleteRejectsZeroVerifiedWalk({
        text: ZERO_WALK,
        predicate: "unclassified",
      }),
    ).toBe(true);
  });

  it("keeps #3497 executable-pass and non-zero walks allowed", () => {
    expect(
      scopeCompleteRejectsZeroVerifiedWalk({
        text: ZERO_WALK,
        predicate: "executable-pass",
      }),
    ).toBe(false);
    expect(
      scopeCompleteRejectsZeroVerifiedWalk({
        text: "verify:ac passed (#3284) (1 verified, 4 unverifiable) [rung=derived]",
        predicate: "empty-pass",
      }),
    ).toBe(false);
  });
});

describe("in-diff completed overlay (#5477)", () => {
  const ZERO_WITH_TARGET =
    "verify:ac targeting just-completed brief (#3357): xbrief/completed/done.xbrief.json\n" +
    ZERO_WALK;

  function lifeOnlyCompleted(): CollectedChangeSet {
    return {
      ok: true,
      paths: ["xbrief/completed/done.xbrief.json", "CHANGELOG.md"],
      flagsByPath: new Map([
        ["xbrief/completed/done.xbrief.json", { addedOrRenamed: true, addedOrModified: true }],
        ["CHANGELOG.md", { addedOrRenamed: false, addedOrModified: true }],
      ]),
    };
  }

  it("parses the just-completed targeting line", () => {
    expect(parseJustCompletedWalkTarget(ZERO_WITH_TARGET)).toBe(
      "xbrief/completed/done.xbrief.json",
    );
  });

  it("does not reject an in-diff completed lifecycle-only walk", () => {
    expect(
      rapidCheckRejectsZeroVerifiedWalk({
        mode: "rapid",
        gateId: "verify:ac",
        text: ZERO_WITH_TARGET,
        projectRoot: "/repo",
        changeSet: lifeOnlyCompleted(),
      }),
    ).toBe(false);
  });

  it("still rejects when an unmatched product path is in the set", () => {
    const mixed: CollectedChangeSet = {
      ok: true,
      paths: ["xbrief/completed/done.xbrief.json", "src/service.ts"],
      flagsByPath: new Map([
        ["xbrief/completed/done.xbrief.json", { addedOrRenamed: true, addedOrModified: true }],
        ["src/service.ts", { addedOrRenamed: false, addedOrModified: true }],
      ]),
    };
    expect(
      rapidCheckRejectsZeroVerifiedWalk({
        mode: "rapid",
        gateId: "verify:ac",
        text: ZERO_WITH_TARGET,
        projectRoot: "/repo",
        changeSet: mixed,
      }),
    ).toBe(true);
  });

  it("waives for lifecycle-only out-of-diff walks (skip-targeting)", () => {
    const text =
      "verify:ac targeting just-completed brief (#3357): xbrief/completed/done.xbrief.json\n" +
      ZERO_WALK;
    const lifeOnly: CollectedChangeSet = {
      ok: true,
      paths: [".deft/plan-sequence.json", "CHANGELOG.md"],
      flagsByPath: new Map([
        [".deft/plan-sequence.json", { addedOrRenamed: false, addedOrModified: true }],
        ["CHANGELOG.md", { addedOrRenamed: false, addedOrModified: true }],
      ]),
    };
    expect(
      rapidCheckRejectsZeroVerifiedWalk({
        mode: "rapid",
        gateId: "verify:ac",
        text,
        projectRoot: "/repo",
        changeSet: lifeOnly,
      }),
    ).toBe(false);
  });

  it("parses a spaced checkout path from the targeting line", () => {
    const text =
      "verify:ac targeting just-completed brief (#3357): /home/user/My Project/xbrief/completed/done.xbrief.json\n" +
      ZERO_WALK;
    expect(parseJustCompletedWalkTarget(text)).toBe(
      "/home/user/My Project/xbrief/completed/done.xbrief.json",
    );
    const lifeOnly: CollectedChangeSet = {
      ok: true,
      paths: ["xbrief/completed/done.xbrief.json", "CHANGELOG.md"],
      flagsByPath: new Map([
        ["xbrief/completed/done.xbrief.json", { addedOrRenamed: true, addedOrModified: true }],
        ["CHANGELOG.md", { addedOrRenamed: false, addedOrModified: true }],
      ]),
    };
    expect(
      rapidCheckRejectsZeroVerifiedWalk({
        mode: "rapid",
        gateId: "verify:ac",
        text,
        projectRoot: "/home/user/My Project",
        changeSet: lifeOnly,
      }),
    ).toBe(false);
  });

  it("honors an injected executable-pass overlay flag", () => {
    expect(
      rapidCheckRejectsZeroVerifiedWalk({
        mode: "rapid",
        gateId: "verify:ac",
        text: ZERO_WALK,
        inDiffCompletedExecutablePass: true,
      }),
    ).toBe(false);
  });
});
