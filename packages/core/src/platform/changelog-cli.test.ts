/**
 * Vitest tests for changelog-cli.ts (wire-flip CLI wrapper for changelog:resolve-unreleased).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changelogResolveUnreleasedMain } from "./changelog-cli.js";

const MINIMAL_CHANGELOG = `# Changelog

## [Unreleased]

### Added
- Some new feature

## [1.0.0] - 2024-01-01

### Added
- Initial release
`;

describe("changelogResolveUnreleasedMain", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "changelog-cli-test-"));
  });

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = "";
    }
  });

  it("exits 0 with valid CHANGELOG on dry-run", () => {
    const p = join(dir, "CHANGELOG.md");
    writeFileSync(p, MINIMAL_CHANGELOG, "utf8");
    const code = changelogResolveUnreleasedMain(["--changelog-path", p, "--dry-run"]);
    expect(code).toBe(0);
  });

  it("exits 0 silently with --quiet flag", () => {
    const p = join(dir, "CHANGELOG.md");
    writeFileSync(p, MINIMAL_CHANGELOG, "utf8");
    const code = changelogResolveUnreleasedMain(["--changelog-path", p, "--dry-run", "--quiet"]);
    expect(code).toBe(0);
  });

  it("exits 0 with --changelog-path= equals form", () => {
    const p = join(dir, "CHANGELOG.md");
    writeFileSync(p, MINIMAL_CHANGELOG, "utf8");
    const code = changelogResolveUnreleasedMain([`--changelog-path=${p}`, "--dry-run"]);
    expect(code).toBe(0);
  });

  it("exits 2 for missing --changelog-path value", () => {
    const code = changelogResolveUnreleasedMain(["--changelog-path"]);
    expect(code).toBe(2);
  });

  it("exits 2 for unrecognized argument", () => {
    const code = changelogResolveUnreleasedMain(["--unknown-flag"]);
    expect(code).toBe(2);
  });

  it("handles non-existent CHANGELOG path", () => {
    const p = join(dir, "nonexistent.md");
    const code = changelogResolveUnreleasedMain(["--changelog-path", p, "--dry-run"]);
    // evaluateChangelogPath returns a non-zero code when file doesn't exist
    expect(code).not.toBe(0);
  });

  it("handles non-file path (directory)", () => {
    const subdir = join(dir, "subdir");
    mkdirSync(subdir);
    const code = changelogResolveUnreleasedMain(["--changelog-path", subdir, "--dry-run"]);
    expect(code).not.toBe(0);
  });
});
