import { statSync } from "node:fs";
import { resolve } from "node:path";
import { pythonStringRepr, resolveCapacityAllocation } from "./capacity-policy.js";
import { computeReport, renderReport } from "./capacity-show.js";
import type { EvaluateResult } from "./types.js";

export const DEFICIT_TOLERANCE = 1.0;

export interface VerifyCapacityOptions {
  readonly projectRoot?: string;
  readonly quiet?: boolean;
  readonly now?: Date;
}

function worstDeficit(report: ReturnType<typeof computeReport>): {
  worstId: string;
  worst: number;
} {
  let worstId = "";
  let worst = 0;
  for (const tally of report.buckets) {
    const targetWeight = tally.target * report.totalBackward;
    const deficit = Math.round((targetWeight - tally.backwardWeight) * 10000) / 10000;
    if (deficit > worst) {
      worst = deficit;
      worstId = tally.bucketId;
    }
  }
  return { worstId, worst };
}

/**
 * Pure evaluator for verify:capacity. Faithful to `scripts/verify_capacity.py`.
 */
export function evaluate(options: VerifyCapacityOptions = {}): EvaluateResult {
  const projectRoot = resolve(options.projectRoot ?? ".");
  try {
    if (!statSync(projectRoot).isDirectory()) {
      return {
        code: 2,
        message:
          `verify_capacity: --project-root is not a directory: ${projectRoot}\n` +
          "  Recovery: pass an existing project root.",
        stream: "stderr",
      };
    }
  } catch {
    return {
      code: 2,
      message:
        `verify_capacity: --project-root is not a directory: ${projectRoot}\n` +
        "  Recovery: pass an existing project root.",
      stream: "stderr",
    };
  }

  const allocation = resolveCapacityAllocation(projectRoot);
  const report = computeReport(projectRoot, { now: options.now, allocation });
  const rendered = renderReport(report);

  if (allocation.enforcement !== "enforce") {
    return {
      code: 0,
      message:
        `${rendered}\n` +
        "verify_capacity: OK -- advisory posture " +
        `(enforcement=${pythonStringRepr(allocation.enforcement)}); deferring to ordering.`,
      stream: "stdout",
    };
  }

  if (!report.configured) {
    return {
      code: 0,
      message: `${rendered}\nverify_capacity: OK -- no capacityAllocation buckets configured.`,
      stream: "stdout",
    };
  }

  if (report.advisoryMode) {
    return {
      code: 0,
      message:
        `${rendered}\n` +
        "verify_capacity: OK -- sample below minSampleSize " +
        `(${report.classifiedCompletions}/${report.minSampleSize}); ` +
        "capacity stays advisory until enough classified completions accrue.",
      stream: "stdout",
    };
  }

  const { worstId, worst } = worstDeficit(report);
  if (worst > DEFICIT_TOLERANCE) {
    return {
      code: 1,
      message:
        `${rendered}\n` +
        `verify_capacity: DEFICIT -- bucket ${pythonStringRepr(worstId)} is starved by ` +
        `${worst.toFixed(2)} (enforce posture; tolerance ${DEFICIT_TOLERANCE.toFixed(1)}). ` +
        "Prioritize that bucket or relax its target.",
      stream: "stderr",
    };
  }

  return {
    code: 0,
    message: `${rendered}\nverify_capacity: OK -- all buckets within target tolerance.`,
    stream: "stdout",
  };
}

/** CLI-shaped runner mirroring `scripts/verify_capacity.py::main`. */
export function runMain(options: VerifyCapacityOptions = {}): EvaluateResult {
  const result = evaluate(options);
  if (result.code === 0 && options.quiet) {
    return { code: 0, message: "", stream: "none" };
  }
  return result;
}
