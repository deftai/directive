/**
 * verify:telemetry-coverage — dead-surface detector (#3362).
 *
 * Two checks, one remediation that names the missing half:
 *  1. Every RUN_SUMMARY_EVENT_KINDS member (and exported emitter method)
 *     has a production caller outside the emitter module.
 *  2. Every kind is enrolled, has a trial step, and appears in a run of
 *     the shared fake-trial harness JSONL.
 *
 * Default is warn-only (exit 0). Pass --enforce to fail closed.
 */

import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_TRIAL_STEPS, type FakeTrialResult, runFakeTrial } from "./fake-trial.js";
import { ENROLLED_FIELD_FIXTURE_KINDS, kindForMethod, RUN_SUMMARY_EVENT_KINDS } from "./kinds.js";
import { scanProductionCallers } from "./scan-callers.js";

const EXIT_OK = 0;
const EXIT_ENFORCE_FINDINGS = 1;
const EXIT_CONFIG = 2;

export interface TelemetryCoverageFinding {
  readonly subject: string;
  readonly missingCaller: boolean;
  readonly missingFixture: boolean;
  readonly remediation: string;
}

export interface TelemetryCoverageOptions {
  readonly projectRoot: string;
  readonly enforce?: boolean;
  readonly scanRoots?: readonly string[];
  readonly kinds?: readonly string[];
  readonly enrolledKinds?: readonly string[];
  /** Override trial-step kinds (tests). Default: DEFAULT_TRIAL_STEPS. */
  readonly trialKinds?: readonly string[];
  /** Skip running the fake trial (unit tests). Production default is to run it. */
  readonly skipTrial?: boolean;
  /** Injected trial result (tests). */
  readonly trialResult?: Pick<FakeTrialResult, "presentKinds" | "stepOutcomes">;
}

export interface TelemetryCoverageResult {
  readonly code: number;
  readonly message: string;
  readonly stream: "stdout" | "stderr";
  readonly findings: readonly TelemetryCoverageFinding[];
  readonly enforce: boolean;
  readonly failOpen: boolean;
}

export function remediationFor(
  subject: string,
  missingCaller: boolean,
  missingFixture: boolean,
): string {
  if (missingCaller && missingFixture) {
    return `event kind ${subject} has no production caller / no field fixture — wire it or remove it from the schema.`;
  }
  if (missingCaller) {
    return `event kind ${subject} has no production caller — wire it or remove it from the schema.`;
  }
  return `event kind ${subject} has no field fixture — wire it or remove it from the schema.`;
}

function failedDeclaredSteps(outcomes: FakeTrialResult["stepOutcomes"] | undefined): Set<string> {
  const failed = new Set<string>();
  if (outcomes === undefined) {
    return failed;
  }
  for (const outcome of outcomes) {
    if (!outcome.emittedKinds.includes(outcome.declaredKind)) {
      failed.add(outcome.declaredKind);
    }
  }
  return failed;
}

export function evaluateTelemetryCoverage(
  options: TelemetryCoverageOptions,
): TelemetryCoverageResult {
  const root = resolve(options.projectRoot);
  const enforce = options.enforce === true;
  if (!existsSync(root)) {
    return {
      code: EXIT_CONFIG,
      message: `verify:telemetry-coverage: project root not found: ${root}`,
      stream: "stderr",
      findings: [],
      enforce,
      failOpen: !enforce,
    };
  }

  const kinds = options.kinds ?? [...RUN_SUMMARY_EVENT_KINDS];
  const enrolled = new Set(options.enrolledKinds ?? ENROLLED_FIELD_FIXTURE_KINDS);
  const trialKinds = new Set(options.trialKinds ?? DEFAULT_TRIAL_STEPS.map((step) => step.kind));
  let trialRoot: string | undefined;
  let presentFromTrial: Set<string> | undefined;
  let failedStepKinds: Set<string> | undefined;
  if (options.trialResult !== undefined) {
    presentFromTrial = new Set(options.trialResult.presentKinds);
    failedStepKinds = failedDeclaredSteps(options.trialResult.stepOutcomes);
  } else if (options.skipTrial !== true) {
    const trial = runFakeTrial();
    trialRoot = trial.projectRoot;
    presentFromTrial = new Set(trial.presentKinds);
    failedStepKinds = failedDeclaredSteps(trial.stepOutcomes);
  }

  const scan = scanProductionCallers({
    projectRoot: root,
    scanRoots: options.scanRoots,
    kinds,
  });

  const findings: TelemetryCoverageFinding[] = [];
  try {
    for (const kind of kinds) {
      const missingCaller = (scan.callersByKind[kind] ?? []).length === 0;
      const missingFromTrial = presentFromTrial !== undefined && !presentFromTrial.has(kind);
      const brokenDeclaredStep = failedStepKinds?.has(kind) === true;
      const missingFixture =
        !enrolled.has(kind) || !trialKinds.has(kind) || missingFromTrial || brokenDeclaredStep;
      if (missingCaller || missingFixture) {
        findings.push({
          subject: kind,
          missingCaller,
          missingFixture,
          remediation: remediationFor(kind, missingCaller, missingFixture),
        });
      }
    }

    for (const method of scan.discoveredMethods) {
      const mappedKind = kindForMethod(method);
      if (mappedKind !== undefined && kinds.includes(mappedKind)) {
        continue;
      }
      const hits = scan.callersByMethod[method] ?? [];
      if (hits.length === 0) {
        findings.push({
          subject: method,
          missingCaller: true,
          missingFixture: false,
          remediation: `event kind ${method} has no production caller — wire it or remove it from the schema.`,
        });
      }
    }

    if (findings.length === 0) {
      return {
        code: EXIT_OK,
        message:
          `OK: verify:telemetry-coverage — every event kind has a production caller ` +
          `and a field fixture (enforce=${enforce}).`,
        stream: "stdout",
        findings: [],
        enforce,
        failOpen: !enforce,
      };
    }

    const lines = [
      `verify:telemetry-coverage: ${findings.length} dead telemetry surface(s):`,
      ...findings.map((f) => `  ${f.remediation}`),
    ];
    if (enforce) {
      lines.push(
        "FAIL: --enforce is set; wire the missing half or remove the kind from the schema (#3362).",
      );
      return {
        code: EXIT_ENFORCE_FINDINGS,
        message: lines.join("\n"),
        stream: "stderr",
        findings,
        enforce: true,
        failOpen: false,
      };
    }

    lines.push(
      "ADVISORY (warn-only): exit 0. Pass --enforce to fail closed after #3355/#3356 land (#3362).",
    );
    return {
      code: EXIT_OK,
      message: lines.join("\n"),
      stream: "stdout",
      findings,
      enforce: false,
      failOpen: true,
    };
  } finally {
    if (trialRoot !== undefined) {
      rmSync(trialRoot, { recursive: true, force: true });
    }
  }
}
