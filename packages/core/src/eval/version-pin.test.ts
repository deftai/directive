import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  aggregateCellWithVersionPurity,
  applyVersionPinToSharedBenchmark,
  evaluateCellVersionPurity,
  evaluateLedgerVersionPurity,
  loadSharedBenchmarkManifest,
  resolveFrameworkVersionPin,
  SHARED_BENCHMARK_MANIFEST_REL,
  wireFrameworkVersionIntoManifest,
} from "./version-pin.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function seedProject(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-version-pin-"));
  temps.push(root);
  return root;
}

describe("resolveFrameworkVersionPin", () => {
  it("records an override as the stable pin for the run", () => {
    const pin = resolveFrameworkVersionPin({
      override: "0.99.0-pin-test",
      now: () => new Date("2026-08-09T12:00:00.000Z"),
    });
    expect(pin).toEqual({
      frameworkVersion: "0.99.0-pin-test",
      source: "override",
      resolvedAt: "2026-08-09T12:00:00Z",
    });
  });

  it("falls back to package.json when no override is provided", () => {
    const pin = resolveFrameworkVersionPin({
      now: () => new Date("2026-08-09T12:00:00.000Z"),
    });
    expect(pin.source).toBe("package.json");
    expect(pin.frameworkVersion.length).toBeGreaterThan(0);
    expect(pin.resolvedAt).toBe("2026-08-09T12:00:00Z");
  });

  it("ignores blank overrides and uses package.json", () => {
    const pin = resolveFrameworkVersionPin({ override: "   " });
    expect(pin.source).toBe("package.json");
  });
});

describe("evaluateCellVersionPurity", () => {
  it("marks a single-version treatment cell as pure", () => {
    const purity = evaluateCellVersionPurity(
      [
        { frameworkVersion: "0.98.0", treatment: "with_skill", runId: "a" },
        { frameworkVersion: "0.98.0", treatment: "with_skill", runId: "b" },
      ],
      "with_skill",
    );
    expect(purity.pure).toBe(true);
    expect(purity.frameworkVersion).toBe("0.98.0");
    expect(purity.runCount).toBe(2);
    expect(purity.message).toContain("version-pure");
  });

  it("flags mixed framework versions within one treatment", () => {
    const purity = evaluateCellVersionPurity([
      { frameworkVersion: "0.97.0", treatment: "with_skill" },
      { frameworkVersion: "0.98.0", treatment: "with_skill" },
    ]);
    expect(purity.pure).toBe(false);
    expect(purity.frameworkVersion).toBeNull();
    expect(purity.versions).toEqual(["0.97.0", "0.98.0"]);
    expect(purity.message).toMatch(/mixed framework versions/);
  });

  it("treats empty cells as vacuously pure", () => {
    const purity = evaluateCellVersionPurity([], "empty");
    expect(purity.pure).toBe(true);
    expect(purity.runCount).toBe(0);
  });
});

describe("aggregateCellWithVersionPurity", () => {
  const mixed = [
    { frameworkVersion: "0.97.0", treatment: "t", runId: "1" },
    { frameworkVersion: "0.98.0", treatment: "t", runId: "2" },
  ];

  it("refuses mixed-version aggregation by default", () => {
    const result = aggregateCellWithVersionPurity({ runs: mixed, treatment: "t" });
    expect(result.allowed).toBe(false);
    expect(result.policy).toBe("refuse");
    expect(result.purity.pure).toBe(false);
  });

  it("flags but allows mixed cells under flag policy", () => {
    const result = aggregateCellWithVersionPurity({
      runs: mixed,
      treatment: "t",
      policy: "flag",
    });
    expect(result.allowed).toBe(true);
    expect(result.purity.pure).toBe(false);
    expect(result.policy).toBe("flag");
  });

  it("allows pure cells under refuse policy", () => {
    const result = aggregateCellWithVersionPurity({
      runs: [
        { frameworkVersion: "1.0.0", treatment: "t" },
        { frameworkVersion: "1.0.0", treatment: "t" },
      ],
      treatment: "t",
      policy: "refuse",
    });
    expect(result.allowed).toBe(true);
    expect(result.frameworkVersion).toBe("1.0.0");
  });
});

describe("evaluateLedgerVersionPurity", () => {
  it("groups by treatment and reports mixed cells", () => {
    const result = evaluateLedgerVersionPurity([
      { frameworkVersion: "0.97.0", treatment: "A", model: "m" },
      { frameworkVersion: "0.98.0", treatment: "A", model: "m" },
      { frameworkVersion: "0.98.0", treatment: "B", model: "m" },
    ]);
    expect(result.pure).toBe(false);
    expect(result.cells).toHaveLength(2);
    expect(result.summary).toMatch(/1\/2 cell/);
    const cellA = result.cells.find((c) => c.treatment === "A");
    expect(cellA?.pure).toBe(false);
    const cellB = result.cells.find((c) => c.treatment === "B");
    expect(cellB?.pure).toBe(true);
  });

  it("falls back to model@harness when treatment is absent", () => {
    const result = evaluateLedgerVersionPurity([
      { frameworkVersion: "1.0.0", model: "composer", harness: "det" },
      { frameworkVersion: "1.0.0", model: "composer", harness: "det" },
    ]);
    expect(result.pure).toBe(true);
    expect(result.cells[0]?.treatment).toBe("composer@det");
  });
});

describe("shared-benchmark manifest wire (#1584)", () => {
  it("stamps frameworkVersion into a #1584-shaped manifest object", () => {
    const pin = resolveFrameworkVersionPin({
      override: "0.98.1",
      now: () => new Date("2026-08-09T15:00:00.000Z"),
    });
    const wired = wireFrameworkVersionIntoManifest(
      { name: "directive-shared-benchmark", cases: [] },
      pin,
    );
    expect(wired.frameworkVersion).toBe("0.98.1");
    expect(wired.metadata).toMatchObject({
      frameworkVersion: "0.98.1",
      frameworkVersionSource: "override",
      frameworkVersionResolvedAt: "2026-08-09T15:00:00Z",
      versionPurityGate: "#3215",
    });
    expect(wired.name).toBe("directive-shared-benchmark");
  });

  it("applies pin when evals/shared-benchmark.json is present", () => {
    const root = seedProject();
    mkdirSync(join(root, "evals"), { recursive: true });
    writeFileSync(
      join(root, SHARED_BENCHMARK_MANIFEST_REL),
      JSON.stringify({ name: "shared", metadata: { harness: "skill-eval-harness" } }),
      "utf8",
    );
    const pin = resolveFrameworkVersionPin({ override: "0.99.0" });
    const { applied, manifest } = applyVersionPinToSharedBenchmark(root, pin);
    expect(applied).toBe(true);
    expect(manifest?.frameworkVersion).toBe("0.99.0");
    expect(manifest?.metadata).toMatchObject({
      harness: "skill-eval-harness",
      frameworkVersion: "0.99.0",
      versionPurityGate: "#3215",
    });
  });

  it("no-ops when shared-benchmark manifest is absent", () => {
    const root = seedProject();
    const pin = resolveFrameworkVersionPin({ override: "0.99.0" });
    const { applied, manifest } = applyVersionPinToSharedBenchmark(root, pin);
    expect(applied).toBe(false);
    expect(manifest).toBeNull();
    expect(loadSharedBenchmarkManifest(root)).toBeNull();
  });
});
