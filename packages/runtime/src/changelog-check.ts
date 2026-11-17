#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Deep dist import (#1993) so vitest resolves it to core's TS source.
import { runChangelogCheck } from "@deftai/directive-core/dist/task-surface/index.js";
import { mergeGroupSkip } from "@deftai/directive-core/pr-wait-mergeable";

function parseChangelogCheckArgs(argv: readonly string[]): {
  projectRoot: string;
  againstMergeBase: boolean;
  error?: string;
} {
  let projectRoot = ".";
  let againstMergeBase = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          projectRoot,
          againstMergeBase,
          error: "argument --project-root: expected one argument",
        };
      }
      projectRoot = value;
      i += 1;
    } else if (arg.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--against-merge-base") {
      againstMergeBase = true;
    } else {
      return { projectRoot, againstMergeBase, error: `unrecognized argument: ${arg}` };
    }
  }
  return { projectRoot, againstMergeBase };
}

export function run(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const args = parseChangelogCheckArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`changelog-check: ${args.error}\n`);
    return 2;
  }
  // #6296 item 6: the merge-base form (`verify:changelog-unreleased`) judges one
  // PR's own change set, so it skips the merge queue's group commit.
  if (args.againstMergeBase) {
    const skip = mergeGroupSkip("verify:changelog-unreleased", env);
    if (skip !== null) {
      process.stdout.write(`${skip}\n`);
      return 0;
    }
  }
  return runChangelogCheck(
    resolve(args.projectRoot),
    {
      writeOut: (text) => {
        process.stdout.write(text);
      },
      writeErr: (text) => {
        process.stderr.write(text);
      },
    },
    { againstMergeBase: args.againstMergeBase },
  );
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
