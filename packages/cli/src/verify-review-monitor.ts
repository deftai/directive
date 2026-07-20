#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      return { ...acc, help: true };
    }
    if (arg === "--json") {
      acc.emitJson = true;
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
    process.stdout.write(`${JSON.stringify(verifyResultToJson(result), null, 2)}\n`);
  } else if (result.exitCode === 0) {
    process.stdout.write(`${result.message}\n`);
  } else {
    process.stderr.write(`${result.message}\n`);
  }

  return result.exitCode;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
