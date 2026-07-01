import { describe, expect, it } from "vitest";
import { isVBriefReferenceType, referenceTypeMatches } from "./reference.js";

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
