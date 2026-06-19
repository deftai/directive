#!/usr/bin/env node
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addIgnore,
  computeDrift,
  renderDriftReport,
} from "../../core/dist/triage/scope-drift/index.js";

export interface ParsedArgs {
  projectRoot: string;
  cacheRoot?: string;
  threshold?: number;
  ignoreLabel?: string;
  ignoreMilestone?: string;
  error?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { projectRoot: process.env.DEFT_PROJECT_ROOT ?? "." };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined)
        return { ...parsed, error: "argument --project-root: expected one argument" };
      parsed.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--cache-root") {
      const value = argv[i + 1];
      if (value === undefined)
        return { ...parsed, error: "argument --cache-root: expected one argument" };
      parsed.cacheRoot = value;
      i += 1;
    } else if (arg?.startsWith("--cache-root=")) {
      parsed.cacheRoot = arg.slice("--cache-root=".length);
    } else if (arg === "--threshold") {
      const value = argv[i + 1];
      if (value === undefined)
        return { ...parsed, error: "argument --threshold: expected one argument" };
      parsed.threshold = Number(value);
      i += 1;
    } else if (arg?.startsWith("--threshold=")) {
      parsed.threshold = Number(arg.slice("--threshold=".length));
    } else if (arg === "--ignore-label") {
      const value = argv[i + 1];
      if (value === undefined)
        return { ...parsed, error: "argument --ignore-label: expected one argument" };
      parsed.ignoreLabel = value;
      i += 1;
    } else if (arg?.startsWith("--ignore-label=")) {
      parsed.ignoreLabel = arg.slice("--ignore-label=".length);
    } else if (arg === "--ignore-milestone") {
      const value = argv[i + 1];
      if (value === undefined)
        return { ...parsed, error: "argument --ignore-milestone: expected one argument" };
      parsed.ignoreMilestone = value;
      i += 1;
    } else if (arg?.startsWith("--ignore-milestone=")) {
      parsed.ignoreMilestone = arg.slice("--ignore-milestone=".length);
    } else {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    }
  }
  return parsed;
}

export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`triage:scope-drift: ${args.error}\n`);
    return 2;
  }
  const projectRoot = resolve(args.projectRoot);
  try {
    if (!statSync(projectRoot).isDirectory()) {
      process.stderr.write(
        `triage:scope-drift: --project-root ${projectRoot} does not exist or is not a directory.\n`,
      );
      return 2;
    }
  } catch {
    process.stderr.write(
      `triage:scope-drift: --project-root ${projectRoot} does not exist or is not a directory.\n`,
    );
    return 2;
  }

  if (args.ignoreLabel !== undefined && args.ignoreMilestone !== undefined) {
    process.stderr.write(
      "triage:scope-drift: --ignore-label and --ignore-milestone are mutually exclusive (pick one per invocation).\n",
    );
    return 2;
  }

  if (args.ignoreLabel !== undefined || args.ignoreMilestone !== undefined) {
    try {
      const { changed, message } = addIgnore(projectRoot, {
        label: args.ignoreLabel,
        milestone: args.ignoreMilestone,
      });
      if (!changed) {
        process.stderr.write(`triage:scope-drift: ${message} (no-op).\n`);
      } else {
        process.stdout.write(`triage:scope-drift: ${message}.\n`);
        process.stderr.write("  Next run of `task triage:scope-drift` will exclude this signal.\n");
      }
    } catch (err) {
      process.stderr.write(`triage:scope-drift: ${String(err)}\n`);
      return 1;
    }
    return 0;
  }

  const report = computeDrift(projectRoot, {
    cacheRoot: args.cacheRoot ? resolve(args.cacheRoot) : undefined,
    threshold: args.threshold,
  });
  process.stdout.write(`${renderDriftReport(report)}\n`);
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
