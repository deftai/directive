import { describe, expect, it } from "vitest";
import { updatePyprojectVersion } from "./pyproject.js";

const SAMPLE = `[build-system]
requires = ["hatchling"]

[project]
name = "deft"
version = "0.20.0"
description = "test"

[tool.poetry]
version = "9.9.9"
`;

describe("updatePyprojectVersion", () => {
  it("rewrites [project].version only", () => {
    const out = updatePyprojectVersion(SAMPLE, "0.21.0");
    expect(out).toContain('version = "0.21.0"');
    expect(out).toContain('[tool.poetry]\nversion = "9.9.9"');
  });

  it("is idempotent", () => {
    const once = updatePyprojectVersion(SAMPLE, "0.21.0");
    expect(updatePyprojectVersion(once, "0.21.0")).toBe(once);
  });

  it("rejects missing [project] version", () => {
    expect(() => updatePyprojectVersion("[tool]\n", "0.21.0")).toThrow(/no \[project\]/);
  });

  it("rejects non-string inputs", () => {
    expect(() => updatePyprojectVersion(1 as unknown as string, "0.21.0")).toThrow(/text must be/);
    expect(() => updatePyprojectVersion(SAMPLE, "")).toThrow(/non-empty/);
  });
});
