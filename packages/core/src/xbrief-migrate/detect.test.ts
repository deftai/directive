import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LEGACY_ARTIFACT_DIR, LEGACY_ARTIFACT_SUFFIX } from "./constants.js";
import { detectLegacyVbriefLayout } from "./detect.js";

describe("detectLegacyVbriefLayout branch coverage", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "xbrief-detect-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("detects legacy version string in pretty-printed JSON (lines 57-58)", () => {
    // Pretty-printed JSON contains `"version": "0.6"` (with space after colon),
    // which triggers the LEGACY_VBRIEF_VERSION check in scanFileContent.
    mkdirSync(join(root, LEGACY_ARTIFACT_DIR, "active"), { recursive: true });
    const artifact = JSON.stringify(
      {
        vBRIEFInfo: { version: "0.6" },
        plan: { title: "t", status: "proposed", items: [] },
      },
      null,
      2,
    );
    writeFileSync(
      join(root, LEGACY_ARTIFACT_DIR, "active", `story${LEGACY_ARTIFACT_SUFFIX}`),
      artifact,
      "utf8",
    );

    const result = detectLegacyVbriefLayout(root);
    expect(result.legacyLayout).toBe(true);
    expect(result.reasons.some((r) => r.includes("declared version 0.6"))).toBe(true);
  });

  it("detects a root-level .vbrief.json artifact (lines 88-95)", () => {
    // Root-level *.vbrief.json files are scanned separately from the vbrief/ directory.
    // This exercises the loop at lines 88-96 of detect.ts.
    const artifact = JSON.stringify(
      {
        vBRIEFInfo: { version: "0.6" },
        plan: { title: "root", status: "proposed", items: [] },
      },
      null,
      2,
    );
    writeFileSync(join(root, `root-artifact${LEGACY_ARTIFACT_SUFFIX}`), artifact, "utf8");

    const result = detectLegacyVbriefLayout(root);
    expect(result.legacyLayout).toBe(true);
    expect(result.reasons.some((r) => r.includes("root-artifact"))).toBe(true);
  });

  it("returns legacyLayout=false for a project with no legacy artifacts", () => {
    const result = detectLegacyVbriefLayout(root);
    expect(result.legacyLayout).toBe(false);
    expect(result.reasons).toHaveLength(0);
  });

  it("scans xbrief/ dir for residual legacy tokens in mixed-state projects", () => {
    // A project where xbrief/ exists but a file inside still has x-vbrief/ references.
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    const artifact = JSON.stringify(
      {
        xBRIEFInfo: { version: "0.8" },
        plan: {
          title: "mixed",
          status: "running",
          items: [],
          references: [{ type: "x-vbrief/github-issue", uri: "https://example.com/1" }],
        },
      },
      null,
      2,
    );
    writeFileSync(join(root, "xbrief", "active", "story.xbrief.json"), artifact, "utf8");

    const result = detectLegacyVbriefLayout(root);
    expect(result.legacyLayout).toBe(true);
    expect(result.reasons.some((r) => r.includes("x-vbrief/"))).toBe(true);
  });
});
