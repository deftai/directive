#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { interceptHelp } from "../../core/dist/triage/help/index.js";
import {
  DEFAULT_FIXTURE_REL,
  parseSmoketestArgs,
  runSmoketest,
} from "../../core/dist/triage/smoketest/index.js";

function resolveDeftRoot(): string {
  if (process.env.DEFT_ROOT !== undefined && process.env.DEFT_ROOT.length > 0) {
    return resolve(process.env.DEFT_ROOT);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export function run(argv: string[]): number {
  const helpRc = interceptHelp("triage_smoketest", argv);
  if (helpRc !== null) {
    return helpRc;
  }

  const args = parseSmoketestArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`${args.error}\n`);
    return 2;
  }
  if (args.showHelp) {
    return 0;
  }

  const deftRoot = resolveDeftRoot();
  const fixtureRoot = resolve(
    args.fixture !== "" ? args.fixture : join(deftRoot, DEFAULT_FIXTURE_REL),
  );
  if (!existsSync(fixtureRoot) || !statSync(fixtureRoot).isDirectory()) {
    process.stderr.write(
      `[triage:smoketest] FAIL: fixture root ${fixtureRoot} does not exist ` +
        "or is not a directory.\n",
    );
    return 1;
  }

  return runSmoketest(fixtureRoot, {
    verbose: args.verbose,
    keepTempdir: args.keepTempdir,
    cacheOnly: args.cacheOnly,
    deftRoot,
  });
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
