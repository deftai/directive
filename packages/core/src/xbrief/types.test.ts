import { describe, expect, it } from "vitest";
import {
  DEFAULT_XBRIEF_SIZE_CAP_BYTES,
  isXbriefFormat,
  isXbriefStyle,
  XBRIEF_FORMATS,
  XBRIEF_STYLES,
} from "./types.js";

describe("xbrief types (#3057)", () => {
  it("recognizes formats and styles", () => {
    for (const f of XBRIEF_FORMATS) expect(isXbriefFormat(f)).toBe(true);
    for (const s of XBRIEF_STYLES) expect(isXbriefStyle(s)).toBe(true);
    expect(isXbriefFormat("yaml")).toBe(false);
    expect(isXbriefStyle("epic")).toBe(false);
    expect(DEFAULT_XBRIEF_SIZE_CAP_BYTES).toBeGreaterThan(0);
  });
});
