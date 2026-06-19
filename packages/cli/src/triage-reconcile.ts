#!/usr/bin/env node
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  emitReconcileJson,
  reconcile,
  reconcileSummary,
} from "../../core/dist/triage/reconcile/index.js";

export interface ParsedArgs {
  projectRoot: string;
  repo?: string;
  dryRun: boolean;
  emitJson: boolean;
  error?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    projectRoot: process.env.DEFT_PROJECT_ROOT ?? ".",
    dryRun: false,
    emitJson: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--json") parsed.emitJson = true;
    else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined)
        return { ...parsed, error: "argument --project-root: expected one argument" };
      parsed.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--repo") {
      const value = argv[i + 1];
      if (value === undefined)
        return { ...parsed, error: "argument --repo: expected one argument" };
      parsed.repo = value;
      i += 1;
    } else if (arg?.startsWith("--repo=")) {
      parsed.repo = arg.slice("--repo=".length);
    } else {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    }
  }
  return parsed;
}

export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`triage:reconcile: ${args.error}\n`);
    return 2;
  }
  const projectRoot = resolve(args.projectRoot);
  try {
    if (!statSync(projectRoot).isDirectory()) {
      process.stderr.write(
        `❌ triage:reconcile: --project-root ${projectRoot} does not exist or is not a directory.\n`,
      );
      return 2;
    }
  } catch {
    process.stderr.write(
      `❌ triage:reconcile: --project-root ${projectRoot} does not exist or is not a directory.\n`,
    );
    return 2;
  }

  const result = reconcile(projectRoot, {
    repo: args.repo ?? process.env.DEFT_TRIAGE_REPO ?? null,
    dryRun: args.dryRun,
  });

  if (args.emitJson) {
    process.stdout.write(`${emitReconcileJson(result)}\n`);
  } else {
    process.stdout.write(`${reconcileSummary(result)}\n`);
  }
  return result.exitCode;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
