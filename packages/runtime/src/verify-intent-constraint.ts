#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateIntentConstraint } from "@deftai/directive-core/intent-constraint";

interface ParsedArgs {
  projectRoot: string;
  originRef?: string;
  staged: boolean;
  quiet: boolean;
  planId?: string;
  error?: string;
}

/** Parse verify-intent-constraint CLI args. */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { projectRoot: ".", staged: false, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--quiet") {
      parsed.quiet = true;
    } else if (arg === "--staged") {
      parsed.staged = true;
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
      parsed.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--origin-ref") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --origin-ref: expected one argument" };
      }
      parsed.originRef = value;
      i += 1;
    } else if (arg?.startsWith("--origin-ref=")) {
      parsed.originRef = arg.slice("--origin-ref=".length);
    } else if (arg === "--plan-id") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --plan-id: expected one argument" };
      }
      parsed.planId = value;
      i += 1;
    } else if (arg?.startsWith("--plan-id=")) {
      parsed.planId = arg.slice("--plan-id=".length);
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

/** Run the gate and return the process exit code. */
export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`verify_intent_constraint: ${args.error}\n`);
    return 2;
  }
  const result = evaluateIntentConstraint({
    projectRoot: resolve(args.projectRoot),
    originRef: args.originRef,
    staged: args.staged,
    quiet: args.quiet,
    planId: args.planId,
  });
  if (result.message.length > 0) {
    if (result.stream === "stdout") process.stdout.write(`${result.message}\n`);
    else if (result.stream === "stderr") process.stderr.write(`${result.message}\n`);
  }
  return result.code;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
