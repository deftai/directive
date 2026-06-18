import { describe, expect, it } from "vitest";
import { fnmatchCase, pythonSplitlines, stripMarkdownQuotes } from "./text.js";

describe("pythonSplitlines", () => {
  it("returns [] for empty input", () => {
    expect(pythonSplitlines("")).toEqual([]);
  });

  it("does not emit a trailing empty for a final line break", () => {
    expect(pythonSplitlines("a\nb\n")).toEqual(["a", "b"]);
    expect(pythonSplitlines("a\nb")).toEqual(["a", "b"]);
  });

  it("keeps a leading empty line", () => {
    expect(pythonSplitlines("\n")).toEqual([""]);
    expect(pythonSplitlines("\na")).toEqual(["", "a"]);
  });

  it("treats CRLF as a single boundary (Windows edge case)", () => {
    expect(pythonSplitlines("a\r\nb\r\nc")).toEqual(["a", "b", "c"]);
  });

  it("splits on bare CR (old-Mac edge case)", () => {
    expect(pythonSplitlines("a\rb")).toEqual(["a", "b"]);
  });

  it("splits on the full Python boundary set (\\v \\f, line/para sep)", () => {
    expect(pythonSplitlines("a\vb\fc\u2028d\u2029e")).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("stripMarkdownQuotes", () => {
  it("removes inline code spans", () => {
    expect(stripMarkdownQuotes("a `code` b")).toBe("a  b");
  });

  it("blanks fenced blocks while preserving line count", () => {
    const text = "before\n```\nfenced mojibake line\n```\nafter\n";
    const out = stripMarkdownQuotes(text);
    expect(out.split("\n").length).toBe(text.split("\n").length);
    expect(out).not.toContain("fenced mojibake line");
    expect(out.startsWith("before\n")).toBe(true);
    expect(out.trimEnd().endsWith("after")).toBe(true);
  });

  it("handles tilde fences too", () => {
    expect(stripMarkdownQuotes("~~~\nx\n~~~")).toBe("\n\n");
  });
});

describe("fnmatchCase", () => {
  it("matches the -798- allow-list carve-out", () => {
    expect(
      fnmatchCase(
        "vbrief/active/2026-01-01-798-x.vbrief.json",
        "vbrief/active/*-798-*.vbrief.json",
      ),
    ).toBe(true);
    expect(
      fnmatchCase("vbrief/active/2026-01-01-1-x.vbrief.json", "vbrief/active/*-798-*.vbrief.json"),
    ).toBe(false);
  });

  it("treats ** as matching across slashes", () => {
    expect(fnmatchCase("history/archive/a/b/c.md", "history/archive/**")).toBe(true);
    expect(fnmatchCase("history/archive/a/b/c.md", "history/archive/**/*")).toBe(true);
  });

  it("matches exact literal paths and rejects others", () => {
    expect(fnmatchCase("scripts/verify_encoding.py", "scripts/verify_encoding.py")).toBe(true);
    expect(fnmatchCase("scripts/other.py", "scripts/verify_encoding.py")).toBe(false);
  });

  it("treats a literal dot as a dot, not any-char", () => {
    expect(fnmatchCase("aXtxt", "a.txt")).toBe(false);
    expect(fnmatchCase("a.txt", "a.txt")).toBe(true);
  });

  it("supports ? and character classes including negation", () => {
    expect(fnmatchCase("a1", "a?")).toBe(true);
    expect(fnmatchCase("ab", "a[bc]")).toBe(true);
    expect(fnmatchCase("ad", "a[bc]")).toBe(false);
    expect(fnmatchCase("ad", "a[!bc]")).toBe(true);
  });

  it("treats an unterminated [ as a literal bracket", () => {
    expect(fnmatchCase("a[", "a[")).toBe(true);
    expect(fnmatchCase("ab", "a[")).toBe(false);
  });

  it("treats a leading ^ inside a class as a literal caret", () => {
    expect(fnmatchCase("x^", "x[^y]")).toBe(true);
    expect(fnmatchCase("xy", "x[^y]")).toBe(true);
    expect(fnmatchCase("xz", "x[^y]")).toBe(false);
  });
});
