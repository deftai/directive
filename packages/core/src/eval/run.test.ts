import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GOLDEN_CORPUS,
  goldenRunsHistoryPath,
  holdoutRotationIndex,
  runGoldenEval,
  selectRotatingHoldoutTask,
} from "./run.js";

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

    const ledgerPath = goldenRunsHistoryPath(root);
    expect(existsSync(ledgerPath)).toBe(true);
    const line = readFileSync(ledgerPath, "utf8").trim().split("\n")[0];
    const parsed: unknown = JSON.parse(line ?? "{}");
    expect(parsed).toMatchObject({
      directiveVersion: "0.70.0-golden-test",
      model: "composer-fixture",
    });
  });

  it("returns config error when model is missing", () => {
    const result = runGoldenEval({ projectRoot: seedProject(), model: "  " });
    expect(result.code).toBe(2);
  });
});
