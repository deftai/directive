import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODE_STRUCTURE_VERSION,
  evaluateCodeStructure,
  isStableId,
  validateCodeStructure,
} from "./code-structure-validate.js";

function minimalRecord(): Record<string, unknown> {
  return {
    version: CODE_STRUCTURE_VERSION,
    modules: [
      {
        id: "framework-content",
        name: "Framework",
        purpose: "Agent guidance",
        pathGlobs: ["AGENTS.md"],
      },
    ],
    pathOwnership: [],
    allowedPatterns: [],
    projectionManifest: [],
  };
}

describe("isStableId", () => {
  it("accepts kebab-case ids", () => {
    expect(isStableId("framework-content")).toBe(true);
    expect(isStableId("bad_id")).toBe(false);
    expect(isStableId("")).toBe(false);
  });
});

describe("validateCodeStructure", () => {
  it("passes a minimal valid record", () => {
    const result = validateCodeStructure(minimalRecord(), "test");
    expect(result.ok).toBe(true);
  });

  it("flags wrong version", () => {
    const rec = { ...minimalRecord(), version: "9.9" };
    const result = validateCodeStructure(rec, "test");
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === "CS-VERSION")).toBe(true);
  });

  it("flags derived fact keys", () => {
    const rec = { ...minimalRecord(), imports: ["x"] };
    const result = validateCodeStructure(rec, "test");
    expect(result.errors.some((e) => e.code === "CS-DERIVED-FACT")).toBe(true);
  });
});

describe("evaluateCodeStructure", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("reports no metadata when tree is empty", () => {
    root = mkdtempSync(join(tmpdir(), "cs-empty-"));
    const result = evaluateCodeStructure(root);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("OK: no codeStructure metadata found\n");
  });

  it("validates PROJECT-DEFINITION when present", () => {
    root = mkdtempSync(join(tmpdir(), "cs-pd-"));
    const vbrief = join(root, "vbrief");
    mkdirSync(vbrief, { recursive: true });
    writeFileSync(
      join(vbrief, "PROJECT-DEFINITION.vbrief.json"),
      JSON.stringify({
        plan: {
          architecture: {
            codeStructure: minimalRecord(),
          },
        },
      }),
      "utf8",
    );
    const result = evaluateCodeStructure(root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("OK:");
  });

  it("exits 2 on invalid JSON path", () => {
    root = mkdtempSync(join(tmpdir(), "cs-bad-json-"));
    const bad = join(root, "bad.vbrief.json");
    writeFileSync(bad, "{not json", "utf8");
    const result = evaluateCodeStructure(root, { paths: [bad] });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("ERROR:");
  });
});
