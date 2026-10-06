import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CONFIDENCE_SCHEMA_COMPAT_TIP,
  confidenceSchemaShapeChanged,
  readConfidenceSchemaShapeFromText,
} from "./confidence-schema-tip.js";
import { validateVbriefSchema } from "./schema.js";

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "confidence-5385");

function loadFixture(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURE_ROOT, rel), "utf8")) as Record<string, unknown>;
}

describe("Confidence 0.8 compat fixtures (#5385)", () => {
  it("prose Confidence in completed/cancelled/failed/active WARNs with 0 Confidence hard FAIL", () => {
    const cases = [
      "completed/prose-high.xbrief.json",
      "cancelled/prose-medium.xbrief.json",
      "completed/failed-status-noncanonical.xbrief.json",
      "active/prose-and-enum.xbrief.json",
    ];
    for (const rel of cases) {
      const warnings: string[] = [];
      const errors = validateVbriefSchema(loadFixture(rel), rel, warnings);
      expect(
        errors.filter((e) => e.includes("Confidence invalid")),
        rel,
      ).toEqual([]);
      expect(
        warnings.some((w) => w.includes("Confidence-compat")),
        rel,
      ).toBe(true);
    }
  });

  it("exact enum Confidence silent-passes", () => {
    const warnings: string[] = [];
    const errors = validateVbriefSchema(
      loadFixture("active/exact-enum.xbrief.json"),
      "exact-enum.xbrief.json",
      warnings,
    );
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.includes("Confidence-compat"))).toBe(false);
  });

  it("non-string Confidence hard-fails", () => {
    const doc = loadFixture("active/exact-enum.xbrief.json");
    const plan = doc.plan as Record<string, unknown>;
    const narratives = { ...(plan.narratives as Record<string, unknown>), Confidence: 2 };
    const errors = validateVbriefSchema(
      { ...doc, plan: { ...plan, narratives } },
      "non-string.json",
    );
    expect(errors.some((e) => e.includes("Confidence invalid"))).toBe(true);
  });

  it("schema tip fires when Confidence enum is removed", () => {
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
                  Confidence: { type: "string", description: "writers MUST emit high|medium|low" },
                },
              },
            },
          },
        },
      }),
    );
    expect(confidenceSchemaShapeChanged(before, after)).toBe(true);
    expect(CONFIDENCE_SCHEMA_COMPAT_TIP).toContain("migrate:confidence");
  });

  it("fixture corpus is checked in under lifecycle-shaped folders", () => {
    expect(readdirSync(join(FIXTURE_ROOT, "completed")).length).toBeGreaterThan(0);
    expect(readdirSync(join(FIXTURE_ROOT, "cancelled")).length).toBeGreaterThan(0);
    expect(readdirSync(join(FIXTURE_ROOT, "active")).length).toBeGreaterThan(0);
  });
});
