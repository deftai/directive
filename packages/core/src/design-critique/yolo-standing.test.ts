import { describe, expect, it } from "vitest";
import {
  parseOperatorYoloStanding,
  YOLO_STANDING_FIELD,
  yoloStandingAdmitsEmptyOrFootnoteCensus,
  yoloStandingRecordLine,
} from "./yolo-standing.js";

describe("parseOperatorYoloStanding (#5111)", () => {
  it("defaults bare arc standing on", () => {
    expect(parseOperatorYoloStanding("arc 5111")).toEqual({
      kind: "resolved",
      standing: true,
      source: "default",
    });
    expect(parseOperatorYoloStanding("1 github-only")).toEqual({
      kind: "resolved",
      standing: true,
      source: "default",
    });
    expect(parseOperatorYoloStanding("looks good")).toEqual({
      kind: "resolved",
      standing: true,
      source: "default",
    });
  });

  it("resolves closed yolo as standing on", () => {
    expect(parseOperatorYoloStanding("arc 4293 yolo and label")).toEqual({
      kind: "resolved",
      standing: true,
      source: "yolo",
    });
    expect(parseOperatorYoloStanding("arc 5111 no-ingest yolo")).toEqual({
      kind: "resolved",
      standing: true,
      source: "yolo",
    });
  });

  it("does not match yolo inside longer words", () => {
    expect(parseOperatorYoloStanding("yoloing")).toEqual({
      kind: "resolved",
      standing: true,
      source: "default",
    });
  });

  it("clears standing on closed noyolo", () => {
    expect(parseOperatorYoloStanding("arc 5111 noyolo")).toEqual({
      kind: "resolved",
      standing: false,
      source: "noyolo",
    });
    expect(parseOperatorYoloStanding("arc 5111 no-ingest noyolo n=1")).toEqual({
      kind: "resolved",
      standing: false,
      source: "noyolo",
    });
  });

  it("asks when yolo and noyolo collide", () => {
    expect(parseOperatorYoloStanding("arc 5111 yolo noyolo")).toEqual({
      kind: "ask",
      reason: "ambiguous",
    });
  });

  it("emits Stop 1 record lines", () => {
    expect(yoloStandingRecordLine(true)).toBe("yolo-standing: yes");
    expect(yoloStandingRecordLine(false)).toBe("yolo-standing: no");
    expect(YOLO_STANDING_FIELD).toBe("yolo-standing:");
  });

  it("never admits empty-(a) / footnote-only / LGTM (#5488)", () => {
    expect(yoloStandingAdmitsEmptyOrFootnoteCensus(true)).toBe(false);
    expect(yoloStandingAdmitsEmptyOrFootnoteCensus(false)).toBe(false);
  });
});
