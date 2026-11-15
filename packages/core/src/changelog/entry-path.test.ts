import { describe, expect, it } from "vitest";
import {
  CHANGELOG_FILE_REL,
  CHANGELOG_FRAGMENT_DIR,
  isChangelogEntryPath,
  isChangelogFragmentPath,
} from "./entry-path.js";

describe("isChangelogEntryPath (#6314)", () => {
  it("is true for exactly CHANGELOG.md and a one-segment fragment path", () => {
    expect(isChangelogEntryPath("CHANGELOG.md")).toBe(true);
    expect(isChangelogEntryPath("changelog.d/6286-fragments.md")).toBe(true);
    expect(isChangelogEntryPath("changelog.d/1-a.b_c-d.md")).toBe(true);
  });

  it("is false for nested, upper-case, non-root and non-md paths", () => {
    expect(isChangelogEntryPath("changelog.d/sub/x.md")).toBe(false);
    expect(isChangelogEntryPath("changelog.d/X.md")).toBe(false);
    expect(isChangelogEntryPath("docs/CHANGELOG.md")).toBe(false);
    expect(isChangelogEntryPath("changelog.md")).toBe(false);
    expect(isChangelogEntryPath("changelog.d/x.txt")).toBe(false);
    expect(isChangelogEntryPath("changelog.d/")).toBe(false);
    expect(isChangelogEntryPath("changelog.d")).toBe(false);
    expect(isChangelogEntryPath("./CHANGELOG.md")).toBe(false);
    expect(isChangelogEntryPath("changelog.d\\x.md")).toBe(false);
    expect(isChangelogEntryPath("a/changelog.d/x.md")).toBe(false);
    expect(isChangelogEntryPath("")).toBe(false);
  });

  it("fragment path test excludes CHANGELOG.md", () => {
    expect(isChangelogFragmentPath("CHANGELOG.md")).toBe(false);
    expect(isChangelogFragmentPath("changelog.d/6314-x.md")).toBe(true);
  });

  it("exports the root file and fragment directory names", () => {
    expect(CHANGELOG_FILE_REL).toBe("CHANGELOG.md");
    expect(CHANGELOG_FRAGMENT_DIR).toBe("changelog.d");
  });
});
