import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

  it("fails when xbrief published schema diverges from canonical", () => {
    const root = mkdtempSync(join(tmpdir(), "contract-drift-"));
    writeBoth(root, MINIMAL_V06_SCHEMA);
    writeFileSync(join(root, XBRIEF_PUBLISHED_SCHEMA_REL), "{}\n", "utf8");
    const result = evaluateContractDrift(root);
    expect(result.code).toBe(EXIT_DRIFT);
    expect(result.message).toContain(XBRIEF_PUBLISHED_SCHEMA_REL);
  });

  it("fails when VBRIEF_VERSION diverges from xbrief schema const", () => {
    const root = mkdtempSync(join(tmpdir(), "contract-drift-"));
    const bad = JSON.parse(MINIMAL_V08_SCHEMA) as Record<string, unknown>;
    const defs = bad.$defs as Record<string, unknown>;
    const info = defs.xBRIEFInfo as Record<string, unknown>;
    const properties = info.properties as Record<string, unknown>;
    properties.version = { const: "0.7" };
    writeBoth(root, MINIMAL_V06_SCHEMA, `${JSON.stringify(bad, null, 2)}\n`);
    const result = evaluateContractDrift(root);
    expect(result.code).toBe(EXIT_DRIFT);
    expect(result.message).toContain("VBRIEF_VERSION");
  });

  it("returns config error when schema JSON is invalid", () => {
    const root = mkdtempSync(join(tmpdir(), "contract-drift-"));
    writeBoth(root, "not-json");
    const result = evaluateContractDrift(root);
    expect(result.code).toBe(EXIT_CONFIG_ERROR);
    expect(result.message).toContain("config error");
  });

  it("returns config error when v06 schema lacks Status enum shape", () => {
    const root = mkdtempSync(join(tmpdir(), "contract-drift-"));
    writeBoth(root, JSON.stringify({ $defs: {} }, null, 2));
    const result = evaluateContractDrift(root);
    expect(result.code).toBe(EXIT_CONFIG_ERROR);
    expect(result.message).toContain("Status");
  });

  it("returns config error when v08 schema lacks xBRIEFInfo version const", () => {
    const root = mkdtempSync(join(tmpdir(), "contract-drift-"));
    writeBoth(root, MINIMAL_V06_SCHEMA, JSON.stringify({ $defs: {} }, null, 2));
    const result = evaluateContractDrift(root);
    expect(result.code).toBe(EXIT_CONFIG_ERROR);
    expect(result.message).toContain("xBRIEFInfo");
  });

  it("returns config error when v06 schema Status enum is not string-only", () => {
    const root = mkdtempSync(join(tmpdir(), "contract-drift-"));
    const bad = JSON.parse(MINIMAL_V06_SCHEMA) as Record<string, unknown>;
    const defs = bad.$defs as Record<string, unknown>;
    defs.Status = { enum: ["draft", 1] };
    writeBoth(root, `${JSON.stringify(bad, null, 2)}\n`);
    const result = evaluateContractDrift(root);
    expect(result.code).toBe(EXIT_CONFIG_ERROR);
    expect(result.message).toContain("Status.enum");
  });

  it("returns config error when readText throws while syncing schema pair", () => {
    const root = mkdtempSync(join(tmpdir(), "contract-drift-"));
    writeBoth(root, MINIMAL_V06_SCHEMA);
    const result = evaluateContractDrift(root, {
      readText(path) {
        const normalized = path.replace(/\\/g, "/");
        if (normalized.endsWith(PUBLISHED_SCHEMA_REL)) {
          throw new Error("denied");
        }
        return readFileSync(path, "utf8");
      },
    });
    expect(result.code).toBe(EXIT_CONFIG_ERROR);
    expect(result.message).toContain("could not read schema files");
  });

  it("returns config error when schema JSON is not an object", () => {
    const root = mkdtempSync(join(tmpdir(), "contract-drift-"));
    writeBoth(root, "[]");
    const result = evaluateContractDrift(root);
    expect(result.code).toBe(EXIT_CONFIG_ERROR);
    expect(result.message).toContain("not a JSON object");
  });

  it("returns config error when readText throws a non-Error value", () => {
    const root = mkdtempSync(join(tmpdir(), "contract-drift-"));
    writeBoth(root, MINIMAL_V06_SCHEMA);
    const result = evaluateContractDrift(root, {
      readText(path) {
        const normalized = path.replace(/\\/g, "/");
        if (normalized.endsWith(PUBLISHED_SCHEMA_REL)) {
          throw "denied";
        }
        return readFileSync(path, "utf8");
      },
    });
    expect(result.code).toBe(EXIT_CONFIG_ERROR);
    expect(result.message).toContain("denied");
  });

  it("returns config error when xbrief version const is not a string", () => {
    const root = mkdtempSync(join(tmpdir(), "contract-drift-"));
    const bad = JSON.parse(MINIMAL_V08_SCHEMA) as Record<string, unknown>;
    const defs = bad.$defs as Record<string, unknown>;
    const info = defs.xBRIEFInfo as Record<string, unknown>;
    const properties = info.properties as Record<string, unknown>;
    properties.version = { const: 1 };
    writeBoth(root, MINIMAL_V06_SCHEMA, `${JSON.stringify(bad, null, 2)}\n`);
    const result = evaluateContractDrift(root);
    expect(result.code).toBe(EXIT_CONFIG_ERROR);
    expect(result.message).toContain("version.const");
  });

  it("returns config error for malformed xbrief schema shape branches", () => {
    const root = mkdtempSync(join(tmpdir(), "contract-drift-"));
    const badStatus = JSON.parse(MINIMAL_V06_SCHEMA) as Record<string, unknown>;
    (badStatus.$defs as Record<string, unknown>).Status = [];
    writeBoth(root, `${JSON.stringify(badStatus, null, 2)}\n`);
    expect(evaluateContractDrift(root).message).toContain("$defs.Status");

    const badInfo = JSON.parse(MINIMAL_V08_SCHEMA) as Record<string, unknown>;
    (badInfo.$defs as Record<string, unknown>).xBRIEFInfo = null;
    writeBoth(root, MINIMAL_V06_SCHEMA, `${JSON.stringify(badInfo, null, 2)}\n`);
    expect(evaluateContractDrift(root).message).toContain("$defs.xBRIEFInfo");

    const badProps = JSON.parse(MINIMAL_V08_SCHEMA) as Record<string, unknown>;
    const info = (badProps.$defs as Record<string, unknown>).xBRIEFInfo as Record<string, unknown>;
    info.properties = null;
    writeBoth(root, MINIMAL_V06_SCHEMA, `${JSON.stringify(badProps, null, 2)}\n`);
    expect(evaluateContractDrift(root).message).toContain("xBRIEFInfo.properties");

    const badVersion = JSON.parse(MINIMAL_V08_SCHEMA) as Record<string, unknown>;
    const info2 = (badVersion.$defs as Record<string, unknown>).xBRIEFInfo as Record<
      string,
      unknown
    >;
    const props = info2.properties as Record<string, unknown>;
    props.version = null;
    writeBoth(root, MINIMAL_V06_SCHEMA, `${JSON.stringify(badVersion, null, 2)}\n`);
    expect(evaluateContractDrift(root).message).toContain("properties.version");
  });

  it("returns config error when schema $defs is not an object", () => {
    const root = mkdtempSync(join(tmpdir(), "contract-drift-"));
    writeBoth(root, JSON.stringify({ $defs: [] }, null, 2));
    const result = evaluateContractDrift(root);
    expect(result.code).toBe(EXIT_CONFIG_ERROR);
    expect(result.message).toContain("schema missing $defs");
  });

  it("returns config error when Status enum is not an array", () => {
    const root = mkdtempSync(join(tmpdir(), "contract-drift-"));
    const bad = JSON.parse(MINIMAL_V06_SCHEMA) as Record<string, unknown>;
    (bad.$defs as Record<string, unknown>).Status = { enum: "draft" };
    writeBoth(root, `${JSON.stringify(bad, null, 2)}\n`);
    const result = evaluateContractDrift(root);
    expect(result.code).toBe(EXIT_CONFIG_ERROR);
    expect(result.message).toContain("Status.enum");
  });

  it("returns config error when Status node is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "contract-drift-"));
    writeBoth(root, JSON.stringify({ $defs: {} }, null, 2));
    const result = evaluateContractDrift(root);
    expect(result.code).toBe(EXIT_CONFIG_ERROR);
    expect(result.message).toContain("$defs.Status");
  });
});
