#!/usr/bin/env node
/**
 * CLI for verify:persisted-planning-narratives (#5176 Prefer-A).
 *
 * Default mode is the unconditional setup Phase 2 bar. `--check-conjunct`
 * mirrors the in-process deft check Prefer-A gate (marker present/unreadable +
 * empty Overview/tech stack → refuse; missing PD / no marker → pass) so
 * Taskfile aggregates like check:merge / check:consumer cannot bypass it.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkRejectsEmptyPlanningNarratives,
  evaluateCheckPersistedPlanningNarratives,
} from "@deftai/directive-core/check";
import { evaluatePersistedPlanningNarratives } from "@deftai/directive-core/project";

interface ParsedArgs {
  projectRoot: string;
  checkConjunct: boolean;
  error?: string;
}

/** Parse verify:persisted-planning-narratives CLI args (#5176). */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { projectRoot: ".", checkConjunct: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
      parsed.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--check-conjunct") {
      parsed.checkConjunct = true;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "usage: verify:persisted-planning-narratives [--project-root PATH] [--check-conjunct]\n\n" +
          "Fail closed when every tracked PROJECT-DEFINITION planning narrative\n" +
          "(Overview + tech stack) is empty/whitespace (#5176 Prefer-A).\n" +
          "Default: unconditional setup Phase 2 bar (missing PD → exit 2).\n" +
          "--check-conjunct: Taskfile/check Prefer-A mirror (marker + empty →\n" +
          "refuse; missing PD / no marker → pass). Reuse deft project:write-narratives.\n",
      );
      return parsed;
    } else {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    }
  }
  return parsed;
}

/** Run the Prefer-A first-ship planning-narrative bar. */
export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`verify:persisted-planning-narratives: ${args.error}\n`);
    return 2;
  }

  const projectRoot = resolve(args.projectRoot);
  if (args.checkConjunct) {
    const planning = evaluateCheckPersistedPlanningNarratives(projectRoot);
    if (checkRejectsEmptyPlanningNarratives(planning.narratives, planning.productMutation)) {
      process.stderr.write(`${planning.narratives.message}\n`);
      return 1;
    }
    if (planning.narratives.ok) {
      process.stdout.write(`${planning.narratives.message}\n`);
    } else {
      process.stdout.write(
        "verify:persisted-planning-narratives --check-conjunct: pass " +
          `(${planning.narratives.cause}; Prefer-A check conjunct does not refuse)\n`,
      );
    }
    return 0;
  }

  const result = evaluatePersistedPlanningNarratives(projectRoot);
  if (result.ok) {
    process.stdout.write(`${result.message}\n`);
    return 0;
  }
  process.stderr.write(`${result.message}\n`);
  return result.code;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
