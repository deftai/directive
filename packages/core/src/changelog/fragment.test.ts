import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHANGELOG_SUBSECTIONS,
  type FragmentFs,
  isChangelogSubsection,
  parseFragmentText,
  readChangelogFragment,
  readChangelogFragments,
} from "./fragment.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-fragment-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("parseFragmentText (#6314)", () => {
  it("parses a section line and entries with continuation lines", () => {
    const parsed = parseFragmentText(
      "section: Added\n- First entry (#6314)\n  continued line\n\n- Second entry\n",
    );
    expect(parsed).toEqual({
      ok: true,
      section: "Added",
      entries: ["- First entry (#6314)\n  continued line", "- Second entry"],
    });
  });

  it("accepts CRLF, a BOM and spaces around the section name", () => {
    const parsed = parseFragmentText("﻿section:   Fixed  \r\n- One\r\n");
    expect(parsed).toEqual({ ok: true, section: "Fixed", entries: ["- One"] });
  });

  it("refuses an empty or whitespace-only file", () => {
    expect(parseFragmentText("")).toMatchObject({ ok: false, reason: "empty" });
    expect(parseFragmentText(" \n\n")).toMatchObject({ ok: false, reason: "empty" });
  });

  it("refuses a missing or unknown section", () => {
    expect(parseFragmentText("- entry\n")).toMatchObject({ ok: false, reason: "section-line" });
    expect(parseFragmentText("section:\n- entry\n")).toMatchObject({
      ok: false,
      reason: "section-line",
    });
    expect(parseFragmentText("section: Improved\n- entry\n")).toMatchObject({
      ok: false,
      reason: "unknown-section",
    });
    expect(parseFragmentText("section: added\n- entry\n")).toMatchObject({
      ok: false,
      reason: "unknown-section",
    });
  });

  it("refuses a line that starts with #", () => {
    expect(parseFragmentText("section: Added\n## [0.1.0]\n- entry\n")).toMatchObject({
      ok: false,
      reason: "heading-line",
    });
    expect(parseFragmentText("section: Added\n- entry\n# note\n")).toMatchObject({
      ok: false,
      reason: "heading-line",
    });
  });

  it("refuses an unindented non-entry line and a file with no entries", () => {
    expect(parseFragmentText("section: Added\ntext\n")).toMatchObject({
      ok: false,
      reason: "unindented-line",
    });
    expect(parseFragmentText("section: Added\n  orphan continuation\n")).toMatchObject({
      ok: false,
      reason: "unindented-line",
    });
    expect(parseFragmentText("section: Added\n\n")).toMatchObject({
      ok: false,
      reason: "no-entries",
    });
  });

  it("knows every Keep a Changelog subsection", () => {
    expect(CHANGELOG_SUBSECTIONS).toEqual([
      "Added",
      "Changed",
      "Deprecated",
      "Removed",
      "Fixed",
      "Security",
    ]);
    expect(isChangelogSubsection("Security")).toBe(true);
    expect(isChangelogSubsection("Notes")).toBe(false);
  });
});

describe("readChangelogFragments (#6314)", () => {
  it("returns no fragments when changelog.d/ is absent", () => {
    expect(readChangelogFragments(tempRoot())).toEqual({ valid: [], invalid: [] });
  });

  it("reads valid fragments sorted by name and reports invalid ones", () => {
    const root = tempRoot();
    const dir = join(root, "changelog.d");
    mkdirSync(dir);
    writeFileSync(join(dir, "6314-b.md"), "section: Fixed\n- Fixed b\n");
    writeFileSync(join(dir, "6286-a.md"), "section: Added\n- Added a\n");
    writeFileSync(join(dir, "6300-empty.md"), "");
    writeFileSync(join(dir, "readme.md"), "section: Added\n- not a fragment name\n");
    writeFileSync(join(dir, ".gitkeep"), "");
    writeFileSync(join(dir, "X.md"), "section: Added\n- skipped, not an entry path\n");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "1-x.md"), "section: Added\n- nested\n");
    mkdirSync(join(dir, "7-dir.md"));

    const set = readChangelogFragments(root);
    expect(set.valid).toEqual([
      { path: "changelog.d/6286-a.md", section: "Added", entries: ["- Added a"] },
      { path: "changelog.d/6314-b.md", section: "Fixed", entries: ["- Fixed b"] },
    ]);
    expect(set.invalid.map((f) => [f.path, f.reason])).toEqual([
      ["changelog.d/6300-empty.md", "empty"],
      ["changelog.d/7-dir.md", "not-regular"],
      ["changelog.d/readme.md", "file-name"],
    ]);
  });

  it("refuses a symlink without reading it", () => {
    let read = false;
    const fs: FragmentFs = {
      readdir: () => ["1-link.md"],
      lstat: (p) =>
        p.endsWith("changelog.d")
          ? { isSymbolicLink: () => false, isFile: () => false, isDirectory: () => true }
          : { isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false },
      readFile: () => {
        read = true;
        return "section: Added\n- x\n";
      },
    };
    expect(readChangelogFragment("/r", "changelog.d/1-link.md", fs)).toMatchObject({
      reason: "symlink",
    });
    expect(readChangelogFragments("/r", fs).invalid.map((f) => f.reason)).toEqual(["symlink"]);
    expect(read).toBe(false);
  });

  it("never lists a symlinked or non-directory changelog.d (#6314 review)", () => {
    let listed = false;
    const symlinkDir: FragmentFs = {
      readdir: () => {
        listed = true;
        return ["1-outside.md"];
      },
      lstat: () => ({ isSymbolicLink: () => true, isFile: () => false, isDirectory: () => true }),
      readFile: () => "section: Fixed\n- Outside (Closes #1)\n",
    };
    expect(readChangelogFragments("/r", symlinkDir)).toEqual({
      valid: [],
      invalid: [
        {
          path: "changelog.d",
          reason: "symlink",
          detail: "changelog.d is a symlink; fragments are not read",
        },
      ],
    });
    expect(listed).toBe(false);

    const root = tempRoot();
    writeFileSync(join(root, "changelog.d"), "not a directory");
    expect(readChangelogFragments(root).invalid.map((f) => [f.path, f.reason])).toEqual([
      ["changelog.d", "not-regular"],
    ]);
  });

  it("reports lstat and read failures as unreadable", () => {
    const regular = { isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false };
    const lstatFails: FragmentFs = {
      readdir: () => [],
      lstat: () => {
        throw new Error("EACCES");
      },
      readFile: () => "",
    };
    expect(readChangelogFragment("/r", "changelog.d/1-a.md", lstatFails)).toMatchObject({
      reason: "unreadable",
      detail: "EACCES",
    });
    const readFails: FragmentFs = {
      readdir: () => [],
      lstat: () => regular,
      readFile: () => {
        throw "boom";
      },
    };
    expect(readChangelogFragment("/r", "changelog.d/1-a.md", readFails)).toMatchObject({
      reason: "unreadable",
      detail: "boom",
    });
  });
});
