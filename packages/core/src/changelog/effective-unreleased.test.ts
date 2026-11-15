import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseClosesSet } from "../release/consumer-hard-stops.js";
import {
  composeEffectiveUnreleased,
  effectiveChangelogText,
  mergeFragmentsIntoChangelogText,
  parseUnreleasedEntries,
  readEffectiveUnreleased,
} from "./effective-unreleased.js";
import type { ChangelogFragment } from "./fragment.js";

const CHANGELOG = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "### Added",
  "",
  "- Inline added (#1)",
  "  continued",
  "",
  "### Changed",
  "",
  "### Fixed",
  "",
  "- Inline fixed (#2)",
  "",
  "## [0.1.0] - 2026-01-01",
  "",
  "### Added",
  "",
  "- Released entry",
  "",
  "[Unreleased]: https://github.com/o/r/compare/v0.1.0...HEAD",
  "",
].join("\n");

const roots: string[] = [];

function tempRoot(changelog: string | null, fragments: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "deft-effective-"));
  roots.push(root);
  if (changelog !== null) writeFileSync(join(root, "CHANGELOG.md"), changelog);
  const names = Object.keys(fragments);
  if (names.length > 0) {
    mkdirSync(join(root, "changelog.d"));
    for (const name of names) writeFileSync(join(root, "changelog.d", name), fragments[name] ?? "");
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function frag(path: string, section: ChangelogFragment["section"], entries: string[]) {
  return { path, section, entries };
}

describe("parseUnreleasedEntries (#6314)", () => {
  it("returns [Unreleased] entries with their subsection and continuation lines", () => {
    expect(parseUnreleasedEntries(CHANGELOG)).toEqual([
      { section: "Added", text: "- Inline added (#1)\n  continued", source: "CHANGELOG.md" },
      { section: "Fixed", text: "- Inline fixed (#2)", source: "CHANGELOG.md" },
    ]);
  });

  it("returns nothing without a heading and keeps entries above any subsection", () => {
    expect(parseUnreleasedEntries("# Changelog\n- x\n")).toEqual([]);
    expect(parseUnreleasedEntries("## [Unreleased]\n- top\ntext\n- next\r\n")).toEqual([
      { section: null, text: "- top", source: "CHANGELOG.md" },
      { section: null, text: "- next", source: "CHANGELOG.md" },
    ]);
  });
});

describe("mergeFragmentsIntoChangelogText (#6314)", () => {
  it("returns the text unchanged with no fragments or no heading", () => {
    expect(mergeFragmentsIntoChangelogText(CHANGELOG, [])).toBe(CHANGELOG);
    expect(
      mergeFragmentsIntoChangelogText(CHANGELOG, [frag("changelog.d/1-a.md", "Added", [])]),
    ).toBe(CHANGELOG);
    const noHeading = "# Changelog\n";
    expect(
      mergeFragmentsIntoChangelogText(noHeading, [frag("changelog.d/1-a.md", "Added", ["- a"])]),
    ).toBe(noHeading);
  });

  it("appends to existing subsections, fills empty ones and adds missing ones", () => {
    const merged = mergeFragmentsIntoChangelogText(CHANGELOG, [
      frag("changelog.d/10-a.md", "Added", ["- Frag added\n  more"]),
      frag("changelog.d/11-c.md", "Changed", ["- Frag changed"]),
      frag("changelog.d/12-s.md", "Security", ["- Frag security"]),
    ]);
    expect(merged).toBe(
      [
        "# Changelog",
        "",
        "## [Unreleased]",
        "",
        "### Added",
        "",
        "- Inline added (#1)",
        "  continued",
        "- Frag added",
        "  more",
        "",
        "### Changed",
        "",
        "- Frag changed",
        "",
        "### Fixed",
        "",
        "- Inline fixed (#2)",
        "",
        "### Security",
        "",
        "- Frag security",
        "",
        "## [0.1.0] - 2026-01-01",
        "",
        "### Added",
        "",
        "- Released entry",
        "",
        "[Unreleased]: https://github.com/o/r/compare/v0.1.0...HEAD",
        "",
      ].join("\n"),
    );
    // The released section is untouched.
    expect(merged.split("## [0.1.0]")[1]).toBe(CHANGELOG.split("## [0.1.0]")[1]);
  });

  it("keeps a blank line between a trailing blockquote or fence and appended entries (#6314 review)", () => {
    const quoted =
      "## [Unreleased]\n\n### Fixed\n\n- Inline\n\n> note about the cut\n\n## [0.1.0]\n";
    const merged = mergeFragmentsIntoChangelogText(quoted, [
      frag("changelog.d/77-x.md", "Fixed", ["- Fixed this (Closes #77)"]),
    ]);
    expect(merged).toBe(
      "## [Unreleased]\n\n### Fixed\n\n- Inline\n\n> note about the cut\n\n- Fixed this (Closes #77)\n\n## [0.1.0]\n",
    );
    expect(parseClosesSet(merged)).toEqual(new Set([77]));

    const fenced = "## [Unreleased]\n### Added\n- a\n  ```\n  code\n  ```\n";
    expect(
      mergeFragmentsIntoChangelogText(fenced, [frag("changelog.d/1-a.md", "Added", ["- b"])]),
    ).toBe("## [Unreleased]\n### Added\n- a\n  ```\n  code\n  ```\n\n- b\n");

    const prose = "## [Unreleased]\n### Added\nSome prose.\n";
    expect(
      mergeFragmentsIntoChangelogText(prose, [frag("changelog.d/1-a.md", "Added", ["- b"])]),
    ).toBe("## [Unreleased]\n### Added\nSome prose.\n\n- b\n");
  });

  it("keeps CRLF and pads a subsection heading followed directly by another heading", () => {
    const text = "## [Unreleased]\r\n### Added\r\n### Fixed\r\n- x\r\n";
    expect(
      mergeFragmentsIntoChangelogText(text, [frag("changelog.d/1-a.md", "Added", ["- a"])]),
    ).toBe("## [Unreleased]\r\n### Added\r\n\r\n- a\r\n\r\n### Fixed\r\n- x\r\n");
  });

  it("adds a subsection to an empty [Unreleased] at end of file and before a next heading", () => {
    expect(
      mergeFragmentsIntoChangelogText("## [Unreleased]", [
        frag("changelog.d/1-a.md", "Fixed", ["- f"]),
      ]),
    ).toBe("## [Unreleased]\n\n### Fixed\n\n- f");
    expect(
      mergeFragmentsIntoChangelogText("## [Unreleased]\n## [0.1.0]\n", [
        frag("changelog.d/1-a.md", "Fixed", ["- f"]),
      ]),
    ).toBe("## [Unreleased]\n\n### Fixed\n\n- f\n\n## [0.1.0]\n");
  });
});

describe("readEffectiveUnreleased (#6314)", () => {
  it("with no fragment the effective text is the changelog text unchanged", () => {
    const root = tempRoot(CHANGELOG);
    const view = readEffectiveUnreleased(root);
    expect(view.effectiveText).toBe(CHANGELOG);
    expect(view.changelogText).toBe(CHANGELOG);
    expect(view.hasUnreleasedHeading).toBe(true);
    expect(view.fragments).toEqual([]);
    expect(view.entries).toEqual(view.changelogEntries);
    expect(effectiveChangelogText(root, CHANGELOG)).toBe(CHANGELOG);
  });

  it("returns [Unreleased] entries plus two valid fragments, by subsection", () => {
    const root = tempRoot(CHANGELOG, {
      "6314-b.md": "section: Fixed\n- Frag fixed (Closes #77)\n",
      "6286-a.md": "section: Added\n- Frag added\n- Frag added two\n",
      "6300-bad.md": "section: Notes\n- ignored\n",
    });
    const view = readEffectiveUnreleased(root);
    expect(view.fragments.map((f) => f.path)).toEqual([
      "changelog.d/6286-a.md",
      "changelog.d/6314-b.md",
    ]);
    expect(view.invalidFragments.map((f) => [f.path, f.reason])).toEqual([
      ["changelog.d/6300-bad.md", "unknown-section"],
    ]);
    expect(view.sections.map((s) => [s.section, s.entries.map((e) => [e.source, e.text])])).toEqual(
      [
        [
          "Added",
          [
            ["CHANGELOG.md", "- Inline added (#1)\n  continued"],
            ["changelog.d/6286-a.md", "- Frag added"],
            ["changelog.d/6286-a.md", "- Frag added two"],
          ],
        ],
        [
          "Fixed",
          [
            ["CHANGELOG.md", "- Inline fixed (#2)"],
            ["changelog.d/6314-b.md", "- Frag fixed (Closes #77)"],
          ],
        ],
      ],
    );
    expect(view.entries).toHaveLength(5);
    expect(view.effectiveText).toContain("- Frag fixed (Closes #77)");
    expect(parseUnreleasedEntries(view.effectiveText ?? "")).toHaveLength(5);
  });

  it("groups unknown subsections after the standard ones and none last", () => {
    const view = composeEffectiveUnreleased(
      "## [Unreleased]\n- loose\n### Notes\n- note\n### Added\n- add\n",
      { valid: [], invalid: [] },
    );
    expect(view.sections.map((s) => s.section)).toEqual(["Added", "Notes", null]);
  });

  it("reads a missing changelog as null and honours an explicit path or text", () => {
    const root = tempRoot(null, { "1-a.md": "section: Added\n- a\n" });
    const missing = readEffectiveUnreleased(root);
    expect(missing.changelogText).toBeNull();
    expect(missing.effectiveText).toBeNull();
    expect(missing.hasUnreleasedHeading).toBe(false);
    expect(missing.entries.map((e) => e.text)).toEqual(["- a"]);

    writeFileSync(join(root, "OTHER.md"), "## [Unreleased]\n");
    expect(readEffectiveUnreleased(root, { changelogPath: "OTHER.md" }).effectiveText).toBe(
      "## [Unreleased]\n\n### Added\n\n- a\n",
    );
    expect(readEffectiveUnreleased(root, { changelogText: null }).changelogText).toBeNull();
  });
});
