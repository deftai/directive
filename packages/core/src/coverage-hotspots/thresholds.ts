import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { COVERAGE_GOAL, type CoverageMetric } from "../vitest-runner/coverage-debt.js";

export type CoverageThresholds = Record<CoverageMetric, number>;

const VITEST_CONFIG_CANDIDATES = [
  "vitest.config.ts",
  "vitest.config.mts",
  "vitest.config.js",
  "vitest.config.cjs",
  "vitest.config.mjs",
] as const;

const METRIC_PATTERN =
  /(?:^|[\n\r{,])\s*(branches|lines|functions|statements)\s*:\s*(\d+(?:\.\d+)?)/g;

function parseMetricBlock(text: string, anchor: RegExp): Partial<CoverageThresholds> {
  const match = anchor.exec(text);
  if (match?.index === undefined) return {};
  const slice = text.slice(match.index, match.index + 800);
  const out: Partial<CoverageThresholds> = {};
  for (const metricMatch of slice.matchAll(METRIC_PATTERN)) {
    const metric = metricMatch[1] as CoverageMetric | undefined;
    const value = metricMatch[2];
    if (metric === undefined || value === undefined) continue;
    out[metric] = Number.parseFloat(value);
  }
  return out;
}

/** Best-effort read of vitest coverage thresholds; falls back to framework 85% defaults. */
export function readProjectCoverageThresholds(projectRoot: string): CoverageThresholds {
  for (const name of VITEST_CONFIG_CANDIDATES) {
    const path = join(projectRoot, name);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    const fromCoverageThresholds = parseMetricBlock(text, /coverageThresholds\s*=\s*\{/);
    const fromNested = parseMetricBlock(text, /thresholds\s*:\s*\{/);
    const merged = { ...fromNested, ...fromCoverageThresholds };
    if (Object.keys(merged).length > 0) {
      return {
        lines: merged.lines ?? COVERAGE_GOAL.lines,
        functions: merged.functions ?? COVERAGE_GOAL.functions,
        branches: merged.branches ?? COVERAGE_GOAL.branches,
        statements: merged.statements ?? COVERAGE_GOAL.statements,
      };
    }
  }
  return { ...COVERAGE_GOAL };
}
