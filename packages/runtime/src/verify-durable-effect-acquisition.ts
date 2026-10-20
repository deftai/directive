#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateDurableEffectAcquisition } from "@deftai/directive-core/durable-effect-acquisition";

interface ParsedArgs {
  projectRoot: string;
  originRef?: string;
  quiet: boolean;
  error?: string;
}

/** Parse verify-durable-effect-acquisition CLI args. */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { projectRoot: ".", quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--quiet") {
      parsed.quiet = true;
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
    process.stderr.write(`verify_durable_effect_acquisition: ${args.error}\n`);
    return 2;
  }
  const result = evaluateDurableEffectAcquisition({
    projectRoot: resolve(args.projectRoot),
    originRef: args.originRef,
    quiet: args.quiet,
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
