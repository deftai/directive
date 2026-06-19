#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { expandReadinessPaths, readinessReport } from "./readiness.js";

export function readinessMain(argv: string[] = process.argv.slice(2)): number {
  let projectRoot = ".";
  const paths: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project-root" && argv[i + 1] !== undefined) {
      projectRoot = argv[i + 1] ?? ".";
      i += 1;
    } else if (arg !== undefined && !arg.startsWith("-")) {
      paths.push(arg);
    }
  }
  const expanded = expandReadinessPaths(projectRoot, paths);
  const { exitCode, report } = readinessReport(projectRoot, expanded);
  process.stdout.write(`${report}\n`);
  return exitCode;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(readinessMain());
}
