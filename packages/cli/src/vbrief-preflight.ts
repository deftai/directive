#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { emitJson, evaluate } from "@deftai/core/preflight";

interface ParsedArgs {
  vbriefPath: string | null;
  emitJson: boolean;
  error?: string;
}

/** Parse vbrief-preflight CLI args, mirroring the Python argparse surface (#810). */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    vbriefPath: null,
    emitJson: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      parsed.emitJson = true;
    } else if (arg === "--vbrief-path") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --vbrief-path: expected one argument" };
      }
      parsed.vbriefPath = value;
      i += 1;
    } else if (arg?.startsWith("--vbrief-path=")) {
      parsed.vbriefPath = arg.slice("--vbrief-path=".length);
    } else {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    }
  }
  if (parsed.vbriefPath === null) {
    return { ...parsed, error: "the following arguments are required: --vbrief-path" };
  }
  return parsed;
}

/** Run the gate and return the process exit code (parse errors -> 2). */
export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`preflight_implementation: ${args.error}\n`);
    return 2;
  }
  const vbriefPath = args.vbriefPath as string;
  const result = evaluate(vbriefPath);

  if (args.emitJson) {
    process.stdout.write(`${emitJson(vbriefPath, result.exitCode, result.message)}\n`);
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
