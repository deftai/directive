#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateLinks } from "@deftai/core/validate-content";

interface ParsedArgs {
  strict: boolean;
  error?: string;
}

/** Parse validate-links CLI args, mirroring scripts/validate-links.py. */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { strict: false };
  for (const arg of argv) {
    if (arg === "--strict") {
      parsed.strict = true;
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
    process.stderr.write(`validate-links: ${args.error}\n`);
    return 2;
  }
  const result = validateLinks.evaluate({
    cwd: resolve("."),
    strict: args.strict,
    argv,
    linkCheckStrict: process.env.LINK_CHECK_STRICT === "1",
  });
  process.stdout.write(`${result.message}\n`);
  return result.code;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
