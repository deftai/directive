#!/usr/bin/env node
/**
 * ownership:fix / ownership-fix (#1617)
 * Scoped repair of root-owned objects under approved roots only.
 * Reachable under mismatch; env-sourced owner alone does not authorize chown.
 */
import { resolve } from "node:path";
import {
  DEFT_PROJECT_OWNER,
  fixScopedOwnership,
  OWNERSHIP_FACTS_CLASSIFIER,
} from "@deftai/directive-core/platform";
import { isDirectEntrypoint } from "./entrypoint.js";

export interface OwnershipFixArgs {
  projectRoot: string;
  owner: string | null;
  json: boolean;
  error?: string;
}

export function parseArgs(argv: readonly string[]): OwnershipFixArgs {
  const parsed: OwnershipFixArgs = {
    projectRoot: ".",
    owner: null,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
      parsed.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--owner") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --owner: expected uid:gid" };
      }
      parsed.owner = value;
      i += 1;
    } else if (arg?.startsWith("--owner=")) {
      parsed.owner = arg.slice("--owner=".length);
    } else if (arg === "--help" || arg === "-h") {
      return { ...parsed, error: "__help__" };
    } else {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    }
  }
  return parsed;
}

const HELP =
  "usage: deft ownership:fix [--project-root PATH] [--owner uid:gid] [--json]\n" +
  "Repair root-owned objects under approved project roots only (#1617).\n" +
  "No blanket HOME chown. No symlink follow outside approved roots.\n" +
  `Pass --owner uid:gid or ${DEFT_PROJECT_OWNER}=uid:gid when inference is ambiguous.\n` +
  `Classifier: ${OWNERSHIP_FACTS_CLASSIFIER}\n`;

export function run(argv: readonly string[]): number {
  const args = parseArgs(argv);
  if (args.error === "__help__") {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.error !== undefined) {
    process.stderr.write(`ownership:fix: ${args.error}\n`);
    return 2;
  }
  const projectRoot = resolve(args.projectRoot);
  const result = fixScopedOwnership({
    projectRoot,
    explicitOwner: args.owner,
  });
  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          repaired: result.repaired,
          skipped_protected: result.skippedProtected,
          failed: result.failed,
          messages: result.messages,
          ok: result.ok,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    for (const line of result.messages) {
      process.stdout.write(`${line}\n`);
    }
  }
  return result.exitCode;
}

if (isDirectEntrypoint(import.meta.url)) {
  process.exit(run(process.argv.slice(2)));
}
