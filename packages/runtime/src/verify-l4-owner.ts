#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateL4OwnerGate,
  L4_OWNER_HELP,
  l4OwnerResultToJson,
} from "@deftai/directive-core/review-monitor";

interface ParsedArgs {
  pr: number | null;
  projectRoot: string;
  repo: string | null;
  headSha: string | null;
  reviewCycle: string | null;
  emitJson: boolean;
  help: boolean;
  error?: string;
}

export function parseVerifyL4OwnerArgs(argv: readonly string[]): ParsedArgs {
  const acc: ParsedArgs = {
    pr: null,
    projectRoot: ".",
    repo: null,
    headSha: null,
    reviewCycle: null,
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
    } else if (arg === "--review-cycle") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...acc, error: "argument --review-cycle: expected one argument" };
      }
      acc.reviewCycle = value;
      i += 1;
    } else if (arg?.startsWith("--review-cycle=")) {
      acc.reviewCycle = arg.slice("--review-cycle=".length);
    } else if (arg?.startsWith("-")) {
      return { ...acc, error: `unrecognized argument: ${arg}` };
    } else {
      return { ...acc, error: `unrecognized argument: ${arg}` };
    }
  }

  return acc;
}

export function run(argv: readonly string[]): number {
  const args = parseVerifyL4OwnerArgs(argv);
  if (args.help) {
    process.stdout.write(L4_OWNER_HELP);
    return 0;
  }
  if (args.error !== undefined) {
    process.stderr.write(`verify_l4_owner: ${args.error}\n`);
    process.stderr.write("Try: task verify:l4-owner -- --help\n");
    return 2;
  }
  if (args.pr === null) {
    process.stderr.write("verify_l4_owner: --pr is required\n");
    process.stderr.write("Try: task verify:l4-owner -- --help\n");
    return 2;
  }

  const result = evaluateL4OwnerGate({
    pr: args.pr,
    projectRoot: resolve(args.projectRoot),
    repo: args.repo,
    headSha: args.headSha,
    reviewCycle: args.reviewCycle,
  });

  if (args.emitJson) {
    process.stdout.write(`${JSON.stringify(l4OwnerResultToJson(result), null, 2)}\n`);
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
