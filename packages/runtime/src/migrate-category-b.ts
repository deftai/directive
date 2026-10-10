#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { migrateCategoryBCorpus } from "@deftai/directive-core/category-b-namespace";

export interface ParsedMigrateCategoryBArgs {
  projectRoot: string;
  error?: string;
}

export function parseArgs(argv: readonly string[]): ParsedMigrateCategoryBArgs {
  let projectRoot = ".";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { projectRoot, error: "argument --project-root: expected one argument" };
      }
      projectRoot = value;
      i += 1;
    } else if (arg.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else {
      return { projectRoot, error: `unrecognized argument: ${arg}` };
    }
  }
  return { projectRoot };
}

/** Migrate Category B bare plan keys to the x-directive/ namespace (#1650). */
export function run(argv: readonly string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`migrate:category-b: ${args.error}\n`);
    return 2;
  }

  const result = migrateCategoryBCorpus(args.projectRoot);
  if (result.conflicts.length > 0) {
    for (const conflict of result.conflicts) {
      process.stderr.write(
        `migrate:category-b: conflict in ${conflict.path}: ${conflict.message}\n`,
      );
    }
    return 1;
  }
  if (result.changed.length === 0) {
    process.stdout.write(
      `migrate:category-b: ${result.scanned} vBRIEF file(s) scanned -- already namespaced.\n`,
    );
    return 0;
  }
  process.stdout.write(
    `migrate:category-b: namespaced ${result.changed.length} of ${result.scanned} vBRIEF file(s):\n`,
  );
  for (const path of result.changed) {
    process.stdout.write(`  ${path}\n`);
  }
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
