#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateRuleOwnership } from "@deftai/core/verify-source";

interface ParsedArgs {
  mapPath: string | null;
  root: string | null;
  error?: string;
}

/** Parse rule-ownership-lint CLI args, mirroring scripts/rule_ownership_lint.py. */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { mapPath: null, root: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--map") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --map: expected one argument" };
      }
      parsed.mapPath = value;
      i += 1;
    } else if (arg?.startsWith("--map=")) {
      parsed.mapPath = arg.slice("--map=".length);
    } else if (arg === "--root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --root: expected one argument" };
      }
      parsed.root = value;
      i += 1;
    } else if (arg?.startsWith("--root=")) {
      parsed.root = arg.slice("--root=".length);
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
    process.stderr.write(`rule_ownership_lint: ${args.error}\n`);
    return 2;
  }
  const root = resolve(args.root ?? ".");
  const result = evaluateRuleOwnership(root, {
    root,
    mapPath: args.mapPath !== null ? resolve(args.mapPath) : undefined,
  });
  if (result.stream === "stdout") {
    process.stdout.write(`${result.message}\n`);
  } else {
    process.stderr.write(`${result.message}\n`);
  }
  return result.code;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
