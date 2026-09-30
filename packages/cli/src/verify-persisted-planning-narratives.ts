#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluatePersistedPlanningNarratives } from "@deftai/directive-core/project";

interface ParsedArgs {
  projectRoot: string;
  error?: string;
}

/** Parse verify:persisted-planning-narratives CLI args (#5176). */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { projectRoot: "." };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
      parsed.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "usage: verify:persisted-planning-narratives [--project-root PATH]\n\n" +
          "Fail closed when every tracked PROJECT-DEFINITION planning narrative\n" +
          "(Overview + tech stack) is empty/whitespace (#5176 Prefer-A).\n" +
          "Reuse deft project:write-narratives to store non-empty values.\n",
      );
      return parsed;
    } else {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    }
  }
  return parsed;
}

/** Run the Prefer-A first-ship planning-narrative bar. */
export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`verify:persisted-planning-narratives: ${args.error}\n`);
    return 2;
  }

  const result = evaluatePersistedPlanningNarratives(resolve(args.projectRoot));
  if (result.ok) {
    process.stdout.write(`${result.message}\n`);
    return 0;
  }
  process.stderr.write(`${result.message}\n`);
  return result.code;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
