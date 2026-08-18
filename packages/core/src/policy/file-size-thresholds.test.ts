import { describe, expect, it } from "vitest";
import {
  FILE_SIZE_IDEAL_LINES,
  FILE_SIZE_RECOMMENDED_LINES,
  FILE_SIZE_REVIEW_TRIGGER_LINES,
  FILE_SIZE_THRESHOLDS,
} from "./file-size-thresholds.js";

describe("file-size-thresholds (#3424)", () => {
  it("is one SoT: bundle fields equal the named exports", () => {
    expect(FILE_SIZE_THRESHOLDS).toEqual({
      idealLines: FILE_SIZE_IDEAL_LINES,
      recommendedLines: FILE_SIZE_RECOMMENDED_LINES,
      reviewTriggerLines: FILE_SIZE_REVIEW_TRIGGER_LINES,
    });
  });

  it("does not restore a hard line cap — review trigger is a number, not a MUST", () => {
    expect(FILE_SIZE_REVIEW_TRIGGER_LINES).toBe(1000);
    expect(FILE_SIZE_IDEAL_LINES).toBeLessThan(FILE_SIZE_RECOMMENDED_LINES);
    expect(FILE_SIZE_RECOMMENDED_LINES).toBeLessThan(FILE_SIZE_REVIEW_TRIGGER_LINES);
  });
});
