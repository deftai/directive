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
    const vbrief = join(root, "xbrief");
    mkdirSync(vbrief, { recursive: true });
    writeFileSync(
      join(vbrief, "PROJECT-DEFINITION.xbrief.json"),
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
    const bad = join(root, "bad.xbrief.json");
    writeFileSync(bad, "{not json", "utf8");
    const result = evaluateCodeStructure(root, { paths: [bad] });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("ERROR:");
  });
});

function writeProject(root: string, record: Record<string, unknown>): string {
  const vbrief = join(root, "xbrief");
  mkdirSync(vbrief, { recursive: true });
  const path = join(vbrief, "PROJECT-DEFINITION.xbrief.json");
  writeFileSync(
    path,
    JSON.stringify({ plan: { architecture: { codeStructure: record } } }),
    "utf8",
  );
  return path;
}

describe("unmatched glob checks (#4088)", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  function partialRecord(): Record<string, unknown> {
    const rec = minimalRecord();
    rec.modules = [
      {
        id: "guidance",
        name: "Guidance",
        purpose: "Agent guidance",
        pathGlobs: ["live.md", "stale.md"],
      },
    ];
    return rec;
  }

  it("fails a one-live-one-stale module under enforce and names module plus glob", () => {
    root = mkdtempSync(join(tmpdir(), "cs-partial-"));
    writeFileSync(join(root, "live.md"), "ok\n", "utf8");
    const rec = partialRecord();
    const result = validateCodeStructure(rec, "test", root, { enforce: true });
    expect(result.ok).toBe(false);
    const hit = result.errors.find((e) => e.code === "CS-UNMATCHED-GLOB");
    expect(hit?.message).toContain("guidance");
    expect(hit?.message).toContain("stale.md");
    expect(result.errors.some((e) => e.message.includes("live.md"))).toBe(false);
  });

  it("warns on unmatched required globs by default", () => {
    root = mkdtempSync(join(tmpdir(), "cs-warn-"));
    writeFileSync(join(root, "live.md"), "ok\n", "utf8");
    const result = validateCodeStructure(partialRecord(), "test", root);
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.code === "CS-UNMATCHED-GLOB")).toBe(true);
  });

  it("accepts a typed exception with rationale and rejects bare allowEmpty", () => {
    const rec = partialRecord();
    const modules = rec.modules as Record<string, unknown>[];
    modules[0] = {
      ...modules[0],
      emptyMatchExceptions: [{ pathGlob: "stale.md", rationale: "optional future stem" }],
    };
    root = mkdtempSync(join(tmpdir(), "cs-exc-"));
    writeFileSync(join(root, "live.md"), "ok\n", "utf8");
    const waived = validateCodeStructure(rec, "test", root, { enforce: true });
    expect(waived.ok).toBe(true);
    expect(waived.errors.some((e) => e.code === "CS-UNMATCHED-GLOB")).toBe(false);

    const bare = partialRecord();
    (bare.modules as Record<string, unknown>[])[0] = {
      ...(bare.modules as Record<string, unknown>[])[0],
      allowEmpty: true,
    };
    const rejected = validateCodeStructure(bare, "test");
    expect(rejected.ok).toBe(false);
    expect(rejected.errors.some((e) => e.code === "CS-EMPTY-EXCEPTION")).toBe(true);
  });

  it("rejects an exception with an empty rationale", () => {
    const rec = partialRecord();
    (rec.modules as Record<string, unknown>[])[0] = {
      ...(rec.modules as Record<string, unknown>[])[0],
      emptyMatchExceptions: [{ pathGlob: "stale.md", rationale: "   " }],
    };
    const result = validateCodeStructure(rec, "test");
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === "CS-EMPTY-EXCEPTION")).toBe(true);
  });

  it("runs unmatched checks for an explicit PROJECT-DEFINITION path", () => {
    root = mkdtempSync(join(tmpdir(), "cs-path-"));
    writeFileSync(join(root, "live.md"), "ok\n", "utf8");
    const path = writeProject(root, partialRecord());
    const result = evaluateCodeStructure(root, { paths: [path], enforce: true });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("CS-UNMATCHED-GLOB");
    expect(result.stdout).toContain("stale.md");
    expect(result.stdout).toContain("guidance");
  });

  it("skips unmatched expansion when projectRoot is unknown", () => {
    const result = validateCodeStructure(partialRecord(), "test");
    expect(result.warnings.some((w) => w.code === "CS-UNMATCHED-GLOB")).toBe(false);
    expect(result.errors.some((e) => e.code === "CS-UNMATCHED-GLOB")).toBe(false);
  });
});
