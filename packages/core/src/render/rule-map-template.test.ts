import { describe, expect, it } from "vitest";
import { TEMPLATE } from "./rule-map-template.js";

describe("rule-map template", () => {
  it("is a non-empty HTML document string", () => {
    expect(typeof TEMPLATE).toBe("string");
    expect(TEMPLATE.length).toBeGreaterThan(1000);
    expect(TEMPLATE).toContain("<!DOCTYPE html>");
    expect(TEMPLATE).toContain("window.DIRECTIVE_DATA");
  });

  it("carries exactly one data-injection token for rule-map.ts to replace", () => {
    const token = "/*__DATA__*/ null";
    const occurrences = TEMPLATE.split(token).length - 1;
    expect(occurrences).toBe(1);
  });

  it("loads no external assets, so it opens self-contained from file://", () => {
    expect(TEMPLATE).not.toMatch(/<script\s+[^>]*src=/i);
    expect(TEMPLATE).not.toMatch(/<link\b/i);
    expect(TEMPLATE).not.toContain("@import");
    expect(TEMPLATE).not.toContain("http://");
    expect(TEMPLATE).not.toContain("https://");
  });
});
