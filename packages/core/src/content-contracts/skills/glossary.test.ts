import { describe, expect, it } from "vitest";
import { readRepoFile, repoFileExists } from "./helpers.js";

/** Port of tests/content/test_glossary.py (#1838 #457); xbrief public canon (#2907) */

const REQUIRED_TERMS = [
  "Scope xBRIEF",
  "Lifecycle folder",
  "Plan-level narrative",
  "Item-level narrative",
  "Filename stem",
  "Cross-scope dependency",
  "Exit Commands",
  "Origin provenance",
  "Canonical narrative key",
  "Preparatory strategy",
  "Spec-generating strategy",
  "Rendered export",
  "Source of truth",
];

const glossaryText = readRepoFile("glossary.md");

describe("test_glossary", () => {
  describe("TestGlossaryFile", () => {
    it("glossary_exists", () => {
      expect(repoFileExists("glossary.md")).toBe(true);
    });

    it("glossary_under_150_lines", () => {
      const lineCount = glossaryText.split("\n").length;
      expect(lineCount).toBeLessThan(150);
    });

    it("glossary_has_rfc2119_legend", () => {
      expect(glossaryText.includes("RFC2119") || glossaryText.includes("RFC 2119")).toBe(true);
      expect(glossaryText).toContain("!=MUST");
      expect(glossaryText).toContain("\u2297=MUST NOT");
    });
  });

  describe("TestGlossaryTerms", () => {
    it("all_13_terms_present", () => {
      const missing = REQUIRED_TERMS.filter((t) => !glossaryText.includes(`**${t}**`));
      expect(missing).toEqual([]);
    });

    it("every_term_has_authoritative_cross_link", () => {
      for (const term of REQUIRED_TERMS) {
        const anchor = `**${term}**`;
        const idx = glossaryText.indexOf(anchor);
        expect(idx).not.toBe(-1);
        const remainder = glossaryText.slice(idx);
        const stop = remainder.indexOf("\n- **", 1);
        const block = stop === -1 ? remainder : remainder.slice(0, stop);
        expect(block).toContain("](");
      }
    });

    it("lifecycle_terms_use_xbrief_public_canon", () => {
      expect(glossaryText).toContain("## xBRIEF Lifecycle Terms");
      expect(glossaryText).toContain("xbrief/");
      expect(glossaryText).toContain(".xbrief.json");
      expect(glossaryText).toMatch(/\*\*vBRIEF \(legacy\)\*\*/);
      expect(glossaryText).toContain("#2907");
      // Current-guidance term names must not keep Scope vBRIEF as the bold canon
      expect(glossaryText).not.toContain("**Scope vBRIEF**");
    });
  });

  describe("TestGlossaryCrossReferences", () => {
    it("vbrief_md_links_to_glossary", () => {
      expect(readRepoFile("vbrief/vbrief.md")).toContain("glossary.md");
    });

    it("readme_links_to_glossary", () => {
      expect(readRepoFile("README.md")).toContain("glossary.md");
    });

    it("upgrading_md_links_to_glossary", () => {
      expect(readRepoFile("UPGRADING.md")).toContain("glossary.md");
    });
  });
});
