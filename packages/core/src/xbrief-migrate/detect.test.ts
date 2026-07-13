import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LEGACY_ARTIFACT_DIR,
  LEGACY_ARTIFACT_SUFFIX,
  MIGRATED_ARTIFACT_DIR,
  VBRIEF_DEPRECATION_MARKER_BODY,
  VBRIEF_DEPRECATION_MARKER_FILENAME,
} from "./constants.js";
import { detectLegacyVbriefLayout, detectXbriefConvergence } from "./detect.js";

// Symlinks require elevated privileges on Windows (SeCreateSymbolicLink); skip there.
const itSymlink = it.skipIf(process.platform === "win32");

function writeXbriefStory(root: string): void {
  mkdirSync(join(root, MIGRATED_ARTIFACT_DIR, "active"), { recursive: true });
  writeFileSync(
    join(root, MIGRATED_ARTIFACT_DIR, "active", "story.xbrief.json"),
    JSON.stringify({
      xBRIEFInfo: { version: "0.8", description: "fixture" },
      plan: { title: "Migrated", status: "running", items: [] },
    }),
    "utf8",
  );
}

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

  it("detects a root-level .xbrief.json artifact (lines 88-95)", () => {
    // Root-level *.xbrief.json files are scanned separately from the vbrief/ directory.
    // This exercises the loop at lines 88-96 of detect.ts.
    const artifact = JSON.stringify(
      {
        xBRIEFInfo: { version: "0.8" },
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

describe("detectXbriefConvergence (#2270)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "xbrief-converge-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("classifies a bare project as none", () => {
    expect(detectXbriefConvergence(root).state).toBe("none");
  });

  it("classifies a canonical xbrief-only project", () => {
    writeXbriefStory(root);
    const conv = detectXbriefConvergence(root);
    expect(conv.state).toBe("xbrief-only");
    expect(conv.vbriefPresent).toBe(false);
    expect(conv.xbriefHasContent).toBe(true);
  });

  it("classifies an ambiguous empty vbrief/ alongside a populated xbrief/ as empty-vbrief", () => {
    writeXbriefStory(root);
    // Empty legacy lifecycle scaffolding — the dual-empty-root ambiguity (#2270).
    mkdirSync(join(root, LEGACY_ARTIFACT_DIR, "active"), { recursive: true });
    mkdirSync(join(root, LEGACY_ARTIFACT_DIR, "pending"), { recursive: true });
    const conv = detectXbriefConvergence(root);
    expect(conv.state).toBe("empty-vbrief");
    expect(conv.vbriefEmpty).toBe(true);
  });

  it("ignores .gitkeep placeholders when judging vbrief emptiness", () => {
    writeXbriefStory(root);
    mkdirSync(join(root, LEGACY_ARTIFACT_DIR, "active"), { recursive: true });
    writeFileSync(join(root, LEGACY_ARTIFACT_DIR, "active", ".gitkeep"), "", "utf8");
    expect(detectXbriefConvergence(root).state).toBe("empty-vbrief");
  });

  it("classifies a marked legacy root as xbrief-marker", () => {
    writeXbriefStory(root);
    mkdirSync(join(root, LEGACY_ARTIFACT_DIR, "active"), { recursive: true });
    writeFileSync(
      join(root, LEGACY_ARTIFACT_DIR, VBRIEF_DEPRECATION_MARKER_FILENAME),
      VBRIEF_DEPRECATION_MARKER_BODY,
      "utf8",
    );
    const conv = detectXbriefConvergence(root);
    expect(conv.state).toBe("xbrief-marker");
    expect(conv.vbriefHasMarker).toBe(true);
    expect(conv.vbriefEmpty).toBe(false);
  });

  it("classifies vbrief content with no canonical xbrief as legacy-only", () => {
    mkdirSync(join(root, LEGACY_ARTIFACT_DIR, "active"), { recursive: true });
    writeFileSync(
      join(root, LEGACY_ARTIFACT_DIR, "active", `story${LEGACY_ARTIFACT_SUFFIX}`),
      JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: { title: "t", items: [] } }),
      "utf8",
    );
    expect(detectXbriefConvergence(root).state).toBe("legacy-only");
  });

  itSymlink(
    "does not treat a vbrief/ holding only a symlink as empty (never wipes symlinked content)",
    () => {
      writeXbriefStory(root);
      const target = join(root, "target.txt");
      writeFileSync(target, "real content\n", "utf8");
      mkdirSync(join(root, LEGACY_ARTIFACT_DIR), { recursive: true });
      symlinkSync(target, join(root, LEGACY_ARTIFACT_DIR, "link.txt"));
      // A symlink is real content, so the tree is not the empty-vbrief cleanup case.
      expect(detectXbriefConvergence(root).state).not.toBe("empty-vbrief");
    },
  );

  it("classifies content in both roots (no marker) as dual-populated", () => {
    writeXbriefStory(root);
    mkdirSync(join(root, LEGACY_ARTIFACT_DIR, "active"), { recursive: true });
    writeFileSync(
      join(root, LEGACY_ARTIFACT_DIR, "active", `story${LEGACY_ARTIFACT_SUFFIX}`),
      JSON.stringify({ xBRIEFInfo: { version: "0.8" }, plan: { title: "t", items: [] } }),
      "utf8",
    );
    expect(detectXbriefConvergence(root).state).toBe("dual-populated");
  });
});
