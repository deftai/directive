import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BYTE_DIFF_WHOLE_FILE_THRESHOLD,
  classifyByteDiffMinimality,
  computeChangedByteRatio,
  crudMetricsHistoryPath,
  InstrumentedVbriefCrud,
  persistCrudMetrics,
} from "./crud-telemetry.js";

const VALID_VBRIEF = `{
  "vBRIEFInfo": {
    "version": "0.6",
    "description": "fixture"
  },
  "plan": {
    "id": "fixture-story",
    "title": "Fixture story",
    "status": "pending",
    "narratives": {
      "Description": "A valid fixture document."
    },
    "items": [
      {
        "id": "fixture-a1",
        "title": "First item",
        "status": "pending",
        "narrative": {
          "Acceptance": "Passes schema validation."
        }
      }
    ]
  }
}`;

const VALID_VBRIEF_SURGICAL_UPDATE = VALID_VBRIEF.replace('"pending"', '"running"');

const VALID_VBRIEF_MINIFIED = JSON.stringify(JSON.parse(VALID_VBRIEF));

const VALID_VBRIEF_WHOLE_FILE_REWRITE = JSON.stringify(JSON.parse(VALID_VBRIEF), null, 2);

const FIELD_INVENTION_VBRIEF = `{
  "vBRIEFInfo": {
    "version": "0.6",
    "description": "fixture"
  },
  "plan": {
    "id": "fixture-story",
    "title": "Fixture story",
    "status": "pending",
    "narratives": {
      "Description": "Contains an invented key."
    },
    "items": [],
    "agentInventedField": "not in spec"
  }
}`;

const INVALID_SCHEMA_VBRIEF = `{
  "vBRIEFInfo": {
    "version": "0.6"
  },
  "plan": {
    "status": "not-a-real-status"
  }
}`;

describe("computeChangedByteRatio", () => {
  it("returns zero for identical strings", () => {
    expect(computeChangedByteRatio("abc", "abc")).toBe(0);
  });

  it("returns one for completely different equal-length strings", () => {
    expect(computeChangedByteRatio("abc", "xyz")).toBe(1);
  });
});

describe("classifyByteDiffMinimality", () => {
  it("labels localized edits as surgical", () => {
    const result = classifyByteDiffMinimality(VALID_VBRIEF, VALID_VBRIEF_SURGICAL_UPDATE);
    expect(result.kind).toBe("surgical");
    expect(result.changedRatio).toBeLessThan(BYTE_DIFF_WHOLE_FILE_THRESHOLD);
  });

  it("treats a prefix insertion as surgical rather than a whole-file rewrite", () => {
    const inserted = `{"x":1,${VALID_VBRIEF_MINIFIED.slice(1)}`;
    const result = classifyByteDiffMinimality(VALID_VBRIEF_MINIFIED, inserted);
    expect(result.kind).toBe("surgical");
    expect(result.changedRatio).toBeLessThan(BYTE_DIFF_WHOLE_FILE_THRESHOLD);
  });

  it("labels pretty-print re-serialization as whole-file rewrite", () => {
    const result = classifyByteDiffMinimality(
      VALID_VBRIEF_MINIFIED,
      VALID_VBRIEF_WHOLE_FILE_REWRITE,
    );
    expect(result.kind).toBe("whole-file-rewrite");
    expect(result.changedRatio).toBeGreaterThan(0);
  });
});

