import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateOpenclawTier1, OPENCLAW_TIER1_TARGETS } from "./openclaw-tier1.js";

function writeTarget(root: string, relPath: string, body: string): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body, "utf8");
}

/** Build a file body that contains every required marker for a target. */
function bodyWithAllMarkers(markers: readonly string[]): string {
  return `# Surface\n\n${markers.map((m) => `Line referencing ${m} here.`).join("\n")}\n`;
}

function seedCleanRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "openclaw-tier1-"));
  for (const target of OPENCLAW_TIER1_TARGETS) {
    writeTarget(root, target.path, bodyWithAllMarkers(target.markers));
  }
  return root;
}

describe("evaluateOpenclawTier1", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("exits 0 when every OpenClaw Tier-1 marker is present", () => {
    root = seedCleanRoot();
    const result = evaluateOpenclawTier1(root);
    expect(result.code).toBe(0);
    expect(result.findings).toHaveLength(0);
    expect(result.message).toContain("Tier-1 descriptor");
  });

  it("normalizes whitespace so multi-line / re-wrapped markers still match", () => {
    root = mkdtempSync(join(tmpdir(), "openclaw-tier1-ws-"));
    for (const target of OPENCLAW_TIER1_TARGETS) {
      const wrapped = target.markers.map((m) => m.replace(/ /g, "\n    ")).join("\n\n");
      writeTarget(root, target.path, `# Surface\n\n${wrapped}\n`);
    }
    const result = evaluateOpenclawTier1(root);
    expect(result.code).toBe(0);
  });

  it("exits 1 and names the missing marker when a surface drops the OpenClaw descriptor", () => {
    root = mkdtempSync(join(tmpdir(), "openclaw-tier1-missing-"));
    for (const target of OPENCLAW_TIER1_TARGETS) {
      const partial = target.markers.slice(1);
      writeTarget(root, target.path, bodyWithAllMarkers(partial));
    }
    const result = evaluateOpenclawTier1(root);
    expect(result.code).toBe(1);
    expect(result.findings.length).toBe(OPENCLAW_TIER1_TARGETS.length);
    expect(result.stream).toBe("stderr");
    const firstTarget = OPENCLAW_TIER1_TARGETS[0];
    expect(firstTarget).toBeDefined();
    const firstMarker = firstTarget?.markers[0];
    expect(firstMarker).toBeDefined();
    expect(result.message).toContain(firstMarker);
  });

  it("exits 2 when a required surface file is missing (config error)", () => {
    root = mkdtempSync(join(tmpdir(), "openclaw-tier1-nofile-"));
    const first = OPENCLAW_TIER1_TARGETS[0];
    expect(first).toBeDefined();
    if (first === undefined) {
      throw new Error("OPENCLAW_TIER1_TARGETS must be non-empty");
    }
    writeTarget(root, first.path, bodyWithAllMarkers(first.markers));
    const result = evaluateOpenclawTier1(root);
    expect(result.code).toBe(2);
    expect(result.message).toContain("required surface file not found");
  });

  it("preserves accumulated marker findings when a later target hits a config error", () => {
    root = mkdtempSync(join(tmpdir(), "openclaw-tier1-combined-"));
    const present = { path: "a/PRESENT.md", label: "first surface", markers: ["alpha", "beta"] };
    const absent = { path: "b/ABSENT.md", label: "second surface", markers: ["gamma"] };
    writeTarget(root, present.path, bodyWithAllMarkers(["alpha"]));
    const result = evaluateOpenclawTier1(root, { targets: [present, absent] });
    expect(result.code).toBe(2);
    expect(result.message).toContain("required surface file not found");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.path).toBe(present.path);
    expect(result.findings[0]?.missingMarkers).toContain("beta");
  });

  it("exits 2 when project root is not a directory", () => {
    const result = evaluateOpenclawTier1(join(tmpdir(), "definitely-not-a-real-dir-xyz-openclaw"));
    expect(result.code).toBe(2);
    expect(result.message).toContain("not a directory");
  });

  it("suppresses the success message under --quiet", () => {
    root = seedCleanRoot();
    const result = evaluateOpenclawTier1(root, { quiet: true });
    expect(result.code).toBe(0);
    expect(result.message).toBe("");
  });

  it("exits 2 when a target path exists but is unreadable", () => {
    root = mkdtempSync(join(tmpdir(), "openclaw-tier1-unreadable-"));
    const present = {
      path: "a/PRESENT.md",
      label: "readable",
      markers: ["alpha"],
    };
    const blocked = {
      path: "b/BLOCKED",
      label: "directory-as-file",
      markers: ["beta"],
    };
    writeTarget(root, present.path, bodyWithAllMarkers(present.markers));
    // Directory where a file is expected: readFileSync throws EISDIR.
    mkdirSync(join(root, blocked.path), { recursive: true });
    const result = evaluateOpenclawTier1(root, { targets: [present, blocked] });
    expect(result.code).toBe(2);
    expect(result.message).toMatch(/could not read|EISDIR|directory/i);
  });

  it("reports non-Error throw messages when reading fails", () => {
    // Empty targets array: no findings, success path with non-quiet message.
    root = seedCleanRoot();
    const emptyTargets: { path: string; label: string; markers: readonly string[] }[] = [];
    const result = evaluateOpenclawTier1(root, { targets: emptyTargets });
    expect(result.code).toBe(0);
    expect(result.message).toContain("0 surface");
  });
});
