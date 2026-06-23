#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  emitBypassWarning,
  emitVerifyJson,
  verifySessionRitual,
} from "@deftai/directive-core/session";

interface ParsedArgs {
  projectRoot: string;
  tier: "quick" | "gated";
  emitJson: boolean;
  error?: string;
}

/** Parse verify-session-ritual CLI args, mirroring scripts/verify_session_ritual.py. */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { projectRoot: ".", tier: "quick", emitJson: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      parsed.emitJson = true;
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
      parsed.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--tier") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --tier: expected one argument" };
      }
      if (value !== "quick" && value !== "gated") {
        return { ...parsed, error: `argument --tier: invalid choice: '${value}'` };
      }
      parsed.tier = value;
      i += 1;
    } else if (arg?.startsWith("--tier=")) {
      const value = arg.slice("--tier=".length);
      if (value !== "quick" && value !== "gated") {
        return { ...parsed, error: `argument --tier: invalid choice: '${value}'` };
      }
      parsed.tier = value;
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
    process.stderr.write(`verify_session_ritual: ${args.error}\n`);
    return 2;
  }
  const projectRoot = resolve(args.projectRoot);
  const result = verifySessionRitual(projectRoot, { tier: args.tier });
  const warning = emitBypassWarning(result);
  const warningNeeded = result.bypassed && result.wouldFailCode !== null;

  if (args.emitJson) {
    process.stdout.write(`${emitVerifyJson(result)}\n`);
  } else if (result.code === 0) {
    if (!warningNeeded) {
      process.stdout.write(`${result.message}\n`);
    }
  } else {
    process.stderr.write(`${result.message}\n`);
  }
  if (warning.length > 0) {
    process.stderr.write(`${warning}\n`);
  }
  return result.code;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
