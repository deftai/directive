/**
 * Contract migrate entry tests (Wave 2b / AC7.8 / F-017 / AC14.18).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContainedWriteError,
  ContainedWriteErrorCode,
  type ContainedWriteInput,
  type ContainedWriteResult,
} from "@deftai/directive-core/dist/fs/contained-write.js";
import { afterEach, describe, expect, it } from "vitest";
import { readProjectDataStatus } from "./data-status.js";
import {
  CURRENT_DATA_SCHEMA_VERSION,
  DATA_SCHEMA_MARKER_REL,
  projectNeedsXbriefMigration,
  runMigrate,
} from "./migrate.js";

const TEMPS: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "migrate-2b-"));
  TEMPS.push(root);
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "t", version: "0.0.0", private: true }, null, 2)}\n`,
  );
  return root;
}

afterEach(() => {
  while (TEMPS.length > 0) {
    const p = TEMPS.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

describe("runMigrate (R7 / AC7.8)", () => {
  it("creates schema marker and reports JSON changes when missing", () => {
    const root = tempRoot();
    const result = runMigrate({ from: "1.0.0", root });
    expect(result.contract).toBe(1);
    expect(result.entry).toBe("migrate");
    expect(result.stub).toBe(false);
    expect(existsSync(join(root, DATA_SCHEMA_MARKER_REL))).toBe(true);
    const marker = JSON.parse(readFileSync(join(root, DATA_SCHEMA_MARKER_REL), "utf8")) as {
      schemaVersion: number;
    };
    expect(marker.schemaVersion).toBe(CURRENT_DATA_SCHEMA_VERSION);
    expect(result.migrated).toContain(DATA_SCHEMA_MARKER_REL);
    expect(result.created.length + result.modified.length).toBeGreaterThan(0);
  });

  it("idempotent retry preserves completed work (empty changes)", () => {
    const root = tempRoot();
    const first = runMigrate({ from: "1.0.0", root });
    expect(first.migrated.length).toBeGreaterThan(0);
    const second = runMigrate({ from: "1.0.0", root });
    expect(second.migrated).toEqual([]);
    expect(second.created).toEqual([]);
    expect(second.modified).toEqual([]);
  });

  it("bumps an older schema marker", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".deft", "directive"), { recursive: true });
    writeFileSync(
      join(root, DATA_SCHEMA_MARKER_REL),
      `${JSON.stringify({ schemaVersion: 0 }, null, 2)}\n`,
    );
    const result = runMigrate({ from: "0.9.0", root });
    expect(result.migrated).toContain(DATA_SCHEMA_MARKER_REL);
    const marker = JSON.parse(readFileSync(join(root, DATA_SCHEMA_MARKER_REL), "utf8")) as {
      schemaVersion: number;
    };
    expect(marker.schemaVersion).toBe(CURRENT_DATA_SCHEMA_VERSION);
  });

  it("refuses to overwrite an unreadable schema marker (Greptile P2)", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".deft", "directive"), { recursive: true });
    const abs = join(root, DATA_SCHEMA_MARKER_REL);
    const before = "not-json{{{";
    writeFileSync(abs, before);
    const result = runMigrate({ from: "1.0.0", root });
    expect(result.message).toMatch(/migrate failed:.*unreadable/i);
    expect(result.migrated).toEqual([]);
    expect(readFileSync(abs, "utf8")).toBe(before);
  });

  it("refuses to overwrite a newer schema marker (Greptile P2)", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".deft", "directive"), { recursive: true });
    const abs = join(root, DATA_SCHEMA_MARKER_REL);
    const newer = CURRENT_DATA_SCHEMA_VERSION + 1;
    const before = `${JSON.stringify({ schemaVersion: newer }, null, 2)}\n`;
    writeFileSync(abs, before);
    const result = runMigrate({ from: "1.0.0", root });
    expect(result.message).toMatch(/migrate failed:.*newer/i);
    expect(result.migrated).toEqual([]);
    expect(readFileSync(abs, "utf8")).toBe(before);
  });

  it("F-017: runMigrate migrates vbrief@0.5 to xbrief@0.8 and surfaces archived", () => {
    const root = tempRoot();
    mkdirSync(join(root, "vbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", "active", "story.vbrief.json"),
      `${JSON.stringify({
        vBRIEFInfo: {
          version: "0.5",
          description: "contract-migrate",
          created: "2026-06-01T00:00:00Z",
        },
        plan: { title: "Story", status: "running", items: [] },
      })}\n`,
      "utf8",
    );
    writeFileSync(join(root, "vbrief", "active", "bad.vbrief.json"), "{nope\n", "utf8");
    execFileSync("git", ["init"], { cwd: root });

    expect(projectNeedsXbriefMigration(root)).toBe(true);
    expect(readProjectDataStatus(root).dataStatus).toBe("migration_needed");

    const result = runMigrate({ from: "old-style", root });
    expect(result.message).not.toMatch(/^migrate failed/);
    expect(result.conflicts).toEqual([]);
    expect(existsSync(join(root, DATA_SCHEMA_MARKER_REL))).toBe(true);
    expect(existsSync(join(root, "vbrief"))).toBe(false);
    expect(existsSync(join(root, "xbrief", "active", "story.xbrief.json"))).toBe(true);
    const body = JSON.parse(
      readFileSync(join(root, "xbrief", "active", "story.xbrief.json"), "utf8"),
    );
    expect(body.xBRIEFInfo.version).toBe("0.8");
    expect(result.archived.some((p) => p.includes("archive") && p.includes("bad"))).toBe(true);
    expect(existsSync(join(root, "xbrief", "archive", "README.md"))).toBe(true);
    // Must not leave empty xbrief + full vbrief (F-017 defect shape).
    expect(existsSync(join(root, "xbrief", "active", "story.xbrief.json"))).toBe(true);

    expect(projectNeedsXbriefMigration(root)).toBe(false);
    expect(readProjectDataStatus(root).dataStatus).toBe("current");
  });

  it("AC14.18: marker ContainedWrite failure preserves xbrief migrated + conflicts", () => {
    const root = tempRoot();
    mkdirSync(join(root, "vbrief", "active"), { recursive: true });
    writeFileSync(
      join(root, "vbrief", "active", "story.vbrief.json"),
      `${JSON.stringify({
        vBRIEFInfo: {
          version: "0.5",
          description: "partial-fail",
          created: "2026-06-01T00:00:00Z",
        },
        plan: { title: "Story", status: "running", items: [] },
      })}\n`,
      "utf8",
    );
    execFileSync("git", ["init"], { cwd: root });

    const result = runMigrate({
      from: "1.0.0",
      root,
      write: (_input: ContainedWriteInput): ContainedWriteResult => {
        throw new ContainedWriteError("injected marker write failure", {
          code: ContainedWriteErrorCode.IO,
          root,
          target: DATA_SCHEMA_MARKER_REL,
        });
      },
    });

    expect(result.message).toMatch(/^migrate failed:/);
    expect(result.migrated.length).toBeGreaterThan(0);
    expect(result.migrated.some((p) => p.includes("xbrief") || p.includes("vbrief"))).toBe(true);
    expect(result.conflicts).toEqual([DATA_SCHEMA_MARKER_REL]);
    // Marker must not have been written; xbrief migration must have landed.
    expect(existsSync(join(root, DATA_SCHEMA_MARKER_REL))).toBe(false);
    expect(existsSync(join(root, "xbrief", "active", "story.xbrief.json"))).toBe(true);

    // Contract JSON shape includes conflicts + migrated for bookend parse.
    const serialized = JSON.parse(JSON.stringify(result)) as {
      migrated: string[];
      conflicts: string[];
      message: string;
    };
    expect(serialized.conflicts).toEqual([DATA_SCHEMA_MARKER_REL]);
    expect(serialized.migrated.length).toBeGreaterThan(0);
  });
});
