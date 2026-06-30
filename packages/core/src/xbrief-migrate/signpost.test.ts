import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

  it("signposts legacy vbrief layout with migrate:xbrief guidance", () => {
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
    expect(line).toContain("legacy vbrief layout detected");
    expect(line).toContain("migrate:xbrief");
    expect(line).toContain("more marker(s)");
  });
});
