import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VBRIEF_DEPRECATION_MARKER_BODY, VBRIEF_DEPRECATION_MARKER_FILENAME } from "./constants.js";
import { renderXbriefMigrationLine } from "./signpost.js";

const SAMPLE_V06 = {
  vBRIEFInfo: { version: "0.6", description: "fixture" },
  plan: { title: "Legacy", status: "running", items: [] },
} as const;

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("renderXbriefMigrationLine", () => {
  it("reports clean state on an xbrief tree", () => {
    const root = mkdtempSync(join(tmpdir(), "xbrief-signpost-clean-"));
    temps.push(root);
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "story.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8", description: "fixture" },
        plan: { title: "Migrated", status: "running", items: [] },
      }),
      "utf8",
    );

    expect(renderXbriefMigrationLine(root)).toContain("xBrief migration: none");
  });

  it("reports migrate-required for a pure legacy-only vbrief/ project (#2112)", () => {
    const root = mkdtempSync(join(tmpdir(), "xbrief-signpost-legacy-"));
    temps.push(root);
    mkdirSync(join(root, "vbrief", "active"), { recursive: true });
    mkdirSync(join(root, "vbrief", "pending"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", "active", "story.vbrief.json"),
      JSON.stringify(SAMPLE_V06),
      "utf8",
    );
    writeFileSync(
      join(root, "vbrief", "pending", "other.vbrief.json"),
      JSON.stringify(SAMPLE_V06),
      "utf8",
    );

    const line = renderXbriefMigrationLine(root);
    expect(line).toContain("migrate required");
    expect(line).toContain("only vbrief/ found");
    expect(line).toContain("migrate:xbrief");
  });

  it("reports an unambiguous xbrief-active + vbrief-removed state after migration [a2]", () => {
    const root = mkdtempSync(join(tmpdir(), "xbrief-signpost-removed-"));
    temps.push(root);
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "story.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8", description: "fixture" },
        plan: { title: "Migrated", status: "running", items: [] },
      }),
      "utf8",
    );

    const line = renderXbriefMigrationLine(root);
    expect(line).toContain("xbrief active");
    expect(line).toContain("vbrief removed");
    // Backward-compatible substring doctor asserts on.
    expect(line).toContain("xBrief migration: none");
  });

  it("reports an unambiguous xbrief-active + vbrief-legacy-marker state when retained [a2]", () => {
    const root = mkdtempSync(join(tmpdir(), "xbrief-signpost-marker-"));
    temps.push(root);
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "story.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8", description: "fixture" },
        plan: { title: "Migrated", status: "running", items: [] },
      }),
      "utf8",
    );
    mkdirSync(join(root, "vbrief"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", VBRIEF_DEPRECATION_MARKER_FILENAME),
      VBRIEF_DEPRECATION_MARKER_BODY,
      "utf8",
    );

    const line = renderXbriefMigrationLine(root);
    expect(line).toContain("xbrief active");
    expect(line).toContain("vbrief legacy marker");
    expect(line).not.toContain("dual");
  });

  it("calls out a stray empty vbrief/ as converge-pending, not a generic dead end", () => {
    const root = mkdtempSync(join(tmpdir(), "xbrief-signpost-empty-"));
    temps.push(root);
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "story.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8", description: "fixture" },
        plan: { title: "Migrated", status: "running", items: [] },
      }),
      "utf8",
    );
    mkdirSync(join(root, "vbrief", "active"), { recursive: true });

    const line = renderXbriefMigrationLine(root);
    expect(line).toContain("converge pending");
    expect(line).toContain("empty legacy vbrief/");
    expect(line).toContain("migrate:xbrief");
  });

  it("reports migrate-required for a dual-populated tree (#2112)", () => {
    const root = mkdtempSync(join(tmpdir(), "xbrief-signpost-dual-"));
    temps.push(root);
    mkdirSync(join(root, "vbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", "active", "legacy.vbrief.json"),
      JSON.stringify(SAMPLE_V06),
      "utf8",
    );
    mkdirSync(join(root, "xbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "xbrief", "active", "story.xbrief.json"),
      JSON.stringify({
        xBRIEFInfo: { version: "0.8", description: "fixture" },
        plan: { title: "Migrated", status: "running", items: [] },
      }),
      "utf8",
    );

    const line = renderXbriefMigrationLine(root);
    expect(line).toContain("migrate required");
    expect(line).toContain("both vbrief/ and xbrief/ found");
    expect(line).toContain("migrate:xbrief");
  });
});
