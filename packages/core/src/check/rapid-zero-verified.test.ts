import { describe, expect, it } from "vitest";
import {
  acceptanceWalkReportsZeroVerified,
  rapidCheckRejectsZeroVerifiedWalk,
  scopeCompleteRejectsZeroVerifiedWalk,
} from "./rapid-zero-verified.js";

const ZERO_WALK =
  "verify:ac clause walk (#3323): 0 verified, 5 unverifiable, 0 failed\n" +
  "verify:ac passed (#3284) (0 verified, 5 unverifiable) [rung=derived]\n";

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
