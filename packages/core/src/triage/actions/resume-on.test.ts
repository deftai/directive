import { describe, expect, it } from "vitest";
import { ResumeGrammarError } from "./errors.js";
import { parseResumeOn } from "./resume-on.js";

describe("parseResumeOn", () => {
  it("accepts AND composition", () => {
    expect(() => parseResumeOn("ref:closed:#1 AND pending-count:>=3")).not.toThrow();
  });

  it("accepts OR composition", () => {
    expect(() => parseResumeOn("ref:merged:#2 OR date:>=2026-01-01")).not.toThrow();
  });

  it("rejects empty expression", () => {
    expect(() => parseResumeOn("   ")).toThrow(ResumeGrammarError);
  });

  it("rejects invalid date atom", () => {
    expect(() => parseResumeOn("date:>=2026-13-40")).toThrow(/invalid date/);
  });

  it("rejects slice wave below 1", () => {
    expect(() => parseResumeOn("slice-wave-ready:11111111-1111-1111-1111-111111111111:0")).toThrow(
      /positive int/,
    );
  });

  it("rejects mixed AND/OR composition", () => {
    expect(() => parseResumeOn("ref:closed:#1 AND ref:closed:#2 OR ref:closed:#3")).toThrow(
      /single top-level AND\/OR/,
    );
  });

  it("accepts pending-count atoms", () => {
    expect(() => parseResumeOn("pending-count:<=3")).not.toThrow();
    expect(() => parseResumeOn("pending-count:>=1")).not.toThrow();
  });

  it("accepts ref:merged atom", () => {
    expect(() => parseResumeOn("ref:merged:#12")).not.toThrow();
  });

  it("accepts slice-wave-ready atom", () => {
    expect(() =>
      parseResumeOn("slice-wave-ready:11111111-1111-1111-1111-111111111111:2"),
    ).not.toThrow();
  });
});
