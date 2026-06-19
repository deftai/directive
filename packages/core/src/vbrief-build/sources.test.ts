import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SAMPLE_PROJECT_MD,
  SAMPLE_ROADMAP_MD,
  SAMPLE_SPEC_MD,
  SAMPLE_SPEC_VBRIEF,
} from "./parity-scenarios.js";
import {
  deriveOverviewNarrative,
  extractTechStack,
  firstProseParagraph,
  parseRoadmapItems,
  resolveRepoUrl,
} from "./sources.js";

describe("parseRoadmapItems", () => {
  it("parses active and completed items", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-sources-"));
    const path = join(root, "ROADMAP.md");
    writeFileSync(path, SAMPLE_ROADMAP_MD, "utf8");
    const { items, completedItems } = parseRoadmapItems(path);
    expect(items[0]?.number).toBe("100");
    expect(completedItems[0]?.number).toBe("50");
    rmSync(root, { recursive: true, force: true });
  });

  it("returns empty for missing file", () => {
    expect(parseRoadmapItems("/nonexistent/ROADMAP.md")).toEqual({
      items: [],
      phaseDescriptions: {},
      completedItems: [],
    });
  });
});

describe("resolveRepoUrl", () => {
  it("resolves repository field and github refs", () => {
    expect(resolveRepoUrl({ vBRIEFInfo: { repository: "owner/repo" } })).toBe(
      "https://github.com/owner/repo",
    );
    expect(
      resolveRepoUrl({
        plan: { references: [{ uri: "https://github.com/acme/widget/issues/1" }] },
      }),
    ).toBe("https://github.com/acme/widget");
  });
});

describe("extractTechStack", () => {
  it("reads bold tech stack line", () => {
    expect(extractTechStack(SAMPLE_PROJECT_MD)).toBe("Python");
  });

  it("captures a ## Tech Stack section that runs to end-of-string", () => {
    // Regression: Python's \Z anchor matches absolute end-of-string. The prior
    // TS port translated it as a literal "Z", so a section with no trailing
    // "\n## " heading and no literal "Z" returned "" instead of the section.
    expect(extractTechStack("## Tech Stack\nRust + TypeScript")).toBe("Rust + TypeScript");
  });

  it("captures a section ending with a trailing newline", () => {
    expect(extractTechStack("## Tech Stack\nRust + TypeScript\n")).toBe("Rust + TypeScript");
  });

  it("stops at the next ## heading and keeps multi-line bodies", () => {
    expect(extractTechStack("## Tech Stack\nRust\n## Next\nmore")).toBe("Rust");
    expect(extractTechStack("## Tech Stack\nRust\nVitest\n")).toBe("Rust\nVitest");
  });
});

describe("firstProseParagraph", () => {
  it("skips headings and picks prose", () => {
    expect(firstProseParagraph(SAMPLE_SPEC_MD)).toBe("A test specification.");
  });
});

describe("deriveOverviewNarrative", () => {
  it("prefers spec overview then spec md placeholder", () => {
    expect(deriveOverviewNarrative(SAMPLE_SPEC_VBRIEF, null, null, 0)).toBe(
      "A test project for migration.",
    );
    expect(deriveOverviewNarrative(null, null, null, 2)).toContain("2 scope item(s)");
    expect(deriveOverviewNarrative(null, null, null, 0)).toContain(
      "Project overview was not auto-derived",
    );
  });
});

describe("roadmap and prose edge cases", () => {
  it("captures phase descriptions and list-only prose", () => {
    const root = mkdtempSync(join(tmpdir(), "vb-src-edge-"));
    writeFileSync(
      join(root, "ROADMAP.md"),
      "## Phase X\n\nDesc line one\n\nDesc line two\n\n- **#9** -- Nine\n",
      "utf8",
    );
    const parsed = parseRoadmapItems(join(root, "ROADMAP.md"));
    expect(parsed.phaseDescriptions["Phase X"]).toContain("Desc line one");
    expect(firstProseParagraph("## H2\n\nPara one.\n\nPara two.\n")).toBe("Para one.");
    expect(firstProseParagraph("- list only\n")).toBe("");
    expect(firstProseParagraph("1. numbered\n\nAfter list.\n")).toBe("After list.");
    rmSync(root, { recursive: true, force: true });
  });
});
