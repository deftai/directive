#!/usr/bin/env node
/**
 * verify:ownership / verify-ownership (#1617)
 * Fail-closed check for WSL root-runtime ownership mismatch.
 */
import { resolve } from "node:path";
import {
  assertProtectedMutationOwnership,
  evaluateWslOwnershipGuard,
  ownershipGuardToDict,
} from "@deftai/directive-core/platform";
import { isDirectEntrypoint } from "./entrypoint.js";

export interface VerifyOwnershipArgs {
  projectRoot: string;
  json: boolean;
  owner: string | null;
  error?: string;
}

export function parseArgs(argv: readonly string[]): VerifyOwnershipArgs {
  const parsed: VerifyOwnershipArgs = {
    projectRoot: ".",
    json: false,
    owner: null,
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
  "usage: deft verify:ownership [--project-root PATH] [--owner uid:gid] [--json]\n" +
  "Fail closed when WSL root runtime can create root-owned project files (#1617).\n" +
  "Native Windows/macOS always pass. Mount-pinned DrvFs/9p without metadata passes.\n";

export function run(argv: readonly string[]): number {
  const args = parseArgs(argv);
  if (args.error === "__help__") {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.error !== undefined) {
    process.stderr.write(`verify:ownership: ${args.error}\n`);
    return 2;
  }
  const projectRoot = resolve(args.projectRoot);
  const seams = { projectRoot, explicitOwner: args.owner };
  const gate = assertProtectedMutationOwnership(seams);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(ownershipGuardToDict(gate.verdict), null, 2)}\n`);
  } else {
    process.stdout.write(`${gate.message}\n`);
  }
  if (!gate.ok) return gate.exitCode;
  // Also surface soft warn / override without failing when not blocked.
  const soft = evaluateWslOwnershipGuard(seams);
  if (soft.status === "warn" || soft.status === "exempt-override") {
    if (!args.json) {
      for (const line of soft.sessionWarnLines) process.stderr.write(`${line}\n`);
    }
  }
  return 0;
}

if (isDirectEntrypoint(import.meta.url)) {
  process.exit(run(process.argv.slice(2)));
}
