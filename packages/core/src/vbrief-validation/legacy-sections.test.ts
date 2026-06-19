import { describe, expect, it } from "vitest";
import {
  lookupCanonical,
  normalizeTitle,
  parseTopLevelSections,
  partitionSections,
  SPEC_KNOWN_MAPPINGS,
} from "./legacy-sections.js";

describe("legacy-sections", () => {
  it("normalizes titles per #506 D5", () => {
    expect(normalizeTitle("Tech Stack")).toBe("tech stack");
    expect(normalizeTitle("ProblemStatement")).toBe("problem statement");
    expect(normalizeTitle("Branching Strategy\n")).toBe("branching strategy");
  });

  it("parses top-level sections only", () => {
    const content = "## Overview\n\nBody\n\n### Nested\n\nchild\n\n## Goals\n\nG\n";
    const sections = parseTopLevelSections(content);
    expect(sections).toHaveLength(2);
    expect(sections[0]?.[1]).toContain("### Nested");
  });

  it("partitions canonical vs legacy", () => {
    const sections = parseTopLevelSections("## Summary\n\nOverview.\n\n## Mystery\n\nLegacy.\n");
    const [canonical, legacy] = partitionSections(sections, SPEC_KNOWN_MAPPINGS);
    expect(canonical.Overview).toBe("Overview.");
    expect(legacy).toHaveLength(1);
  });

  it("lookup resolves known aliases", () => {
    expect(lookupCanonical("Functional Requirements", SPEC_KNOWN_MAPPINGS)).toBe("Requirements");
    expect(lookupCanonical("Unknown", SPEC_KNOWN_MAPPINGS)).toBeNull();
  });
});
