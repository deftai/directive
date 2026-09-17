import { describe, expect, it } from "vitest";
import {
  describeUnknownReservedReferenceType,
  isRecognizedReservedReferenceType,
  isVBriefReferenceType,
  RESERVED_REFERENCE_TYPE_ALIASES,
  referenceTypeMatches,
} from "./reference.js";

describe("referenceTypeMatches", () => {
  it("matches the legacy x-vbrief/ prefix", () => {
    expect(referenceTypeMatches("x-vbrief/plan", "plan")).toBe(true);
    expect(referenceTypeMatches("x-vbrief/github-issue", "github-issue")).toBe(true);
    expect(referenceTypeMatches("x-vbrief/closes", "closes")).toBe(true);
  });

  it("matches the canonical x-xbrief/ prefix", () => {
    expect(referenceTypeMatches("x-xbrief/plan", "plan")).toBe(true);
    expect(referenceTypeMatches("x-xbrief/github-issue", "github-issue")).toBe(true);
    expect(referenceTypeMatches("x-xbrief/closes", "closes")).toBe(true);
  });

  it("does not match an unrelated type", () => {
    expect(referenceTypeMatches("x-vbrief/github-issue", "plan")).toBe(false);
    expect(referenceTypeMatches("x-xbrief/github-issue", "plan")).toBe(false);
    expect(referenceTypeMatches("github-issue", "github-issue")).toBe(false);
    expect(referenceTypeMatches("", "plan")).toBe(false);
  });

  it("does not match a prefix extension of bareType", () => {
    expect(referenceTypeMatches("x-vbrief/plan-extended", "plan")).toBe(false);
    expect(referenceTypeMatches("x-xbrief/plan-extra", "plan")).toBe(false);
  });
});

describe("isVBriefReferenceType", () => {
  it("accepts x-vbrief/ types", () => {
    expect(isVBriefReferenceType("x-vbrief/plan")).toBe(true);
    expect(isVBriefReferenceType("x-vbrief/github-issue")).toBe(true);
  });

  it("accepts x-xbrief/ types", () => {
    expect(isVBriefReferenceType("x-xbrief/plan")).toBe(true);
    expect(isVBriefReferenceType("x-xbrief/github-issue")).toBe(true);
  });

  it("rejects unrecognized types", () => {
    expect(isVBriefReferenceType("github-issue")).toBe(false);
    expect(isVBriefReferenceType("")).toBe(false);
  });
});

describe("reserved reference type aliases (#4698)", () => {
  it("maps pull-request and github-pull-request to github-pr", () => {
    expect(RESERVED_REFERENCE_TYPE_ALIASES["pull-request"]).toBe("github-pr");
    expect(RESERVED_REFERENCE_TYPE_ALIASES["github-pull-request"]).toBe("github-pr");
  });
});

describe("isRecognizedReservedReferenceType (#4698)", () => {
  it("accepts github-pr from the conventions registry", () => {
    expect(isRecognizedReservedReferenceType("x-xbrief/github-pr")).toBe(true);
    expect(isRecognizedReservedReferenceType("x-vbrief/github-pr")).toBe(true);
  });

  it("accepts engine-written closes and current-shape omitted from KNOWN", () => {
    expect(isRecognizedReservedReferenceType("x-xbrief/closes")).toBe(true);
    expect(isRecognizedReservedReferenceType("x-xbrief/current-shape")).toBe(true);
    expect(isRecognizedReservedReferenceType("x-xbrief/blocks")).toBe(true);
    expect(isRecognizedReservedReferenceType("x-xbrief/refs")).toBe(true);
  });

  it("does not treat KNOWN as the only closed set by rejecting pull-request", () => {
    expect(isRecognizedReservedReferenceType("x-xbrief/pull-request")).toBe(false);
  });
});

describe("describeUnknownReservedReferenceType (#4698)", () => {
  it("reports pull-request with nearest canonical github-pr", () => {
    expect(describeUnknownReservedReferenceType("x-xbrief/pull-request")).toEqual({
      type: "x-xbrief/pull-request",
      subtype: "pull-request",
      nearestCanonical: "x-xbrief/github-pr",
    });
  });

  it("does not report github-pr", () => {
    expect(describeUnknownReservedReferenceType("x-xbrief/github-pr")).toBeNull();
  });

  it("does not report engine-written closes or current-shape", () => {
    expect(describeUnknownReservedReferenceType("x-xbrief/closes")).toBeNull();
    expect(describeUnknownReservedReferenceType("x-xbrief/current-shape")).toBeNull();
  });

  it("does not close consumer x-* namespaces", () => {
    expect(describeUnknownReservedReferenceType("x-myapp/ticket")).toBeNull();
  });
});
