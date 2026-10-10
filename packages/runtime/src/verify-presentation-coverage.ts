#!/usr/bin/env node
/**
 * CLI for verify:presentation-coverage (#5079).
 */
import { resolve } from "node:path";
import { presentationCoverage } from "@deftai/directive-core";
import { isDirectEntrypoint } from "./entrypoint.js";

interface ParsedArgs {
  projectRoot: string;
  originRef?: string;
  staged: boolean;
  quiet: boolean;
  json: boolean;
  planId?: string;
  error?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { projectRoot: ".", staged: false, quiet: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--plan-id") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--"))
        return { ...parsed, error: "argument --plan-id: expected one argument" };
      parsed.planId = value;
      i += 1;
    } else if (arg === "--quiet") {
      parsed.quiet = true;
    } else if (arg === "--staged") {
      parsed.staged = true;
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
      parsed.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--origin-ref") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { ...parsed, error: "argument --origin-ref: expected one argument" };
      }
      parsed.originRef = value;
      i += 1;
    } else if (arg?.startsWith("--origin-ref=")) {
      parsed.originRef = arg.slice("--origin-ref=".length);
    } else if (arg === "--base-ref") {
      return {
        ...parsed,
        error:
          "unrecognized argument: --base-ref (baseline is the computed merge base; use --origin-ref to name the origin default)",
      };
    } else {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    }
  }
  return parsed;
}

export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`verify_presentation_coverage: ${args.error}\n`);
    return 2;
  }
  const result = presentationCoverage.evaluatePresentationCoverage({
    projectRoot: resolve(args.projectRoot),
    originRef: args.originRef,
    staged: args.staged,
    quiet: args.quiet,
    planId: args.planId,
  });
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.code;
  }
  if (!args.quiet && result.message.length > 0) {
    if (result.stream === "stdout") process.stdout.write(`${result.message}\n`);
    else if (result.stream === "stderr") process.stderr.write(`${result.message}\n`);
  }
  return result.code;
}

if (isDirectEntrypoint(import.meta.url)) {
  process.exit(run(process.argv.slice(2)));
}
