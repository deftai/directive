import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GOLDEN_CORPUS,
  goldenRunsHistoryPath,
  holdoutRotationIndex,
  persistGoldenRun,
  runGoldenEval,
  selectRotatingHoldoutTask,
} from "./run.js";

const itSymlink = it.skipIf(process.platform === "win32");

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function seedProject(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-golden-eval-"));
  temps.push(root);
  return root;
}

describe("GOLDEN_CORPUS", () => {
  it("includes primary tasks and holdout tasks", () => {
    expect(GOLDEN_CORPUS.some((task) => !task.holdout)).toBe(true);
    expect(GOLDEN_CORPUS.some((task) => task.holdout)).toBe(true);
  });
});

describe("holdout rotation", () => {
  it("selects a stable holdout task for a version × model tuple", () => {
    const first = selectRotatingHoldoutTask("1.0.0", "composer");
    const second = selectRotatingHoldoutTask("1.0.0", "composer");
    expect(first?.holdout).toBe(true);
    expect(second?.id).toBe(first?.id);
  });

  it("rotates holdout selection across directive versions", () => {
    const holdouts = GOLDEN_CORPUS.filter((task) => task.holdout);
    const indices = new Set(
      ["0.70.0", "0.71.0", "0.72.0", "0.73.0", "0.74.0"].map((version) =>
        holdoutRotationIndex(version, "composer", holdouts.length),
      ),
    );
    expect(indices.size).toBeGreaterThan(1);
  });
});

describe("runGoldenEval", () => {
  it("executes the golden corpus per model and seed and stores versioned results", () => {
    const root = seedProject();
    const result = runGoldenEval({
      projectRoot: root,
      model: "composer-fixture",
      seeds: [1, 2],
      directiveVersion: "0.70.0-golden-test",
      harness: "deterministic-fixture",
      now: () => new Date("2026-07-05T20:00:00.000Z"),
    });

    expect(result.code).toBe(0);
    expect(result.record?.results.length).toBeGreaterThan(0);
    expect(result.record?.summary.primaryTotal).toBeGreaterThan(0);
    expect(result.record?.summary.holdoutTotal).toBeGreaterThan(0);
    // #3215: framework version pin recorded at run start
    expect(result.record?.frameworkVersionPin).toEqual({
      frameworkVersion: "0.70.0-golden-test",
      source: "override",
      resolvedAt: "2026-07-05T20:00:00Z",
    });
    expect(result.message).toContain("framework version pin: 0.70.0-golden-test");

    const ledgerPath = goldenRunsHistoryPath(root);
    expect(existsSync(ledgerPath)).toBe(true);
    const line = readFileSync(ledgerPath, "utf8").trim().split("\n")[0];
    const parsed: unknown = JSON.parse(line ?? "{}");
    expect(parsed).toMatchObject({
      directiveVersion: "0.70.0-golden-test",
      model: "composer-fixture",
      frameworkVersionPin: {
        frameworkVersion: "0.70.0-golden-test",
        source: "override",
      },
    });
  });

  it("wires and persists frameworkVersion into #1584 shared-benchmark when present", () => {
    const root = seedProject();
    mkdirSync(join(root, "evals"), { recursive: true });
    const manifestPath = join(root, "evals", "shared-benchmark.json");
    writeFileSync(manifestPath, JSON.stringify({ name: "shared", cases: [] }), "utf8");
    const result = runGoldenEval({
      projectRoot: root,
      model: "composer-fixture",
      seeds: [1],
      directiveVersion: "0.98.0",
      persist: true,
      now: () => new Date("2026-08-09T18:00:00.000Z"),
    });
    expect(result.code).toBe(0);
    expect(result.sharedBenchmarkManifest?.frameworkVersion).toBe("0.98.0");
    expect(result.message).toContain("frameworkVersion pin persisted");
    const onDisk: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(onDisk).toMatchObject({ frameworkVersion: "0.98.0", name: "shared" });
  });

  it("returns config error when model is missing", () => {
    const result = runGoldenEval({ projectRoot: seedProject(), model: "  " });
    expect(result.code).toBe(2);
  });

  itSymlink("refuses to persist when xbrief/.eval is a symlink outside the project (#2626)", () => {
    const root = seedProject();
    const escapeDir = mkdtempSync(join(tmpdir(), "deft-golden-escape-"));
    temps.push(escapeDir);
    const escapeLedger = join(escapeDir, "golden-runs.jsonl");
    writeFileSync(escapeLedger, "victim\n", "utf8");
    mkdirSync(join(root, "xbrief"), { recursive: true });
    symlinkSync(escapeDir, join(root, "xbrief", ".eval"), "dir");

    const result = runGoldenEval({
      projectRoot: root,
      model: "composer-fixture",
      seeds: [1],
      directiveVersion: "0.70.0-golden-test",
      persist: true,
    });

    expect(result.code).toBe(2);
    expect(result.message).toMatch(
      /contained write refused|projection write refused|symlink escaping|symlink on the write path/,
    );
    expect(readFileSync(escapeLedger, "utf8")).toBe("victim\n");
  });
});

describe("persistGoldenRun containment (#2626)", () => {
  itSymlink("refuses append when the golden-run ledger is a symlink outside the project", () => {
    const root = seedProject();
    const escapeDir = mkdtempSync(join(tmpdir(), "deft-golden-ledger-escape-"));
    temps.push(escapeDir);
    const escapeLedger = join(escapeDir, "golden-runs.jsonl");
    writeFileSync(escapeLedger, "victim\n", "utf8");
    mkdirSync(join(root, "xbrief", ".eval", "results"), { recursive: true });
    symlinkSync(escapeLedger, goldenRunsHistoryPath(root));

    expect(() =>
      persistGoldenRun(root, {
        schemaVersion: 1,
        runId: "x",
        directiveVersion: "0.70.0",
        model: "m",
        harness: "h",
        seeds: [1],
        corpusVersion: "c",
        recordedAt: "2026-07-05T00:00:00Z",
        results: [],
        summary: {
          primaryPassRate: 0,
          holdoutPassRate: 0,
          passRate: 0,
          primaryTotal: 0,
          holdoutTotal: 0,
        },
      }),
    ).toThrow(
      /contained write refused|projection write refused|symlink escaping|symlink on the write path/,
    );
    expect(readFileSync(escapeLedger, "utf8")).toBe("victim\n");
  });
});
