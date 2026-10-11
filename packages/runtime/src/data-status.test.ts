/**
 * Doctor data-status discriminant tests (Wave 2b / AC4.10).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DATA_SCHEMA_MARKER_REL, CURRENT_DATA_SCHEMA_VERSION } from "./migrate.js";
import { readProjectDataStatus } from "./data-status.js";

const TEMPS: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "data-status-2b-"));
  TEMPS.push(root);
  return root;
}

afterEach(() => {
  while (TEMPS.length > 0) {
    const p = TEMPS.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

describe("readProjectDataStatus (AC4.10)", () => {
  it("reports migration_needed when marker missing", () => {
    const root = tempRoot();
    const status = readProjectDataStatus(root);
    expect(status.contract).toBe(1);
    expect(status.dataStatus).toBe("migration_needed");
  });

  it("reports current when marker matches current schema", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".deft", "directive"), { recursive: true });
    writeFileSync(
      join(root, DATA_SCHEMA_MARKER_REL),
      `${JSON.stringify({ schemaVersion: CURRENT_DATA_SCHEMA_VERSION }, null, 2)}\n`,
    );
    expect(readProjectDataStatus(root).dataStatus).toBe("current");
  });

  it("reports migration_needed when marker behind", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".deft", "directive"), { recursive: true });
    writeFileSync(
      join(root, DATA_SCHEMA_MARKER_REL),
      `${JSON.stringify({ schemaVersion: 0 }, null, 2)}\n`,
    );
    expect(readProjectDataStatus(root).dataStatus).toBe("migration_needed");
  });

  it("reports diagnosis_failed on unreadable marker", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".deft", "directive"), { recursive: true });
    writeFileSync(join(root, DATA_SCHEMA_MARKER_REL), "not-json{{{");
    expect(readProjectDataStatus(root).dataStatus).toBe("diagnosis_failed");
  });
});
