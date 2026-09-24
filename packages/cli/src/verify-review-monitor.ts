#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateMergePathArm,
  type MergePathArmResult,
} from "@deftai/directive-core/dist/pr-watch/main.js";
import {
  evaluateReviewMonitorGate,
  REVIEW_MONITOR_HELP,
  type ReviewMonitorCallSite,
  verifyResultToJson,
} from "@deftai/directive-core/review-monitor";

interface ParsedArgs {
  pr: number | null;
  projectRoot: string;
  repo: string | null;
  headSha: string | null;
  callSite: ReviewMonitorCallSite;
  approach3: boolean;
  approach3Warned: boolean;
  emitJson: boolean;
  /** When true, also run the #4882 merge-path arm observer (attested flags). */
  mergePathArm: boolean;
  liveWait: boolean;
  explicitFinish: boolean;
  stickyLease: boolean;
  help: boolean;
  error?: string;
}

const CALL_SITES = new Set<ReviewMonitorCallSite>([
  "solo",
  "swarm-phase5-6",
  "swarm-phase6-cascade",
  "unspecified",
]);

export function parseVerifyReviewMonitorArgs(argv: readonly string[]): ParsedArgs {
  const acc: ParsedArgs = {
    pr: null,
    projectRoot: ".",
    repo: null,
    headSha: null,
    callSite: "unspecified",
    approach3: false,
    approach3Warned: false,
    emitJson: false,
    mergePathArm: false,
    liveWait: false,
    explicitFinish: false,
    stickyLease: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      return { ...acc, help: true };
    }
    if (arg === "--json") {
      acc.emitJson = true;
    } else if (arg === "--merge-path-arm") {
      acc.mergePathArm = true;
    } else if (arg === "--live-wait") {
      acc.liveWait = true;
    } else if (arg === "--explicit-finish") {
      acc.explicitFinish = true;
    } else if (arg === "--sticky-lease") {
      acc.stickyLease = true;
    } else if (arg === "--approach3") {
      acc.approach3 = true;
    } else if (arg === "--approach3-warned") {
      acc.approach3Warned = true;
    } else if (arg === "--pr") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...acc, error: "argument --pr: expected one argument" };
      }
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) {
        return { ...acc, error: `invalid --pr value: ${value}` };
      }
      acc.pr = n;
      i += 1;
    } else if (arg?.startsWith("--pr=")) {
      const n = Number(arg.slice("--pr=".length));
      if (!Number.isInteger(n) || n <= 0) {
        return { ...acc, error: `invalid --pr value: ${arg}` };
      }
      acc.pr = n;
    } else if (arg === "--repo") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...acc, error: "argument --repo: expected one argument" };
      }
      acc.repo = value;
      i += 1;
    } else if (arg?.startsWith("--repo=")) {
      acc.repo = arg.slice("--repo=".length);
    } else if (arg === "--head-sha") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...acc, error: "argument --head-sha: expected one argument" };
      }
      acc.headSha = value;
      i += 1;
    } else if (arg?.startsWith("--head-sha=")) {
      acc.headSha = arg.slice("--head-sha=".length);
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...acc, error: "argument --project-root: expected one argument" };
      }
      acc.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      acc.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--call-site") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...acc, error: "argument --call-site: expected one argument" };
      }
      if (!CALL_SITES.has(value as ReviewMonitorCallSite)) {
        return { ...acc, error: `invalid --call-site: ${value}` };
      }
      acc.callSite = value as ReviewMonitorCallSite;
      i += 1;
    } else if (arg?.startsWith("--call-site=")) {
      const value = arg.slice("--call-site=".length);
      if (!CALL_SITES.has(value as ReviewMonitorCallSite)) {
        return { ...acc, error: `invalid --call-site: ${value}` };
      }
      acc.callSite = value as ReviewMonitorCallSite;
    } else if (arg?.startsWith("-")) {
      return { ...acc, error: `unrecognized argument: ${arg}` };
    } else {
      return { ...acc, error: `unrecognized argument: ${arg}` };
    }
  }

  return acc;
}

export function run(argv: readonly string[]): number {
  const args = parseVerifyReviewMonitorArgs(argv);
  if (args.help) {
    process.stdout.write(REVIEW_MONITOR_HELP);
    process.stdout.write(
      "\n#4882 merge-path arm observer (optional):\n" +
        "  --merge-path-arm       Fail closed when neither live wait nor explicit finish\n" +
        "  --live-wait            Attest a still-running phase-correct wait for this PR\n" +
        "  --explicit-finish      Attest option-C BLOCKED/FAILED finish for this PR\n" +
        "  --sticky-lease         Attest a fresh sticky lease (not sufficient alone)\n" +
        "  Prefer Approach 1 / native pr:watch; homemade line-parsed --json is not an arm.\n",
    );
    return 0;
  }
  if (args.error !== undefined) {
    process.stderr.write(`verify_review_monitor: ${args.error}\n`);
    process.stderr.write("Try: task verify:review-monitor -- --help\n");
    return 2;
  }
  if (args.pr === null) {
    process.stderr.write("verify_review_monitor: --pr is required\n");
    process.stderr.write("Try: task verify:review-monitor -- --help\n");
    return 2;
  }

  let arm: MergePathArmResult | null = null;
  if (args.mergePathArm) {
    arm = evaluateMergePathArm({
      livePhaseCorrectWait: args.liveWait,
      explicitFinish: args.explicitFinish,
      stickyLeaseActive: args.stickyLease,
    });
    if (!arm.armed) {
      if (args.emitJson) {
        process.stdout.write(
          `${JSON.stringify(
            {
              ready: false,
              merge_path_arm: {
                armed: false,
                reason: arm.reason,
                message: arm.message,
                live_wait: args.liveWait,
                explicit_finish: args.explicitFinish,
                sticky_lease: args.stickyLease,
              },
            },
            null,
            2,
          )}\n`,
        );
      } else {
        process.stderr.write(`${arm.message}\n`);
      }
      return 1;
    }
  }

  const result = evaluateReviewMonitorGate({
    pr: args.pr,
    projectRoot: resolve(args.projectRoot),
    repo: args.repo,
    headSha: args.headSha,
    callSite: args.callSite,
    approach3: args.approach3,
    approach3Warned: args.approach3Warned,
    environ: process.env,
  });

  if (args.emitJson) {
    const payload = verifyResultToJson(result) as Record<string, unknown>;
    if (arm !== null) {
      payload.merge_path_arm = {
        armed: arm.armed,
        reason: arm.reason,
        message: arm.message,
        live_wait: args.liveWait,
        explicit_finish: args.explicitFinish,
        sticky_lease: args.stickyLease,
      };
    }
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (result.exitCode === 0) {
    process.stdout.write(`${result.message}\n`);
    if (arm !== null) {
      process.stdout.write(`${arm.message}\n`);
    }
  } else {
    process.stderr.write(`${result.message}\n`);
  }

  return result.exitCode;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
