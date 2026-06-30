#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { parseDoctorFlags } from "@deftai/directive-core/dist/doctor/flags.js";
import { cmdDoctor } from "@deftai/directive-core/dist/doctor/main.js";
import { renderPrecutoverLine } from "@deftai/directive-core/dist/vbrief-validate/precutover.js";
import { renderXbriefMigrationLine } from "@deftai/directive-core/xbrief-migrate";

export function run(argv: string[]): number {
  // #2022: surface pre-cutover (pre-v0.20 document model) migration state alongside the
  // core doctor report. Only emit on a valid, human-readable invocation: suppressed under
  // --json (so the machine-readable report stays valid), on --help, and when unknown flags
  // are present (so an invalid invocation still mirrors the core error path exactly).
  const flags = parseDoctorFlags(argv);
  if (!flags.json && !flags.help && flags.unknown.length === 0) {
    const projectRoot = flags.projectRoot ?? process.cwd();
    process.stdout.write(`${renderPrecutoverLine(projectRoot)}\n`);
    process.stdout.write(`${renderXbriefMigrationLine(projectRoot)}\n`);
  }
  return cmdDoctor(argv);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
