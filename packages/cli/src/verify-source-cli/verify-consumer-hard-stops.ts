#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateConsumerHardStopCensus,
  type HardStopIssue,
  issueFromInventoryRow,
  parseClosesSet,
} from "@deftai/directive-core/release";
import { restIssueListOpenInventory } from "@deftai/directive-core/scm";

interface ParsedArgs {
  repo: string;
  projectRoot: string;
  changelog: string | null;
  error?: string;
}

export interface HardStopCliSeams {
  readonly inventory?: readonly Record<string, unknown>[];
  readonly changelogText?: string;
}

/** Parse verify-consumer-hard-stops CLI args (#3900 / #3713). */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { repo: "deftai/directive", projectRoot: ".", changelog: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo") {
      const value = argv[i + 1];
      if (value === undefined)
        return { ...parsed, error: "argument --repo: expected one argument" };
      parsed.repo = value;
      i += 1;
    } else if (arg?.startsWith("--repo=")) {
      parsed.repo = arg.slice("--repo=".length);
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined)
        return { ...parsed, error: "argument --project-root: expected one argument" };
      parsed.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--changelog") {
      const value = argv[i + 1];
      if (value === undefined)
        return { ...parsed, error: "argument --changelog: expected one argument" };
      parsed.changelog = value;
      i += 1;
    } else if (arg?.startsWith("--changelog=")) {
      parsed.changelog = arg.slice("--changelog=".length);
    } else {
      return { ...parsed, error: "unrecognized argument: " + String(arg) };
    }
  }
  return parsed;
}

export function run(argv: string[], seams: HardStopCliSeams = {}): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write("verify_consumer_hard_stops: " + args.error + "\n");
    return 2;
  }
  const root = resolve(args.projectRoot);
  let changelogText = seams.changelogText;
  if (changelogText === undefined) {
    const changelogPath = resolve(root, args.changelog ?? "CHANGELOG.md");
    try {
      changelogText = readFileSync(changelogPath, "utf8");
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        "verify_consumer_hard_stops: could not read CHANGELOG (" + reason + ")\n",
      );
      return 2;
    }
  }
  let rows: readonly Record<string, unknown>[];
  try {
    rows = seams.inventory ?? restIssueListOpenInventory(args.repo);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      "verify_consumer_hard_stops: fail -- could not list open issues. Recovery: check gh auth and REST quota. " +
        reason +
        "\n",
    );
    return 2;
  }
  const issues: HardStopIssue[] = [];
  for (const row of rows) {
    const issue = issueFromInventoryRow(row);
    if (issue !== null) issues.push(issue);
  }
  const result = evaluateConsumerHardStopCensus({
    issues,
    closesSet: parseClosesSet(changelogText),
  });
  if (result.stream === "stdout") {
    process.stdout.write(result.message + "\n");
  } else {
    process.stderr.write(result.message + "\n");
  }
  return result.code;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
