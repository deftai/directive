import { execFileSync } from "node:child_process";
import { recordAdoptionSignal } from "../events/attribution-ledger.js";
import {
  isValueFeedbackPathAllowed,
  resolveValueFeedback,
  type ValueFeedbackResolved,
} from "../policy/value-feedback.js";
import { detectApplicableButUnusedGated, type WorkContext } from "./adoption-registry.js";

export interface AdoptionEmitOptions {
  readonly logPath?: string | null;
  readonly policyOverride?: ValueFeedbackResolved;
  readonly workContext?: WorkContext;
}

/** Best-effort WorkContext snapshot from git porcelain status (#2339). */
export function buildWorkContextFromGit(projectRoot: string): WorkContext {
  try {
    const porcelain = execFileSync("git", ["status", "--porcelain"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const paths = new Set<string>();
    for (const line of porcelain.split("\n")) {
      if (line.length < 4) {
        continue;
      }
      let path = line.slice(3).trim();
      if (path.startsWith('"') && path.endsWith('"')) {
        path = path.slice(1, -1);
      }
      if (path.length > 0) {
        paths.add(path);
      }
    }
    const modules = new Set<string>();
    for (const filePath of paths) {
      const segment = filePath.split("/")[0];
      if (segment !== undefined && segment.length > 0) {
        modules.add(segment);
      }
    }
    return {
      filesTouched: paths.size,
      distinctModuleGlobs: modules.size,
      usedCapabilities: [],
    };
  } catch {
    return { filesTouched: 0, distinctModuleGlobs: 0, usedCapabilities: [] };
  }
}

/** Record adoption signals for applicable-but-unused capabilities (#2339). */
export function recordAdoptionSignalsFromWorkContext(
  projectRoot: string,
  ctx: WorkContext,
  options: AdoptionEmitOptions = {},
): number {
  const policy = options.policyOverride ?? resolveValueFeedback(projectRoot);
  if (!isValueFeedbackPathAllowed("emitEvents", policy)) {
    return 0;
  }
  const signals = detectApplicableButUnusedGated(ctx, policy);
  let recorded = 0;
  for (const signal of signals) {
    const record = recordAdoptionSignal(projectRoot, signal.capabilityId, signal.message, {
      logPath: options.logPath,
      policyOverride: policy,
    });
    if (record !== null) {
      recorded += 1;
    }
  }
  return recorded;
}

/** Session/work-boundary adoption probe — builds WorkContext when omitted (#2339). */
export function probeAdoptionAtWorkBoundary(
  projectRoot: string,
  options: AdoptionEmitOptions = {},
): number {
  const ctx = options.workContext ?? buildWorkContextFromGit(projectRoot);
  return recordAdoptionSignalsFromWorkContext(projectRoot, ctx, options);
}
