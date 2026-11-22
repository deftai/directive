#!/usr/bin/env node
/**
 * CLI for `project:write-header-line` (#6973).
 *
 * The one writer of the unmanaged AGENTS.md one-liner. Takes `--line` or the
 * first qualifying sentence of the confirmed Overview, replaces only the exact
 * scaffold placeholder (compare-and-set with a re-read guard), prints the file,
 * the line and the next step, and never commits. In a linked worktree it writes
 * nothing: the line lands once from the primary checkout, and worker branches
 * rebase onto it. Prospective scope-cover admits the exact change without a
 * story scope; branch policy is unchanged.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readConfirmedOverviewAtRoot } from "@deftai/directive-core/check";
import {
  CONSUMER_HEADER_ONELINER_MAX_CHARS,
  writeConsumerHeaderLineAtRoot,
} from "@deftai/directive-core/platform";
import { isLinkedWorktreePath } from "@deftai/directive-core/session";

const PREFIX = "project:write-header-line";

export const HEADER_LINE_NEXT_STEP =
  "Next: commit AGENTS.md on a feature branch and open a pull request " +
  "(prospective scope-cover admits this exact change without a story scope).";

interface ParsedArgs {
  projectRoot: string;
  line: string | null;
  error?: string;
}

/** Parse `--project-root <p>` and `--line <text>` (also `--flag=value`). */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { projectRoot: ".", line: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    const eq = arg.indexOf("=");
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    if (flag !== "--project-root" && flag !== "--line") {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    }
    let value: string | undefined;
    if (eq > 0) {
      value = arg.slice(eq + 1);
    } else {
      value = argv[i + 1];
      i += 1;
    }
    const missing =
      value === undefined ||
      (flag === "--project-root" && (value.length === 0 || value.startsWith("-")));
    if (missing || value === undefined) {
      return { ...parsed, error: `argument ${flag}: expected one argument` };
    }
    if (flag === "--project-root") parsed.projectRoot = value;
    else parsed.line = value;
  }
  return parsed;
}

function issueText(issue: string): string {
  switch (issue) {
    case "too-long":
      return `longer than ${String(CONSUMER_HEADER_ONELINER_MAX_CHARS)} characters`;
    case "markup":
      return "contains an HTML comment or starts with a heading mark";
    case "multi-line":
      return "is more than one line";
    case "placeholder":
      return "is the scaffold placeholder";
    case "empty":
      return "is empty";
    default:
      return "no sentence found";
  }
}

/** Run the verb and return the process exit code. */
export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`${PREFIX}: ${args.error}\n`);
    return 2;
  }
  const root = resolve(args.projectRoot);
  if (isLinkedWorktreePath(root)) {
    process.stderr.write(
      `${PREFIX}: refused in a linked worktree (${root}); nothing written. Run it in the ` +
        "primary checkout on a branch from the delivery branch, land that change, then " +
        "rebase this branch.\n",
    );
    return 1;
  }
  const result = writeConsumerHeaderLineAtRoot(root, {
    line: args.line,
    readOverview: () => readConfirmedOverviewAtRoot(root),
  });
  switch (result.kind) {
    case "written":
      process.stdout.write(
        `${PREFIX}: wrote ${result.path}\n  one-liner: ${result.line}\n${HEADER_LINE_NEXT_STEP}\n`,
      );
      return 0;
    case "not-placeholder":
      process.stdout.write(
        `${PREFIX}: ${result.path} one-liner is not the scaffold placeholder; nothing written` +
          (result.current === null ? "" : ` (current: ${result.current})`) +
          "\n",
      );
      return 0;
    case "no-agents-md":
      process.stdout.write(`${PREFIX}: no AGENTS.md at ${result.path}; nothing written\n`);
      return 0;
    case "no-overview":
      process.stderr.write(
        `${PREFIX}: no confirmed Overview in PROJECT-DEFINITION; nothing written. ` +
          'Pass --line "<one sentence>".\n',
      );
      return 1;
    case "no-line":
      process.stderr.write(
        `${PREFIX}: the candidate one-liner ${issueText(result.issue)}; nothing written.\n` +
          (result.candidate.length > 0 ? `  candidate: ${result.candidate}\n` : "") +
          `  Pass --line "<one sentence of at most ${String(CONSUMER_HEADER_ONELINER_MAX_CHARS)} characters>".\n`,
      );
      return 1;
    case "failed":
      process.stderr.write(`${PREFIX}: ${result.path}: ${result.detail}; nothing written\n`);
      return 1;
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
