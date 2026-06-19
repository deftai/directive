import { describe, expect, it } from "vitest";
import { promoteChangelog, sectionForVersion, splitBodyAndLinks } from "./changelog.js";

const SAMPLE_CHANGELOG = ` Changelog

All notable changes to the project.

## [Unreleased]

### Added
- New release automation (#74)

### Changed
- Refactored module X

### Fixed
- Bug Y

## [0.20.2] - 2026-04-24

### Added
- Prior change

[Unreleased]: https://github.com/deftai/directive/compare/v0.20.2...HEAD
[0.20.2]: https://github.com/deftai/directive/compare/v0.20.0...v0.20.2
`;

describe("splitBodyAndLinks", () => {
  it("splits at first link line", () => {
    const [body, footer] = splitBodyAndLinks(SAMPLE_CHANGELOG);
    expect(body).toContain("## [Unreleased]");
    expect(footer).toMatch(/^\[Unreleased\]:/m);
  });

  it("returns full text when no links", () => {
    const text = "## [Unreleased]\n\n### Added\n";
    expect(splitBodyAndLinks(text)).toEqual([text, ""]);
  });
});

describe("promoteChangelog", () => {
  it("promotes Unreleased heading and refreshes links", () => {
    const out = promoteChangelog(SAMPLE_CHANGELOG, "0.21.0", "deftai/directive", "2026-04-28");
    expect(out).toContain("## [0.21.0] - 2026-04-28");
    expect(out).toContain("## [Unreleased]");
    expect(out).toContain(
      "[Unreleased]: https://github.com/deftai/directive/compare/v0.21.0...HEAD",
    );
    expect(out).toContain(
      "[0.21.0]: https://github.com/deftai/directive/compare/v0.20.2...v0.21.0",
    );
  });

  it("injects summary blockquote when provided", () => {
    const out = promoteChangelog(
      SAMPLE_CHANGELOG,
      "0.21.0",
      "deftai/directive",
      "2026-04-28",
      "Ship notes",
    );
    expect(out).toContain("> Ship notes");
  });

  it("rejects missing Unreleased heading", () => {
    expect(() =>
      promoteChangelog("no heading", "0.21.0", "deftai/directive", "2026-04-28"),
    ).toThrow("does not contain");
  });

  it("rejects multiline summary", () => {
    expect(() =>
      promoteChangelog(SAMPLE_CHANGELOG, "0.21.0", "deftai/directive", "2026-04-28", "a\nb"),
    ).toThrow("single-line");
  });
});

describe("sectionForVersion", () => {
  it("extracts version section body", () => {
    const body = sectionForVersion(SAMPLE_CHANGELOG, "0.20.2");
    expect(body).toContain("Prior change");
    expect(body).not.toContain("## [0.20.2]");
  });

  it("uses releases/tag link when no previous version", () => {
    const text = `## [Unreleased]\n\n### Added\n- first\n`;
    const out = promoteChangelog(text, "0.21.0", "deftai/directive", "2026-01-01");
    expect(out).toContain("[0.21.0]: https://github.com/deftai/directive/releases/tag/v0.21.0");
  });

  it("treats empty summary like none", () => {
    const withEmpty = promoteChangelog(
      SAMPLE_CHANGELOG,
      "0.21.0",
      "deftai/directive",
      "2026-04-28",
      "",
    );
    const without = promoteChangelog(
      SAMPLE_CHANGELOG,
      "0.21.0",
      "deftai/directive",
      "2026-04-28",
      null,
    );
    expect(withEmpty).toBe(without);
  });
});
