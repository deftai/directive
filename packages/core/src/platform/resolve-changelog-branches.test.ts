import { describe, expect, it } from "vitest";
import {
  contentPrefix,
  isOrphanHeader,
  resolveChangelog,
  unionMerge,
} from "./resolve-changelog-unreleased.js";

const ORPHAN_STUB = "- **feat(scripts): `gh_rest.py` REST-fallback helpers";
const VALID_GH_REST =
  "- **feat(scripts): `gh_rest.py` REST-fallback helpers** -- canonical (#1003)";

const HEADER =
  "# Changelog\n\nAll notable changes to this project will be documented in this file.\n\n";

function build(body: string): string {
  return `${HEADER}## [Unreleased]\n\n${body}\n## [0.1.0] - 2026-01-01\n`;
}

describe("resolveChangelog branch scenarios", () => {
  it("head-only entries resolve cleanly", () => {
    const body =
      "### Added\n" +
      "<<<<<<< HEAD\n" +
      "- entry from master (#100)\n" +
      "- second entry from master (#101)\n" +
      "=======\n" +
      ">>>>>>> abc1234\n\n" +
      "### Fixed\n" +
      "- existing fixed entry (#50)\n";
    const { content, message } = resolveChangelog(build(body));
    expect(content).not.toContain("<<<<<<<");
    expect(content).toContain("(#100)");
    expect(message).toContain("resolved");
  });

  it("branch-only entry prepends when head empty", () => {
    const body =
      "### Added\n" +
      "<<<<<<< HEAD\n" +
      "=======\n" +
      "- new entry from branch (#911)\n" +
      ">>>>>>> deadbeef\n";
    const { content } = resolveChangelog(build(body));
    expect(content).toContain("(#911)");
  });

  it("union prepends branch above head", () => {
    const body =
      "### Added\n" +
      "<<<<<<< HEAD\n" +
      "- master entry (#100)\n" +
      "=======\n" +
      "- branch entry (#911)\n" +
      ">>>>>>> sha1\n";
    const { content } = resolveChangelog(build(body));
    expect(content).not.toBeNull();
    if (content) {
      expect(content.indexOf("(#911)")).toBeLessThan(content.indexOf("(#100)"));
    }
  });

  it("multi-section conflict merges independently", () => {
    const body =
      "<<<<<<< HEAD\n" +
      "### Added\n" +
      "- master added (#100)\n\n" +
      "### Fixed\n" +
      "- master fixed (#200)\n" +
      "=======\n" +
      "### Added\n" +
      "- branch added (#911)\n\n" +
      "### Fixed\n" +
      "- branch fixed (#912)\n" +
      ">>>>>>> sha1\n";
    const { content } = resolveChangelog(build(body));
    expect(content).toContain("(#911)");
    expect(content).toContain("(#912)");
    expect(content).toContain("(#100)");
    expect(content).toContain("(#200)");
  });

  it("rejects malformed nested conflict markers", () => {
    const body = "### Added\n<<<<<<< HEAD\n<<<<<<< nested\n=======\n>>>>>>> x\n";
    const { content } = resolveChangelog(build(body));
    expect(content).toBeNull();
  });

  it("rejects orphan separator without head", () => {
    const body = "### Added\n=======\n- x (#1)\n";
    const { content } = resolveChangelog(build(body));
    expect(content).toBeNull();
  });

  it("drops orphan headers during union merge", () => {
    expect(isOrphanHeader(ORPHAN_STUB)).toBe(true);
    expect(contentPrefix("- **FEAT:   Spaced   Out**")).toBe("feat: spaced out");
    const warnings: string[] = [];
    const merged = unionMerge(
      [["Added", [ORPHAN_STUB, VALID_GH_REST]]],
      [["Added", [ORPHAN_STUB, "- branch new entry (#999)"]]],
      warnings,
    );
    const flat = merged.flatMap(([, entries]) => entries).join("\n");
    expect(flat).toContain("(#999)");
    expect(flat).toContain("(#1003)");
    expect(flat.split("\n").includes(ORPHAN_STUB)).toBe(false);
    expect(warnings.length).toBeGreaterThan(0);
  });
});
