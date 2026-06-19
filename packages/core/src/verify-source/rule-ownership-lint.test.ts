import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateRuleOwnership,
  extractSectionBody,
  loadMap,
  parseHeading,
} from "./rule-ownership-lint.js";

function write(path: string, body: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body, "utf8");
}

describe("parseHeading", () => {
  it("parses ATX headings", () => {
    expect(parseHeading("## Code Design")).toEqual([2, "Code Design"]);
    expect(parseHeading("# Title")).toEqual([1, "Title"]);
    expect(parseHeading("not a heading")).toBeNull();
  });
});

describe("extractSectionBody", () => {
  it("returns section body until sibling heading", () => {
    const content = "# Title\n## A\nalpha\n\n## B\nbeta\n";
    expect(extractSectionBody(content, "## A")).toBe("alpha\n");
  });
});

describe("evaluateRuleOwnership", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("exits 0 when ROM rows resolve", () => {
    root = mkdtempSync(join(tmpdir(), "rom-clean-"));
    write(
      join(root, "coding", "coding.md"),
      "# Coding\n\n## Code Design\n\n- ! One responsibility per file/module\n",
    );
    const mapPath = join(root, "conventions", "rule-ownership.json");
    write(
      mapPath,
      JSON.stringify({
        version: 1,
        rules: [
          {
            id: "coding-modularity",
            text: "One responsibility per file/module",
            owner_file: "coding/coding.md",
            owner_section: "## Code Design",
            authority: "MUST",
            last_verified: "2026-04-28",
          },
        ],
      }),
    );
    const result = evaluateRuleOwnership(root, { mapPath, root });
    expect(result.code).toBe(0);
    expect(result.message).toContain("1 row(s)");
  });

  it("exits 1 on section drift", () => {
    root = mkdtempSync(join(tmpdir(), "rom-drift-"));
    write(join(root, "coding", "coding.md"), "# Coding\n\n## Other\n\ntext\n");
    const mapPath = join(root, "conventions", "rule-ownership.json");
    write(
      mapPath,
      JSON.stringify({
        version: 1,
        rules: [
          {
            id: "x",
            text: "missing",
            owner_file: "coding/coding.md",
            owner_section: "## Code Design",
            authority: "MUST",
            last_verified: "d",
          },
        ],
      }),
    );
    const result = evaluateRuleOwnership(root, { mapPath, root });
    expect(result.code).toBe(1);
    expect(result.message).toContain("owner_section");
  });

  it("exits 2 on missing map file", () => {
    root = mkdtempSync(join(tmpdir(), "rom-missing-"));
    const result = evaluateRuleOwnership(root, {
      mapPath: join(root, "missing.json"),
      root,
    });
    expect(result.code).toBe(2);
    expect(result.message).toContain("Error:");
  });

  it("exits 2 on invalid authority", () => {
    root = mkdtempSync(join(tmpdir(), "rom-bad-auth-"));
    const mapPath = join(root, "map.json");
    write(
      mapPath,
      JSON.stringify({
        rules: [
          {
            id: "a",
            text: "t",
            owner_file: "f",
            owner_section: "## S",
            authority: "BAD",
            last_verified: "d",
          },
        ],
      }),
    );
    expect(() => loadMap(mapPath)).toThrow(/invalid authority/);
  });
});
