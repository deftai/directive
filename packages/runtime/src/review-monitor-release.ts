#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_HELP, releaseReviewMonitor } from "@deftai/directive-core/review-monitor";

interface ParsedArgs {
  pr: number | null;
  repo: string | null;
  monitorAgentId: string | null;
  owner: string | null;
  projectRoot: string;
  help: boolean;
  error?: string;
}

export function parseReleaseArgs(argv: readonly string[]): ParsedArgs {
  const acc: ParsedArgs = {
    pr: null,
    repo: null,
    monitorAgentId: null,
    owner: null,
    projectRoot: ".",
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      return { ...acc, help: true };
    }
    if (arg === "--pr") {
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
    } else if (arg === "--monitor-agent-id") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...acc, error: "argument --monitor-agent-id: expected one argument" };
      }
      acc.monitorAgentId = value;
      i += 1;
    } else if (arg?.startsWith("--monitor-agent-id=")) {
      acc.monitorAgentId = arg.slice("--monitor-agent-id=".length);
    } else if (arg === "--owner") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...acc, error: "argument --owner: expected one argument" };
      }
      acc.owner = value;
      i += 1;
    } else if (arg?.startsWith("--owner=")) {
      acc.owner = arg.slice("--owner=".length);
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...acc, error: "argument --project-root: expected one argument" };
      }
      acc.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      acc.projectRoot = arg.slice("--project-root=".length);
    } else if (arg?.startsWith("-")) {
      return { ...acc, error: `unrecognized argument: ${arg}` };
    } else {
      return { ...acc, error: `unrecognized argument: ${arg}` };
    }
  }

  return acc;
}

export function run(argv: readonly string[]): number {
  const args = parseReleaseArgs(argv);
  if (args.help) {
    process.stdout.write(RELEASE_HELP);
    return 0;
  }
  if (args.error !== undefined) {
    process.stderr.write(`review_monitor_release: ${args.error}\n`);
    return 2;
  }
  if (args.pr === null) {
    process.stderr.write("review_monitor_release: --pr is required\n");
    return 2;
  }

  const result = releaseReviewMonitor({
    pr: args.pr,
    repo: args.repo,
    monitorAgentId: args.monitorAgentId,
    owner: args.owner,
    projectRoot: resolve(args.projectRoot),
  });

  if (result.exitCode === 0) {
    process.stdout.write(`${result.message}\n`);
  } else {
    process.stderr.write(`${result.message}\n`);
  }
  return result.exitCode;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
