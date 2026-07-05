import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateHoldoutTripwire,
  findLatestGoldenRun,
  reportGoldenEval,
  twoProportionZTest,
} from "./report.js";
import { type GoldenRunRecord, goldenRunsHistoryPath, persistGoldenRun } from "./run.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function seedProject(): string {
  const root = mkdtempSync(join(tmpdir(), "deft-golden-report-"));
  temps.push(root);
  mkdirSync(join(root, "xbrief"), { recursive: true });
  return root;
}

describe("reportGoldenEval", () => {
  it("returns metric deltas and significance between two directive versions", () => {
    const root = seedProject();
    const champion: GoldenRunRecord = {
      schemaVersion: 1,
      runId: "champion-run",
      directiveVersion: "0.70.0",
      model: "composer-fixture",
      harness: "deterministic-fixture",
      seeds: [1],
      corpusVersion: "fixture",
      recordedAt: "2026-07-05T19:00:00Z",
      results: [
        { taskId: "a", seed: 1, passed: true, holdout: false, metrics: {} },
        { taskId: "b", seed: 1, passed: false, holdout: false, metrics: {} },
        { taskId: "h", seed: 1, passed: true, holdout: true, metrics: {} },
      ],
      summary: {
        primaryPassRate: 0.5,
        holdoutPassRate: 1,
        passRate: 2 / 3,
        primaryTotal: 2,
        holdoutTotal: 1,
      },
    };
    const challenger: GoldenRunRecord = {
      ...champion,
      runId: "challenger-run",
      directiveVersion: "0.71.0",
      recordedAt: "2026-07-05T20:00:00Z",
      results: [
        { taskId: "a", seed: 1, passed: true, holdout: false, metrics: {} },
        { taskId: "b", seed: 1, passed: true, holdout: false, metrics: {} },
        { taskId: "h", seed: 1, passed: true, holdout: true, metrics: {} },
      ],
      summary: {
        primaryPassRate: 1,
        holdoutPassRate: 1,
        passRate: 1,
        primaryTotal: 2,
        holdoutTotal: 1,
      },
    };
    persistGoldenRun(root, champion);
    persistGoldenRun(root, challenger);

    const result = reportGoldenEval({
      projectRoot: root,
      championVersion: "0.70.0",
      challengerVersion: "0.71.0",
      model: "composer-fixture",
    });

    expect(result.code).toBe(0);
    expect(result.report?.deltas.some((d) => d.metric === "primaryPassRate")).toBe(true);
    expect(result.report?.deltas[0]?.delta).toBeGreaterThan(0);
    expect(result.message).toContain("primaryPassRate");
  });

  it("flags holdout tripwire when primary improves but holdout regresses", () => {
    const champion: GoldenRunRecord = {
      schemaVersion: 1,
      runId: "c1",
      directiveVersion: "0.70.0",
      model: "m",
      harness: "h",
      seeds: [1],
      corpusVersion: "fixture",
      recordedAt: "2026-07-05T19:00:00Z",
      results: [],
      summary: {
        primaryPassRate: 0.5,
        holdoutPassRate: 0.9,
        passRate: 0.6,
        primaryTotal: 4,
        holdoutTotal: 2,
      },
    };
    const challenger: GoldenRunRecord = {
      ...champion,
      runId: "c2",
      directiveVersion: "0.71.0",
      summary: {
        primaryPassRate: 0.95,
        holdoutPassRate: 0.2,
        passRate: 0.7,
        primaryTotal: 4,
        holdoutTotal: 2,
      },
    };
    const tripwire = evaluateHoldoutTripwire(champion, challenger);
    expect(tripwire.triggered).toBe(true);

    const root = seedProject();
    persistGoldenRun(root, champion);
    persistGoldenRun(root, challenger);
    const result = reportGoldenEval({
      projectRoot: root,
      championVersion: "0.70.0",
      challengerVersion: "0.71.0",
      model: "m",
    });
    expect(result.code).toBe(1);
    expect(result.report?.holdoutTripwire.triggered).toBe(true);
  });
});

describe("twoProportionZTest", () => {
  it("detects a significant pass-rate delta", () => {
    const { pValue } = twoProportionZTest(2, 20, 18, 20);
    expect(pValue).not.toBeNull();
    expect(pValue ?? 1).toBeLessThan(0.05);
  });
});

describe("findLatestGoldenRun", () => {
  it("returns the newest matching record", () => {
    const root = seedProject();
    persistGoldenRun(root, {
      schemaVersion: 1,
      runId: "old",
      directiveVersion: "1.0.0",
      model: "m",
      harness: "h",
      seeds: [1],
      corpusVersion: "fixture",
      recordedAt: "2026-07-05T18:00:00Z",
      results: [],
      summary: {
        primaryPassRate: 1,
        holdoutPassRate: 1,
        passRate: 1,
        primaryTotal: 0,
        holdoutTotal: 0,
      },
    });
    persistGoldenRun(root, {
      schemaVersion: 1,
      runId: "new",
      directiveVersion: "1.0.0",
      model: "m",
      harness: "h",
      seeds: [1],
      corpusVersion: "fixture",
      recordedAt: "2026-07-05T21:00:00Z",
      results: [],
      summary: {
        primaryPassRate: 1,
        holdoutPassRate: 1,
        passRate: 1,
        primaryTotal: 0,
        holdoutTotal: 0,
      },
    });
    const records = readFileSync(goldenRunsHistoryPath(root), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as GoldenRunRecord);
    expect(findLatestGoldenRun(records, "1.0.0", "m")?.runId).toBe("new");
  });
});
