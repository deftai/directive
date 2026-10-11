/**
 * Contract migrate entry tests (Wave 2b / AC7.8).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CURRENT_DATA_SCHEMA_VERSION,
  DATA_SCHEMA_MARKER_REL,
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
});
