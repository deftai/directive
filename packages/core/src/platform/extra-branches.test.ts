import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractIssueNumbers,
  findFirstTerm,
  findManagedOpenMarker,
  indexOfIgnoreCase,
  isEntryBulletLine,
  parseManagedOpenMarker,
  parseSectionHeader,
  parseSubsectionHeader,
  wordBoundaryMatch,
} from "./linear-scan.js";
import { resolveVersion } from "./resolve-version.js";
import { normalizeSlug } from "./slug-normalize.js";

function readManifestFromFile(base: string): string | null {
  const text = readFileSync(join(base, "VERSION"), "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("tag:") || trimmed.startsWith("ref:")) {
      let value = trimmed.slice(trimmed.indexOf(":") + 1).trim();
      if (
        (value.startsWith("'") && value.endsWith("'")) ||
        (value.startsWith('"') && value.endsWith('"'))
      ) {
        value = value.slice(1, -1);
      }
      if (value.startsWith("v")) value = value.slice(1);
      return value.trim() || null;
    }
  }
  return null;
}

describe("linear-scan and slug edge branches", () => {
  it("findFirstTerm returns earliest match", () => {
    const hit = findFirstTerm("hello world", ["world", "hello"], 0);
    expect(hit?.term.toLowerCase()).toBe("hello");
    expect(indexOfIgnoreCase("AbC", "bc", 0)).toBe(1);
    expect(parseManagedOpenMarker("<!-- not managed -->", 0)).toBeNull();
    expect(findManagedOpenMarker("<!-- deft:managed-section v2 -->", 0)?.version).toBe(2);
    expect(parseManagedOpenMarker("<!-- deft:managed-section v9 -->", 0)).toBeNull();
    expect(findManagedOpenMarker("<!-- foo --> <!-- deft:managed-section v1 -->", 0)?.version).toBe(
      1,
    );
    expect(parseSectionHeader("## [open")).toBeNull();
    expect(parseSubsectionHeader("###   ")).toBeNull();
    expect(isEntryBulletLine("* item")).toBe(true);
    expect(isEntryBulletLine("-no-space")).toBe(false);
    expect(extractIssueNumbers("(#)")).toEqual(new Set());
    expect(extractIssueNumbers("(#12)")).toEqual(new Set(["12"]));
    expect(wordBoundaryMatch("magicwand", 0, "magic")).toBe(false);
  });

  it("slug truncates at hyphen boundary", () => {
    expect(normalizeSlug("hello-world-extra-long-title", 12)).toBe("hello-world");
    expect(normalizeSlug("!!! --- ???")).toBe("untitled");
  });

  it("resolveVersion reads quoted manifest tags", () => {
    const root = mkdtempSync(join(tmpdir(), "ver-"));
    writeFileSync(join(root, "VERSION"), "tag: 'v4.5.6'\n", "utf8");
    expect(
      resolveVersion({
        frameworkRoot: root,
        fromEnv: () => null,
        fromManifest: readManifestFromFile,
        fromDeftVersion: () => null,
        fromGit: () => null,
      }),
    ).toBe("4.5.6");
    rmSync(root, { recursive: true, force: true });
  });
});
