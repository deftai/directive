#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import {
  parseCohortReviewMonitorsArgv,
  verifyCohortReviewMonitorsMain,
} from "@deftai/directive-core/swarm";

export { parseCohortReviewMonitorsArgv, verifyCohortReviewMonitorsMain };

export function run(argv: readonly string[] = process.argv.slice(2)): number {
  return verifyCohortReviewMonitorsMain([...argv]);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
