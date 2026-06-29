import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectPreCutover,
  detectPreCutoverLegacy,
  frozenPreCutoverMigrationGuidance,
  isCurrentGeneratedSpecification,
  isDeprecationRedirect,
  isGeneratedSpecificationExport,
  missingLifecycleFolders,
  renderPrecutoverLine,
} from "./precutover.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("precutover helpers", () => {
  it("isDeprecationRedirect accepts both sentinel forms", () => {
    expect(isDeprecationRedirect("<!-- deft:deprecated-redirect -->")).toBe(true);
    expect(isDeprecationRedirect("<!-- Purpose: deprecation redirect -->")).toBe(true);
    expect(isDeprecationRedirect("# real content")).toBe(false);
  });

  it("detectPreCutoverLegacy lists legacy root markdown files", () => {
    const base = mkdtempSync(join(tmpdir(), "precutover-"));
    temps.push(base);
    writeFileSync(join(base, "SPECIFICATION.md"), "# spec\n", "utf8");
    writeFileSync(join(base, "PROJECT.md"), "# project\n", "utf8");
    expect(detectPreCutoverLegacy(base)).toEqual(["SPECIFICATION.md", "PROJECT.md"]);
  });

  it("detectPreCutoverLegacy ignores deprecation redirects", () => {
    const base = mkdtempSync(join(tmpdir(), "precutover-"));
    temps.push(base);
    writeFileSync(join(base, "SPECIFICATION.md"), "<!-- deft:deprecated-redirect -->\n", "utf8");
    expect(detectPreCutoverLegacy(base)).toEqual([]);
  });

  it("detectPreCutoverLegacy does not throw on unreadable markdown files", () => {
    const base = mkdtempSync(join(tmpdir(), "precutover-"));
    temps.push(base);
    const specPath = join(base, "SPECIFICATION.md");
    writeFileSync(specPath, "# spec\n", "utf8");
    if (process.platform !== "win32") {
      chmodSync(specPath, 0o000);
      expect(() => detectPreCutoverLegacy(base)).not.toThrow();
      chmodSync(specPath, 0o644);
    } else {
      expect(detectPreCutoverLegacy(base)).toContain("SPECIFICATION.md");
    }
  });

  it("missingLifecycleFolders reports absent lifecycle dirs", () => {
    const base = mkdtempSync(join(tmpdir(), "precutover-"));
    temps.push(base);
    mkdirSync(join(base, "vbrief"), { recursive: true });
    expect(missingLifecycleFolders(base)).toEqual([
      "proposed",
      "pending",
      "active",
      "completed",
      "cancelled",
    ]);
  });

  it("isGeneratedSpecificationExport requires source vbrief file", () => {
    const base = mkdtempSync(join(tmpdir(), "precutover-"));
    temps.push(base);
    const content =
      "<!-- Purpose: rendered specification -->\n<!-- Source of truth: vbrief/specification.vbrief.json -->\n";
    expect(isGeneratedSpecificationExport(base, content)).toBe(false);
    mkdirSync(join(base, "vbrief"), { recursive: true });
    writeFileSync(
      join(base, "vbrief", "specification.vbrief.json"),
      '{"vBRIEFInfo":{"version":"0.6"},"plan":{"title":"x","status":"running","narratives":{},"items":[]}}',
      "utf8",
    );
    expect(isGeneratedSpecificationExport(base, content)).toBe(true);
  });

  it("isCurrentGeneratedSpecification passes with full lifecycle layout", () => {
    const base = mkdtempSync(join(tmpdir(), "precutover-"));
    temps.push(base);
    for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
      mkdirSync(join(base, "vbrief", folder), { recursive: true });
    }
    writeFileSync(
      join(base, "vbrief", "specification.vbrief.json"),
      '{"vBRIEFInfo":{"version":"0.6"},"plan":{"title":"x","status":"running","narratives":{},"items":[]}}',
      "utf8",
    );
    const content =
      "<!-- Purpose: rendered specification -->\n<!-- Source of truth: vbrief/specification.vbrief.json -->\n";
    expect(isCurrentGeneratedSpecification(base, content)).toBe(true);
  });

  it("detectPreCutover ignores redirect PROJECT.md", () => {
    const base = mkdtempSync(join(tmpdir(), "precutover-"));
    temps.push(base);
    writeFileSync(join(base, "PROJECT.md"), "<!-- Purpose: deprecation redirect -->\n", "utf8");
    expect(detectPreCutover(base)).toEqual({ preCutover: false, reasons: [] });
  });

  it("detectPreCutover flags legacy PROJECT.md", () => {
    const base = mkdtempSync(join(tmpdir(), "precutover-"));
    temps.push(base);
    writeFileSync(join(base, "PROJECT.md"), "# legacy\n", "utf8");
    const result = detectPreCutover(base);
    expect(result.preCutover).toBe(true);
    expect(result.reasons.some((r) => r.includes("PROJECT.md"))).toBe(true);
  });

  it("detectPreCutover aggregates legacy markdown and missing lifecycle reasons", () => {
    const base = mkdtempSync(join(tmpdir(), "precutover-"));
    temps.push(base);
    writeFileSync(join(base, "SPECIFICATION.md"), "# spec\n", "utf8");
    mkdirSync(join(base, "vbrief"), { recursive: true });
    const result = detectPreCutover(base);
    expect(result.preCutover).toBe(true);
    expect(result.reasons.some((r) => r.includes("SPECIFICATION.md"))).toBe(true);
    expect(result.reasons.some((r) => r.includes("lifecycle folder"))).toBe(true);
  });

  it("renderPrecutoverLine prints frozen guidance when pre-cutover", () => {
    const base = mkdtempSync(join(tmpdir(), "precutover-"));
    temps.push(base);
    writeFileSync(join(base, "PROJECT.md"), "# project\n", "utf8");
    const line = renderPrecutoverLine(base);
    expect(line).toContain("Pre-cutover:");
    expect(line).toContain("v0.59.0");
  });

  it("renderPrecutoverLine reports clean state for greenfield layout", () => {
    const base = mkdtempSync(join(tmpdir(), "precutover-"));
    temps.push(base);
    for (const folder of ["proposed", "pending", "active", "completed", "cancelled"]) {
      mkdirSync(join(base, "vbrief", folder), { recursive: true });
    }
    expect(renderPrecutoverLine(base)).toContain("Pre-cutover: none");
  });

  it("frozenPreCutoverMigrationGuidance cites v0.59.0 and #2068", () => {
    const guidance = frozenPreCutoverMigrationGuidance();
    expect(guidance).toContain("v0.59.0");
    expect(guidance).toContain("#2068");
  });
});
