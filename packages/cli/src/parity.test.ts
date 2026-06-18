import { describe, expect, it } from "vitest";
import { diffGates, findingKey, parseFindings } from "./parity.js";

describe("parseFindings", () => {
  it("extracts finding lines and ignores header/footer prose", () => {
    const stderr = [
      "verify_encoding: detected 2 hits (#798).",
      "  Root cause: a Windows codepage decoded the bytes.",
      "  bad.txt:1 [U+FFFD replacement char] broken  marker",
      "  other.md:5 [U+2297 (\u2297) corrupted via cp437 read] some context",
      "  ... and 0 more",
    ].join("\n");
    expect(parseFindings(stderr)).toEqual([
      { path: "bad.txt", line: 1, label: "U+FFFD replacement char" },
      { path: "other.md", line: 5, label: "U+2297 (\u2297) corrupted via cp437 read" },
    ]);
  });
  it("returns [] for clean output", () => {
    expect(parseFindings("verify_encoding: 10 file(s) clean ...")).toEqual([]);
  });
});

describe("findingKey", () => {
  it("joins path:line:label", () => {
    expect(findingKey({ path: "a.md", line: 3, label: "X" })).toBe("a.md:3:X");
  });
});

describe("diffGates", () => {
  const f = { path: "a.txt", line: 1, label: "L" };
  it("reports clean when exits and findings match", () => {
    const r = diffGates({ exitCode: 1, findings: [f] }, { exitCode: 1, findings: [f] });
    expect(r.ok).toBe(true);
    expect(r.exitMismatch).toBe(false);
  });
  it("flags an exit-code mismatch", () => {
    const r = diffGates({ exitCode: 1, findings: [f] }, { exitCode: 0, findings: [] });
    expect(r.ok).toBe(false);
    expect(r.exitMismatch).toBe(true);
  });
  it("reports findings only one side has", () => {
    const r = diffGates(
      { exitCode: 1, findings: [f] },
      { exitCode: 1, findings: [{ path: "b.txt", line: 2, label: "M" }] },
    );
    expect(r.ok).toBe(false);
    expect(r.onlyPython).toEqual(["a.txt:1:L"]);
    expect(r.onlyTs).toEqual(["b.txt:2:M"]);
  });
});
