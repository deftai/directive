import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_SCHEMA_REL,
  EXIT_CONFIG_ERROR,
  EXIT_DRIFT,
  EXIT_OK,
  evaluateContractDrift,
  PUBLISHED_SCHEMA_REL,
  XBRIEF_CANONICAL_SCHEMA_REL,
  XBRIEF_PUBLISHED_SCHEMA_REL,
} from "./contract-drift.js";

const MINIMAL_V06_SCHEMA = JSON.stringify(
  {
    $defs: {
      Status: {
        enum: [
          "draft",
          "proposed",
          "approved",
          "pending",
          "running",
          "completed",
          "blocked",
          "failed",
          "cancelled",
        ],
      },
      vBRIEFInfo: { properties: { version: { const: "0.6" } } },
    },
  },
  null,
  2,
);

const MINIMAL_V08_SCHEMA = JSON.stringify(
  {
    $defs: {
      xBRIEFInfo: { properties: { version: { const: "0.8" } } },
    },
  },
  null,
  2,
);

function writeSchemaPair(
  root: string,
  canonicalRel: string,
  publishedRel: string,
  text: string,
): void {
  mkdirSync(join(root, ...canonicalRel.split("/").slice(0, -1)), { recursive: true });
  mkdirSync(join(root, ...publishedRel.split("/").slice(0, -1)), { recursive: true });
  writeFileSync(join(root, canonicalRel), text, "utf8");
  writeFileSync(join(root, publishedRel), text, "utf8");
}

function writeBoth(root: string, v06Text: string, v08Text = MINIMAL_V08_SCHEMA): void {
  writeSchemaPair(root, CANONICAL_SCHEMA_REL, PUBLISHED_SCHEMA_REL, v06Text);
  writeSchemaPair(root, XBRIEF_CANONICAL_SCHEMA_REL, XBRIEF_PUBLISHED_SCHEMA_REL, v08Text);
}

describe("evaluateContractDrift (#1799, #2107)", () => {
  it("passes when canonical and published schemas match TS constants", () => {
    const root = mkdtempSync(join(tmpdir(), "contract-drift-"));
    writeBoth(root, MINIMAL_V06_SCHEMA);
    const result = evaluateContractDrift(root);
    expect(result.code).toBe(EXIT_OK);
  });

  it("fails when published schema diverges from canonical", () => {
    const root = mkdtempSync(join(tmpdir(), "contract-drift-"));
    writeBoth(root, MINIMAL_V06_SCHEMA);
    writeFileSync(join(root, PUBLISHED_SCHEMA_REL), "{}\n", "utf8");
    const result = evaluateContractDrift(root);
    expect(result.code).toBe(EXIT_DRIFT);
    expect(result.message).toContain("out of sync");
  });

  it("fails when Status enum diverges from VALID_STATUSES", () => {
    const root = mkdtempSync(join(tmpdir(), "contract-drift-"));
    const bad = JSON.parse(MINIMAL_V06_SCHEMA) as Record<string, unknown>;
    const defs = bad.$defs as Record<string, unknown>;
    defs.Status = { enum: ["draft"] };
    writeBoth(root, `${JSON.stringify(bad, null, 2)}\n`);
    const result = evaluateContractDrift(root);
    expect(result.code).toBe(EXIT_DRIFT);
    expect(result.message).toContain("VALID_STATUSES");
  });

  it("returns config error when schema files are missing", () => {
    const root = mkdtempSync(join(tmpdir(), "contract-drift-"));
    const result = evaluateContractDrift(root);
    expect(result.code).toBe(EXIT_CONFIG_ERROR);
  });
});
