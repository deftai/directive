#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { resolveRepoFromGitOrigin } from "@deftai/directive-core/dist/scm/design-critique-chip.js";
import {
  classifyIssue,
  resolveClassifyRules,
  resolveHoldMarkers,
} from "@deftai/directive-core/dist/triage/classify/index.js";
import {
  CLASSIFY_MIRROR_WITHDRAWN_MESSAGE,
  type ListWithdrawnChipIssues,
  stripWithdrawnChips,
} from "@deftai/directive-core/dist/triage/classify/withdraw.js";
import type { LabelClient } from "@deftai/directive-core/dist/vbrief-reconcile/types.js";

export interface StripParsedArgs {
  projectRoot: string;
  apply: boolean;
  json: boolean;
  emitDigest: boolean;
  repo: string | null;
  error?: string;
}

export function parseStripArgs(argv: string[]): StripParsedArgs {
  const parsed: StripParsedArgs = {
    projectRoot: ".",
    apply: false,
    json: false,
    emitDigest: false,
    repo: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") {
      parsed.apply = true;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--emit-digest") {
      parsed.emitDigest = true;
    } else if (arg === "--repo") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --repo: expected one argument" };
      }
      parsed.repo = value;
      i += 1;
    } else if (arg?.startsWith("--repo=")) {
      parsed.repo = arg.slice("--repo=".length);
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
      parsed.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--help" || arg === "-h") {
      return parsed;
    } else if (arg === "--") {
    } else if (arg?.startsWith("-")) {
      return { ...parsed, error: `unrecognized arguments: ${arg}` };
    }
  }
  return parsed;
}

export interface StripRunOptions {
  readonly labelClient?: LabelClient;
  readonly resolveDefaultRepo?: () => string | null;
  readonly listIssues?: ListWithdrawnChipIssues;
}

export function runStripWithdrawn(argv: string[], options: StripRunOptions = {}): number {
  const args = parseStripArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`ERR: ${args.error}\n`);
    return 2;
  }
  const repo = args.repo ?? (options.resolveDefaultRepo ?? resolveRepoFromGitOrigin)();
  if (repo === null || repo.length === 0) {
    process.stderr.write("ERR: missing --repo OWNER/NAME (could not resolve from git origin)\n");
    return 2;
  }
  const rules = resolveClassifyRules({ projectRoot: args.projectRoot });
  const holdMarkers = resolveHoldMarkers({ projectRoot: args.projectRoot });
  const [code, outcome] = stripWithdrawnChips({
    repo,
    dryRun: !args.apply,
    emitDigest: args.emitDigest,
    classify: args.emitDigest
      ? (issue, opts) =>
          classifyIssue(issue, {
            rules: (opts?.rules as typeof rules | undefined) ?? rules,
            holdMarkers: opts?.holdMarkers ?? holdMarkers,
          })
      : undefined,
    rules,
    holdMarkers,
    ...(options.labelClient !== undefined ? { client: options.labelClient } : {}),
    ...(options.listIssues !== undefined ? { listIssues: options.listIssues } : {}),
  });
  if (args.json) {
    process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
  } else {
    process.stdout.write(
      `strip-withdrawn-chips repo=${outcome.repo} dry-run=${outcome.dry_run} ` +
        `scanned=${outcome.scanned} planned=${outcome.planned} applied=${outcome.applied} ` +
        `unchanged=${outcome.unchanged} errors=${outcome.errors}\n`,
    );
    process.stdout.write(`${CLASSIFY_MIRROR_WITHDRAWN_MESSAGE}\n`);
  }
  return code;
}

/** Dispatch handler name (`CLI_MODULE_VERBS` looks for `run`). */
export const run = runStripWithdrawn;

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(runStripWithdrawn(process.argv.slice(2)));
}
