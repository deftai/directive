import { describe, expect, it } from "vitest";
import {
  CONFIDENCE_SCHEMA_COMPAT_TIP,
  confidenceSchemaShapeChanged,
  readConfidenceSchemaShapeFromText,
} from "./confidence-schema-tip.js";

describe("confidence-schema-tip (#5385)", () => {
  it("detects enum removal as a Confidence schema shape change", () => {
    const before = readConfidenceSchemaShapeFromText(
      JSON.stringify({
        $defs: {
          Plan: {
            properties: {
              narratives: {
                properties: {
                  Confidence: { type: "string", enum: ["high", "medium", "low"] },
                },
              },
            },
          },
        },
      }),
    );
    const after = readConfidenceSchemaShapeFromText(
      JSON.stringify({
        $defs: {
          Plan: {
            properties: {
              narratives: {
                properties: {
                  Confidence: { type: "string" },
                },
              },
            },
          },
        },
      }),
    );
    expect(before.hasEnum).toBe(true);
    expect(after.hasEnum).toBe(false);
    expect(confidenceSchemaShapeChanged(before, after)).toBe(true);
    expect(confidenceSchemaShapeChanged(after, after)).toBe(false);
    expect(CONFIDENCE_SCHEMA_COMPAT_TIP).toContain("migrate:confidence");
  });

  it("returns absent shape for invalid JSON", () => {
    expect(readConfidenceSchemaShapeFromText("not-json")).toEqual({
      present: false,
      type: null,
      hasEnum: false,
    });
  });
});
