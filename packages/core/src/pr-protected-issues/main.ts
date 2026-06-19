import { EXIT_EXTERNAL_ERROR, EXIT_OK, EXIT_PROTECTED_LINKED } from "./constants.js";
import { defaultRunGh, fetchClosingIssuesReferences } from "./gh.js";
import { parseProtected } from "./parse.js";
import type { RunGhFn } from "./types.js";

export interface ParsedArgs {
  readonly prNumber: number | null;
  readonly protectedValues: readonly string[];
  readonly repo: string | null;
  readonly error?: string;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let prNumber: number | null = null;
  const protectedValues: string[] = [];
  let repo: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--protected") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          prNumber,
          protectedValues,
          repo,
          error: "argument --protected: expected one argument",
        };
      }
      protectedValues.push(value);
      i += 1;
    } else if (arg?.startsWith("--protected=")) {
      protectedValues.push(arg.slice("--protected=".length));
    } else if (arg === "--repo") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          prNumber,
          protectedValues,
          repo,
          error: "argument --repo: expected one argument",
        };
      }
      repo = value;
      i += 1;
    } else if (arg?.startsWith("--repo=")) {
      repo = arg.slice("--repo=".length);
    } else if (arg?.startsWith("-")) {
      return {
        prNumber,
        protectedValues,
        repo,
        error: `unrecognized arguments: ${arg}`,
      };
    } else if (prNumber === null) {
      const n = Number(arg);
      if (!Number.isInteger(n)) {
        return {
          prNumber,
          protectedValues,
          repo,
          error: `invalid PR number: ${arg}`,
        };
      }
      prNumber = n;
    } else {
      return {
        prNumber,
        protectedValues,
        repo,
        error: `unrecognized arguments: ${arg}`,
      };
    }
  }

  if (prNumber === null) {
    return {
      prNumber,
      protectedValues,
      repo,
      error: "the following arguments are required: pr_number",
    };
  }
  return { prNumber, protectedValues, repo };
}

export interface RunOptions {
  readonly runGh?: RunGhFn;
}

export function run(argv: readonly string[], options: RunOptions = {}): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`Error: ${args.error}\n`);
    return EXIT_EXTERNAL_ERROR;
  }

  let protectedIssues: number[];
  try {
    protectedIssues = parseProtected(args.protectedValues);
  } catch (exc: unknown) {
    const message = exc instanceof Error ? exc.message : String(exc);
    process.stderr.write(`Error: ${message}\n`);
    return EXIT_EXTERNAL_ERROR;
  }

  if (protectedIssues.length === 0) {
    process.stderr.write(`PR #${args.prNumber}: no --protected issues supplied; skipping check.\n`);
    return EXIT_OK;
  }

  const runGh = options.runGh ?? defaultRunGh;
  const linked = fetchClosingIssuesReferences(args.prNumber as number, args.repo, runGh);
  if (linked === null) {
    return EXIT_EXTERNAL_ERROR;
  }

  const linkedSorted = [...new Set(linked)].sort((a, b) => a - b);
  process.stderr.write(
    `PR #${args.prNumber}: closingIssuesReferences = ${JSON.stringify(linkedSorted)}\n`,
  );

  const protectedSet = new Set(protectedIssues);
  const overlap = linked.filter((n) => protectedSet.has(n));
  const overlapSorted = [...new Set(overlap)].sort((a, b) => a - b);

  if (overlapSorted.length > 0) {
    const offenders = overlapSorted.map((n) => `#${n}`).join(", ");
    process.stderr.write(
      `FAIL: PR #${args.prNumber} has persistent linked-issue relationships ` +
        `with protected issue(s): ${offenders}. The link is recorded in GitHub's ` +
        `database from a prior PR body revision (or sidebar attachment) and ` +
        `survives subsequent body edits. Manually unlink via the PR's ` +
        `'Development' sidebar panel (web UI -> PR -> right-side Development ` +
        `section -> X next to the linked issue) before merging. See #701.\n`,
    );
    return EXIT_PROTECTED_LINKED;
  }

  const protectedStr = protectedIssues.map((n) => `#${n}`).join(", ");
  process.stderr.write(
    `OK: PR #${args.prNumber} has no persistent links to any protected issue ` +
      `(${protectedStr}). Safe to squash-merge with respect to Layer 3 (#701).\n`,
  );
  return EXIT_OK;
}

export function cmdPrProtectedIssues(argv: readonly string[], options: RunOptions = {}): number {
  return run(argv, options);
}
