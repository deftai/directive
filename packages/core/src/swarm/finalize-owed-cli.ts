#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { EXIT_CONFIG_ERROR, EXIT_OK } from "./constants.js";
import { type FinalizeOwedArgs, finalizeOwed } from "./finalize-owed.js";

export interface ParsedFinalizeOwedArgv extends FinalizeOwedArgs {
  readonly help: boolean;
  readonly error: string | null;
}

export const FINALIZE_OWED_USAGE = `Usage: task swarm:finalize-owed -- [options]

Discover ownerless Tracking stories on the delivery tip and run finalize-cohort per story (#4919).

Options:
  --repo OWNER/REPO            GitHub repo (or $GH_REPO / $GITHUB_REPOSITORY)
  --project-root <path>        Project root (default: cwd)
  --delivery-branch <name>     Delivery-branch override when policy is untyped
  --inventory-only             Print owed inventory; do not claim or finalize
  --wait-through-land          Own wait-through-land (default: hand off leftover)
  --dry-run                    Print inventory plan; no claim/finalize
  --json                       Machine-readable result
  -h, --help                   Show this help
`;

function equalsValue(arg: string, flag: string): string {
  return arg.slice(flag.length + 1);
}

export function parseFinalizeOwedArgv(argv: readonly string[]): ParsedFinalizeOwedArgv {
  let repo: string | null = null;
  let projectRoot = ".";
  let deliveryBranch: string | null = null;
  let dryRun = false;
  let emitJson = false;
  let inventoryOnly = false;
  let waitThroughLand = false;
  let help = false;
  let error: string | null = null;

  // Returned parse failure — avoid reject()/throw hard facts for intent-constraint.
  const setParseError = (arg: string): void => {
    error ??= `unrecognized argument: ${arg}`;
  };
  const takeValue = (flag: string, nextValue: string | undefined): string | null => {
    if (nextValue === undefined || nextValue.startsWith("-")) {
      setParseError(flag);
      return null;
    }
    return nextValue;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--repo") {
      const value = takeValue(arg, next);
      if (value !== null) {
        repo = value;
        i += 1;
      }
    } else if (arg?.startsWith("--repo=")) {
      const value = equalsValue(arg, "--repo");
      if (value.length === 0) setParseError(arg);
      else repo = value;
    } else if (arg === "--project-root") {
      const value = takeValue(arg, next);
      if (value !== null) {
        projectRoot = value;
        i += 1;
      }
    } else if (arg?.startsWith("--project-root=")) {
      const value = equalsValue(arg, "--project-root");
      if (value.length === 0) setParseError(arg);
      else projectRoot = value;
    } else if (arg === "--delivery-branch") {
      const value = takeValue(arg, next);
      if (value !== null) {
        deliveryBranch = value;
        i += 1;
      }
    } else if (arg?.startsWith("--delivery-branch=")) {
      const value = equalsValue(arg, "--delivery-branch");
      if (value.length === 0) setParseError(arg);
      else deliveryBranch = value;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--json") {
      emitJson = true;
    } else if (arg === "--inventory-only") {
      inventoryOnly = true;
    } else if (arg === "--wait-through-land") {
      waitThroughLand = true;
    } else if (arg?.startsWith("-")) {
      setParseError(arg);
    } else {
      setParseError(arg ?? "");
    }
  }

  return {
    repo,
    projectRoot,
    deliveryBranch,
    dryRun,
    emitJson,
    inventoryOnly,
    waitThroughLand,
    help,
    error,
  };
}

export function finalizeOwedMain(argv: readonly string[] = process.argv.slice(2)): number {
  const parsed = parseFinalizeOwedArgv(argv);
  if (parsed.help) {
    process.stdout.write(FINALIZE_OWED_USAGE);
    return EXIT_OK;
  }
  if (parsed.error !== null) {
    process.stderr.write(`Error: ${parsed.error}\n${FINALIZE_OWED_USAGE}`);
    return EXIT_CONFIG_ERROR;
  }
  const { help: _h, error: _e, ...args } = parsed;
  const outcome = finalizeOwed(args);
  if (outcome.stdout.length > 0) {
    process.stdout.write(outcome.stdout);
  }
  if (outcome.stderr.length > 0) {
    process.stderr.write(outcome.stderr);
  }
  return outcome.exitCode;
}

/* v8 ignore start -- entry guard */
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(finalizeOwedMain());
}
/* v8 ignore stop */
