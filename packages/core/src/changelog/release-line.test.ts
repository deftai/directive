import { describe, expect, it } from "vitest";
import {
  evaluateReleaseRule,
  fragmentBodyLines,
  hasReleaseVersionHeading,
  linesAboveLinkFooter,
  pathsOutsideRelease,
  RELEASE_LINE_PREFIX,
  type ReleaseRuleInput,
  releaseLine,
  releaseLinesIn,
  releaseLineVersion,
  stripReleaseLines,
  unreleasedEntryLines,
  versionSectionLines,
} from "./release-line.js";

const BASE =
  "## [Unreleased]\n\n- [release-line] v0.1.0\n\n### Added\n\n- note (#1)\n\n" +
  "## [0.1.0] - 2026-01-01\n\n- old (#0)\n\n" +
  "[Unreleased]: https://github.com/o/r/compare/v0.1.0...HEAD\n";

const HEAD =
  "## [Unreleased]\n\n- [release-line] v0.2.0\n\n### Added\n\n### Fixed\n\n" +
  "## [0.2.0] - 2026-02-01\n\n### Added\n\n- note (#1)\n- frag (#2)\n  more\n\n" +
  "## [0.1.0] - 2026-01-01\n\n- old (#0)\n\n" +
  "[Unreleased]: https://github.com/o/r/compare/v0.2.0...HEAD\n";

function input(overrides: Partial<ReleaseRuleInput> = {}): ReleaseRuleInput {
  return {
    changeSet: [
      { status: "M", path: "CHANGELOG.md" },
      { status: "M", path: "ROADMAP.md" },
      { status: "D", path: "changelog.d/2-frag.md" },
    ],
    baseChangelog: BASE,
    headChangelog: HEAD,
    readBaseFragment: () => "section: Added\n- frag (#2)\n  more\n",
    treeFragmentPaths: [],
    ...overrides,
  };
}

describe("release line (#6296 item 4)", () => {
  it("has one fixed form and parses its version", () => {
    expect(releaseLine("1.2.3")).toBe(`${RELEASE_LINE_PREFIX}1.2.3`);
    expect(releaseLineVersion("- [release-line] v1.2.3")).toBe("1.2.3");
    expect(releaseLineVersion("- [release-line] v1.2.3-rc.1  \r")).toBe("1.2.3-rc.1");
    expect(releaseLineVersion("- [release-line] 1.2.3")).toBeNull();
    expect(releaseLineVersion("- note")).toBeNull();
  });

  it("reads entries, footer, sections and headings line by line", () => {
    expect(unreleasedEntryLines(BASE)).toEqual(["- [release-line] v0.1.0", "- note (#1)"]);
    expect(unreleasedEntryLines("# no unreleased\n- x\n")).toEqual([]);
    expect(linesAboveLinkFooter("a\nb\n")).toEqual(["a", "b", ""]);
    expect(linesAboveLinkFooter(BASE).some((l) => l.startsWith("[Unreleased]:"))).toBe(false);
    expect(releaseLinesIn(HEAD)).toEqual(["- [release-line] v0.2.0"]);
    expect(hasReleaseVersionHeading(HEAD, "0.2.0")).toBe(true);
    expect(hasReleaseVersionHeading(HEAD, "0.3.0")).toBe(false);
    expect(versionSectionLines(HEAD, "0.2.0")).toContain("  more");
    expect(versionSectionLines(HEAD, "9.9.9")).toEqual([]);
    expect(fragmentBodyLines("﻿section: Added\r\n- a\r\n")).toEqual(["- a", ""]);
    expect(fragmentBodyLines("- no section\n")).toEqual(["- no section", ""]);
  });

  it("strips release lines and the blank line after them, keeping CRLF", () => {
    expect(stripReleaseLines("## [Unreleased]\n\n- [release-line] v0.1.0\n\n### Added\n")).toBe(
      "## [Unreleased]\n\n### Added\n",
    );
    expect(stripReleaseLines("a\r\n- [release-line] v0.1.0\r\nb\r\n")).toBe("a\r\nb\r\n");
    expect(stripReleaseLines("- [release-line] v0.1.0")).toBe("");
  });

  it("names rows outside the release files", () => {
    expect(
      pathsOutsideRelease([
        { status: "M", path: "CHANGELOG.md" },
        { status: "M", path: "ROADMAP.md" },
        { status: "D", path: "changelog.d/1-a.md" },
        { status: "A", path: "changelog.d/2-b.md" },
        { status: "M", path: "src/x.ts" },
      ]),
    ).toEqual(["A changelog.d/2-b.md", "M src/x.ts"]);
  });
});

describe("evaluateReleaseRule (#6296 item 5)", () => {
  it("passes a well-formed release change set", () => {
    const verdict = evaluateReleaseRule(input());
    expect(verdict).toEqual({ kind: "release", ok: true, version: "0.2.0", problems: [] });
  });

  it("leaves a change set without release-line changes to the ordinary rules", () => {
    expect(evaluateReleaseRule(input({ headChangelog: BASE })).kind).toBe("ordinary");
    expect(evaluateReleaseRule(input({ baseChangelog: null, headChangelog: "x\n" })).kind).toBe(
      "ordinary",
    );
  });

  it("fails an ordinary change set that removes the release line", () => {
    const verdict = evaluateReleaseRule(
      input({ headChangelog: BASE.replace("- [release-line] v0.1.0\n", "") }),
    );
    expect(verdict.kind).toBe("release-line-removed");
  });

  it("fails more than one added release line", () => {
    const head = HEAD.replace(
      "- [release-line] v0.2.0",
      "- [release-line] v0.2.0\n- [release-line] v0.2.1",
    );
    const verdict = evaluateReleaseRule(input({ headChangelog: head }));
    expect(verdict.kind === "release" && !verdict.ok).toBe(true);
    if (verdict.kind === "release")
      expect(verdict.problems.join("\n")).toContain("2 release lines");
  });

  it("fails a heading that already existed at the merge base", () => {
    const base = BASE.replace("## [0.1.0]", "## [0.2.0] - 2026-01-02\n\n## [0.1.0]");
    const verdict = evaluateReleaseRule(input({ baseChangelog: base }));
    expect(verdict.kind === "release" && verdict.problems.join(" ")).toContain("no new ## [0.2.0]");
  });

  it("names unreadable deleted fragments and every lost line", () => {
    const many = Array.from({ length: 7 }, (_, i) => `- lost ${String(i)}`).join("\n");
    const verdict = evaluateReleaseRule(
      input({
        baseChangelog: BASE.replace("- note (#1)", `- note (#1)\n${many}`),
        readBaseFragment: () => null,
        treeFragmentPaths: ["changelog.d/9-z.md", "changelog.d/1-a.md"],
      }),
    );
    expect(verdict.kind).toBe("release");
    if (verdict.kind !== "release") return;
    const text = verdict.problems.join("\n");
    expect(text).toContain("could not read deleted fragment(s)");
    expect(text).toContain('"- lost 0"');
    expect(text).toContain('"- lost 6"');
    expect(text).toContain("changelog.d/1-a.md, changelog.d/9-z.md");
  });
});
