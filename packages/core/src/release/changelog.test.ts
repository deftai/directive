import { describe, expect, it } from "vitest";
import { releaseLine, releaseLinesIn, unreleasedEntryLines } from "../changelog/release-line.js";
import {
  freshUnreleasedBlock,
  prependBannerText,
  prependUpgradeBanner,
  promoteChangelog,
  sectionForVersion,
  splitBodyAndLinks,
} from "./changelog.js";

describe("release line on promotion (#6296 item 4)", () => {
  const WITH_PREVIOUS =
    "# Changelog\n\n## [Unreleased]\n\n- [release-line] v0.20.0\n\n### Added\n- new (#1)\n\n" +
    "## [0.20.0] - 2026-04-01\n\n- old\n\n" +
    "[Unreleased]: https://github.com/deftai/directive/compare/v0.20.0...HEAD\n" +
    "[0.20.0]: https://github.com/deftai/directive/releases/tag/v0.20.0\n";

  it("writes exactly one release line for the cut version and none into the promoted section", () => {
    const out = promoteChangelog(WITH_PREVIOUS, "0.21.0", "deftai/directive", "2026-04-28");
    expect(unreleasedEntryLines(out)).toEqual([releaseLine("0.21.0")]);
    expect(releaseLinesIn(out)).toEqual([releaseLine("0.21.0")]);
    expect(sectionForVersion(out, "0.21.0")).not.toContain("[release-line]");
    expect(sectionForVersion(out, "0.21.0")).toContain("- new (#1)");
  });

  it("puts the release line first in the fresh block", () => {
    expect(freshUnreleasedBlock("1.0.0")).toBe(
      "## [Unreleased]\n\n- [release-line] v1.0.0\n\n### Added\n\n### Changed\n\n### Fixed\n\n### Removed\n",
    );
  });
});

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

describe("upgrade banner text (#6875)", () => {
  it("leads deftai/directive notes with the banner text the caller read", () => {
    expect(prependBannerText("notes", "deftai/directive", "Banner\r\nline\n")).toBe(
      "Banner\nline\n\nnotes",
    );
  });

  it("leaves the notes alone for another repo, no banner or an empty banner", () => {
    expect(prependBannerText("notes", "o/r", "Banner")).toBe("notes");
    expect(prependBannerText("notes", "deftai/directive", null)).toBe("notes");
    expect(prependBannerText("notes", "deftai/directive", "  \n")).toBe("notes");
  });

  it("keeps prependUpgradeBanner reading the local file through the same rules", () => {
    const read = (path: string) => (path.endsWith("upgrade-banner.md") ? "Local" : null);
    expect(prependUpgradeBanner("notes", "deftai/directive", "/p", read)).toBe("Local\n\nnotes");
    const throws = (): string | null => {
      throw new Error("unreadable");
    };
    expect(prependUpgradeBanner("notes", "deftai/directive", "/p", throws)).toBe("notes");
  });
});
