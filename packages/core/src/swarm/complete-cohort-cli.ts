#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { completeCohort } from "./complete-cohort.js";

export function completeCohortMain(argv: string[] = process.argv.slice(2)): number {
  const stories: string[] = [];
  const cohortGlobs: string[] = [];
  let projectRoot = ".";
  let dryRun = false;
  let emitJson = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--cohort" && argv[i + 1] !== undefined) {
      cohortGlobs.push(argv[i + 1] ?? "");
      i += 1;
    } else if (arg === "--project-root" && argv[i + 1] !== undefined) {
      projectRoot = argv[i + 1] ?? ".";
      i += 1;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--json") {
      emitJson = true;
    } else if (arg !== undefined && !arg.startsWith("-")) {
      stories.push(arg);
    }
  }
  const result = completeCohort({ stories, cohortGlobs, projectRoot, dryRun, emitJson });
  if (result.stdout.length > 0) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr.length > 0) {
    process.stderr.write(result.stderr);
  }
  return result.exitCode;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(completeCohortMain());
}
