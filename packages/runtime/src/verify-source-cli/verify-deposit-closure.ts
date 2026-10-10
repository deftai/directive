#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateDepositClosureAtRoot } from "@deftai/directive-core/verify-source";

interface ParsedArgs {
  projectRoot: string;
  packRootExplicit: boolean;
  error?: string;
}

/** Parse verify-deposit-closure CLI args (#3900 / #3601 C1). */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { projectRoot: ".", packRootExplicit: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project-root" || arg === "--pack-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument " + arg + ": expected one argument" };
      }
      parsed.projectRoot = value;
      parsed.packRootExplicit = arg === "--pack-root";
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg?.startsWith("--pack-root=")) {
      parsed.projectRoot = arg.slice("--pack-root=".length);
      parsed.packRootExplicit = true;
    } else {
      return { ...parsed, error: "unrecognized argument: " + String(arg) };
    }
  }
  return parsed;
}

/** Run the gate and return the process exit code. */
export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write("verify_deposit_closure: " + args.error + "\n");
    return 2;
  }
  const root = resolve(args.projectRoot);
  const result = evaluateDepositClosureAtRoot(root, args.packRootExplicit);
  if (result.stream === "stdout") {
    process.stdout.write(result.message + "\n");
  } else {
    process.stderr.write(result.message + "\n");
  }
  return result.code;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
