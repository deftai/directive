import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, readRepoFile } from "./helpers.js";

/**
 * #2907 — xbrief is the sole public canonical work-state name in current
 * product guidance. vBRIEF may appear only when labeled legacy/historical
 * or on migrate/archive surfaces.
 */

const PUBLIC_GUIDANCE_REL = [
  "docs/CONCEPTS.md",
  "docs/ARCHITECTURE.md",
  "README.md",
  "content/docs/getting-started.md",
  "content/glossary.md",
  "content/UPGRADING.md",
] as const;

function readRoot(rel: string): string {
  if (rel.startsWith("content/")) {
    return readRepoFile(rel.slice("content/".length));
  }
  const abs = join(REPO_ROOT, rel);
  expect(existsSync(abs), `missing ${rel}`).toBe(true);
  return readFileSync(abs, "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Lines that still teach vBRIEF/vbrief as present-day work-state without legacy framing. */
function currentGuidanceVbriefHits(text: string, rel: string): string[] {
  const hits: string[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!/vBRIEF|vbrief/.test(line)) continue;
    // Allow explicitly legacy / historical / migrate / alias framing
    if (
      /legacy|historical|history|migrate:vbrief|migrate:xbrief|deprecated|back-compat|backcompat|alias|rename|#2034|#2110|#2907|x-vbrief|schema lineage|schema-lineage|schema detail|schema package|read-accepted|until you run|until `deft migrate/i.test(
        line,
      )
    ) {
      continue;
    }
    // Shipped Taskfile/CLI ids still use vbrief:validate / --vbrief-path even when product prose says xBRIEF.
    if (/task vbrief:|vbrief:validate|vbrief:preflight|--vbrief-path|verify:vbrief/.test(line)) {
      continue;
    }
    // Schema package still lives under content/vbrief/ (historical path); links are not current product naming.
    if (
      /vbrief\/vbrief\.md|content\/vbrief\/|vbrief\/schemas\//.test(line) &&
      !/\bvbrief\/(?:proposed|pending|active)\//.test(line)
    ) {
      continue;
    }
    // Table header row in UPGRADING that maps Legacy → Current is OK
    if (rel.includes("UPGRADING") && /Legacy \(historical\)|Current public canon/.test(line)) {
      continue;
    }
    hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 160)}`);
  }
  return hits;
}

describe("xbrief_public_canon #2907", () => {
  it("public_guidance_files_exist", () => {
    for (const rel of PUBLIC_GUIDANCE_REL) {
      if (rel.startsWith("content/")) {
        expect(existsSync(join(REPO_ROOT, "content", rel.slice("content/".length)))).toBe(true);
      } else {
        expect(existsSync(join(REPO_ROOT, rel))).toBe(true);
      }
    }
  });

  it("concepts_and_architecture_teach_xbrief_not_vbrief_as_current", () => {
    const concepts = readRoot("docs/CONCEPTS.md");
    const arch = readRoot("docs/ARCHITECTURE.md");
    for (const text of [concepts, arch]) {
      expect(text).toMatch(/xBRIEF/i);
      expect(text).toContain("xbrief/");
      expect(text).toContain("#2907");
    }
    expect(concepts).toMatch(/xBRIEF Is The Durable State/i);
    expect(currentGuidanceVbriefHits(concepts, "docs/CONCEPTS.md")).toEqual([]);
    expect(currentGuidanceVbriefHits(arch, "docs/ARCHITECTURE.md")).toEqual([]);
  });

  it("readme_current_paths_are_xbrief", () => {
    const readme = readRoot("README.md");
    expect(readme).toContain("xbrief/PROJECT-DEFINITION.xbrief.json");
    expect(readme).toContain("xbrief/proposed/");
    expect(readme).toContain("scope xBRIEF");
    expect(readme).not.toContain("vbrief/PROJECT-DEFINITION.vbrief.json");
    expect(readme).not.toContain("vbrief/proposed/");
    expect(currentGuidanceVbriefHits(readme, "README.md")).toEqual([]);
  });

  it("glossary_and_upgrading_carry_legacy_map", () => {
    const glossary = readRoot("content/glossary.md");
    const upgrading = readRoot("content/UPGRADING.md");
    expect(glossary).toContain("xBRIEF Lifecycle Terms");
    expect(glossary).toMatch(/vBRIEF \(legacy\)/);
    expect(upgrading).toContain("xBRIEF rename");
    expect(upgrading).toContain("#2907");
    expect(upgrading).toContain("deft migrate:xbrief");
    expect(upgrading).toMatch(/sole public|public canon|Public product voice uses \*\*xBRIEF\*\*/i);
    expect(currentGuidanceVbriefHits(glossary, "content/glossary.md")).toEqual([]);
    // UPGRADING retains historical version notes that mention vbrief paths by design;
    // the authoritative rename section must state public canon + legacy map (#2907).
    const renameIdx = upgrading.indexOf("xBRIEF rename");
    expect(renameIdx).toBeGreaterThanOrEqual(0);
    const renameSection = upgrading.slice(renameIdx, renameIdx + 2500);
    expect(renameSection).toContain("legacy");
    expect(renameSection).toContain("xbrief/");
    expect(renameSection).toContain("vbrief/");
  });

  it("getting_started_uses_xbrief_lifecycle", () => {
    const gs = readRoot("content/docs/getting-started.md");
    expect(gs).toContain("xbrief/");
    expect(gs).toMatch(/xBRIEF/i);
    expect(currentGuidanceVbriefHits(gs, "content/docs/getting-started.md")).toEqual([]);
  });
});
