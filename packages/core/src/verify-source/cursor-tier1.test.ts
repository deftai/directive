import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CURSOR_TIER1_TARGETS, evaluateCursorTier1, normalizeWhitespace } from "./cursor-tier1.js";

function writeTarget(root: string, relPath: string, body: string): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body, "utf8");
}

/** Build a file body that contains every required marker for a target. */
function bodyWithAllMarkers(markers: readonly string[]): string {
  return `# Skill\n\n${markers.map((m) => `Line referencing ${m} here.`).join("\n")}\n`;
}

function seedCleanRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "cursor-tier1-"));
  for (const target of CURSOR_TIER1_TARGETS) {
    writeTarget(root, target.path, bodyWithAllMarkers(target.markers));
  }
  return root;
}

describe("evaluateCursorTier1", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("exits 0 when both matrices enumerate every Cursor Tier-1 marker", () => {
    root = seedCleanRoot();
    const result = evaluateCursorTier1(root);
    expect(result.code).toBe(0);
    expect(result.findings).toHaveLength(0);
    expect(result.message).toContain("Tier-1 descriptor");
  });

  it("normalizes whitespace so multi-line / re-wrapped markers still match", () => {
    root = mkdtempSync(join(tmpdir(), "cursor-tier1-ws-"));
    for (const target of CURSOR_TIER1_TARGETS) {
      // Inject newlines + extra spaces inside each marker to prove normalization.
      const wrapped = target.markers.map((m) => m.replace(/ /g, "\n    ")).join("\n\n");
      writeTarget(root, target.path, `# Skill\n\n${wrapped}\n`);
    }
    const result = evaluateCursorTier1(root);
    expect(result.code).toBe(0);
  });

  it("exits 1 and names the missing marker when a matrix drops the Cursor descriptor", () => {
    root = mkdtempSync(join(tmpdir(), "cursor-tier1-missing-"));
    for (const target of CURSOR_TIER1_TARGETS) {
      // Drop the first marker from each target.
      const partial = target.markers.slice(1);
      writeTarget(root, target.path, bodyWithAllMarkers(partial));
    }
    const result = evaluateCursorTier1(root);
    expect(result.code).toBe(1);
    expect(result.findings.length).toBe(CURSOR_TIER1_TARGETS.length);
    expect(result.stream).toBe("stderr");
    const firstTarget = CURSOR_TIER1_TARGETS[0];
    expect(firstTarget).toBeDefined();
    const firstMarker = firstTarget?.markers[0];
    expect(firstMarker).toBeDefined();
    expect(result.message).toContain(firstMarker);
  });

  it("exits 2 when a required skill file is missing (config error)", () => {
    root = mkdtempSync(join(tmpdir(), "cursor-tier1-nofile-"));
    // Only seed the first target; the second is absent.
    const first = CURSOR_TIER1_TARGETS[0];
    expect(first).toBeDefined();
    if (first === undefined) {
      throw new Error("CURSOR_TIER1_TARGETS must be non-empty");
    }
    writeTarget(root, first.path, bodyWithAllMarkers(first.markers));
    const result = evaluateCursorTier1(root);
    expect(result.code).toBe(2);
    expect(result.message).toContain("required skill file not found");
  });

  it("preserves accumulated marker findings when a later target hits a config error", () => {
    root = mkdtempSync(join(tmpdir(), "cursor-tier1-combined-"));
    const present = { path: "a/PRESENT.md", label: "first surface", markers: ["alpha", "beta"] };
    const absent = { path: "b/ABSENT.md", label: "second surface", markers: ["gamma"] };
    // First target exists but drops a marker; second target file is absent.
    writeTarget(root, present.path, bodyWithAllMarkers(["alpha"]));
    const result = evaluateCursorTier1(root, { targets: [present, absent] });
    // Config error wins the exit code, but the earlier marker finding is not discarded.
    expect(result.code).toBe(2);
    expect(result.message).toContain("required skill file not found");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.path).toBe(present.path);
    expect(result.findings[0]?.missingMarkers).toContain("beta");
  });

  it("exits 2 when project root is not a directory", () => {
    const result = evaluateCursorTier1(join(tmpdir(), "definitely-not-a-real-dir-xyz"));
    expect(result.code).toBe(2);
    expect(result.message).toContain("not a directory");
  });

  it("suppresses the success message under --quiet", () => {
    root = seedCleanRoot();
    const result = evaluateCursorTier1(root, { quiet: true });
    expect(result.code).toBe(0);
    expect(result.message).toBe("");
  });

  it("normalizeWhitespace collapses runs of whitespace to single spaces", () => {
    expect(normalizeWhitespace("a   b\n\tc")).toBe("a b c");
  });
});
