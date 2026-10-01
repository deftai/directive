#!/usr/bin/env node
/**
 * ownership:doctor / ownership-doctor (#1617)
 * Diagnose WSL root-runtime vs filesystem project-owner mismatch.
 * Reachable under mismatch (not blocked by the protected-mutation guard).
 */
import { resolve } from "node:path";
import {
  evaluateWslOwnershipGuard,
  OWNERSHIP_FACTS_CLASSIFIER,
  ownershipGuardToDict,
} from "@deftai/directive-core/platform";
import { isDirectEntrypoint } from "./entrypoint.js";

export interface OwnershipDoctorArgs {
  projectRoot: string;
  json: boolean;
  owner: string | null;
  error?: string;
}

export function parseArgs(argv: readonly string[]): OwnershipDoctorArgs {
  const parsed: OwnershipDoctorArgs = {
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
  "usage: deft ownership:doctor [--project-root PATH] [--owner uid:gid] [--json]\n" +
  "Diagnose WSL agent-as-root vs filesystem project-owner mismatch (#1617).\n" +
  `Classifier: ${OWNERSHIP_FACTS_CLASSIFIER}\n` +
  "Vocabulary: filesystem project-owner (this command) ≠ occupancy/session owner ≠ issue-emit recovery owner.\n" +
  "Recovery: deft ownership:fix -- --project-root . [--owner uid:gid]\n";

export function run(argv: readonly string[]): number {
  const args = parseArgs(argv);
  if (args.error === "__help__") {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.error !== undefined) {
    process.stderr.write(`ownership:doctor: ${args.error}\n`);
    return 2;
  }
  const projectRoot = resolve(args.projectRoot);
  const verdict = evaluateWslOwnershipGuard({
    projectRoot,
    explicitOwner: args.owner,
  });
  if (args.json) {
    process.stdout.write(`${JSON.stringify(ownershipGuardToDict(verdict), null, 2)}\n`);
  } else {
    for (const line of verdict.messages) {
      process.stdout.write(`${line}\n`);
    }
    if (verdict.intendedOwner.uid !== null) {
      process.stdout.write(
        `filesystem project-owner: ${verdict.intendedOwner.uid}:${verdict.intendedOwner.gid}` +
          `${verdict.intendedOwner.account ? ` (${verdict.intendedOwner.account})` : ""}` +
          ` via ${verdict.intendedOwner.source}\n`,
      );
    }
    process.stdout.write(
      `status=${verdict.status} wsl=${verdict.wsl} mount=${verdict.mount.capability} ` +
        `block_protected_mutation=${verdict.blockProtectedMutation}\n`,
    );
  }
  if (verdict.status === "fail") return 1;
  return 0;
}

if (isDirectEntrypoint(import.meta.url)) {
  process.exit(run(process.argv.slice(2)));
}