describe("InstrumentedVbriefCrud", () => {
  let tempDir = "";

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  function makeCrud(version = "9.9.9-test") {
    tempDir = mkdtempSync(join(tmpdir(), "crud-telemetry-"));
    const crud = new InstrumentedVbriefCrud({
      directiveVersion: version,
      now: () => new Date("2026-07-05T18:00:00.000Z"),
    });
    return { crud, filePath: join(tempDir, "fixture.xbrief.json") };
  }

  it("records per-operation metrics tagged with the directive version", () => {
    const { crud, filePath } = makeCrud("1.2.3-tier1");

    expect(crud.create(filePath, VALID_VBRIEF).ok).toBe(true);
    expect(crud.read(filePath).ok).toBe(true);
    expect(crud.update(filePath, VALID_VBRIEF_SURGICAL_UPDATE).ok).toBe(true);
    expect(crud.delete(filePath).ok).toBe(true);

    const metrics = crud.getMetrics();
    expect(metrics).toHaveLength(4);
    expect(metrics.map((metric) => metric.operation)).toEqual([
      "create",
      "read",
      "update",
      "delete",
    ]);
    for (const metric of metrics) {
      expect(metric.directiveVersion).toBe("1.2.3-tier1");
      expect(metric.recordedAt).toBe("2026-07-05T18:00:00.000Z");
    }
  });

  it("records schema-validity failures without writing invalid create payloads", () => {
    const { crud, filePath } = makeCrud();

    const result = crud.create(filePath, INVALID_SCHEMA_VBRIEF);
    expect(result.ok).toBe(false);

    const metric = crud.getMetrics()[0];
    expect(metric?.schemaValid).toBe(false);
    expect(metric?.schemaErrors.length).toBeGreaterThan(0);
    expect(() => readFileSync(filePath, "utf8")).toThrow();
  });

  it("records field-invention metrics for non-spec keys", () => {
    const { crud, filePath } = makeCrud();

    expect(crud.create(filePath, FIELD_INVENTION_VBRIEF).ok).toBe(true);

    const metric = crud.getMetrics()[0];
    expect(metric?.schemaValid).toBe(true);
    expect(metric?.fieldInventionCount).toBe(1);
    expect(metric?.inventedKeys).toContain("agentInventedField");
  });

  it("deletes corrupt JSON files for cleanup", () => {
    const { crud, filePath } = makeCrud();

    writeFileSync(filePath, "{not-json", "utf8");
    expect(crud.delete(filePath).ok).toBe(true);
    expect(existsSync(filePath)).toBe(false);

    const metric = crud.getMetrics()[0];
    expect(metric?.schemaValid).toBe(false);
  });

  it("persists byte-diff minimality distinguishing surgical updates from whole-file rewrites", () => {
    const { crud, filePath } = makeCrud();
    const minifiedRunning = VALID_VBRIEF_MINIFIED.replace('"pending"', '"running"');

    expect(crud.create(filePath, VALID_VBRIEF_MINIFIED).ok).toBe(true);
    crud.clearMetrics();

    expect(crud.update(filePath, minifiedRunning).ok).toBe(true);
    const surgicalMetric = crud.getMetrics()[0];
    expect(surgicalMetric?.byteDiffMinimality).toBe("surgical");
    expect(surgicalMetric?.byteDiffChangedRatio).not.toBeNull();

    const wholeFileRewrite = JSON.stringify(JSON.parse(minifiedRunning), null, 2);
    expect(crud.update(filePath, wholeFileRewrite).ok).toBe(true);
    const rewriteMetric = crud.getMetrics()[1];
    expect(rewriteMetric?.byteDiffMinimality).toBe("whole-file-rewrite");
    expect(rewriteMetric?.byteDiffChangedRatio).not.toBeNull();
  });

  it("skips byte-diff computation for trusted lifecycle writes", () => {
    const { crud, filePath } = makeCrud();

    expect(crud.create(filePath, VALID_VBRIEF).ok).toBe(true);
    crud.clearMetrics();

    expect(crud.update(filePath, VALID_VBRIEF_WHOLE_FILE_REWRITE, { trustedWrite: true }).ok).toBe(
      true,
    );
    const metric = crud.getMetrics()[0];
    expect(metric?.byteDiffMinimality).toBeNull();
    expect(metric?.byteDiffChangedRatio).toBeNull();
  });

  it("appends metrics to the versioned CRUD ledger", () => {
    tempDir = mkdtempSync(join(tmpdir(), "crud-telemetry-"));
    const filePath = join(tempDir, "xbrief", "active", "fixture.xbrief.json");
    mkdirSync(dirname(filePath), { recursive: true });
    const crud = new InstrumentedVbriefCrud({ directiveVersion: "ledger-test" });

    expect(crud.create(filePath, VALID_VBRIEF).ok).toBe(true);
    persistCrudMetrics(tempDir, crud.getMetrics());

    const ledgerPath = crudMetricsHistoryPath(tempDir);
    expect(existsSync(ledgerPath)).toBe(true);
    const lines = readFileSync(ledgerPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed: unknown = JSON.parse(lines[0] ?? "{}");
    expect(parsed).not.toBeNull();
    expect(typeof parsed).toBe("object");
    const persisted = parsed as { directiveVersion?: string };
    expect(persisted.directiveVersion).toBe("ledger-test");
  });
});
