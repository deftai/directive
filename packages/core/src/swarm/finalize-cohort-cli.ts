#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { EXIT_CONFIG_ERROR, EXIT_OK } from "./constants.js";
import { type FinalizeCohortArgs, finalizeCohort } from "./finalize-cohort.js";

export interface ParsedFinalizeCohortArgv extends FinalizeCohortArgs {
  readonly help: boolean;
  readonly error: string | null;
}

export const FINALIZE_COHORT_USAGE = `Usage: task swarm:finalize-cohort -- [--pr <n>[,<n>...]] [--stories <ids|paths>] [options]

After cohort PRs merge, sweep story briefs active/ -> completed/ and open the lifecycle PR.

Options:
  --pr <n>[,<n>...]            Merged PR numbers (closing issues map to active stories)
  --stories <ids|paths>        Explicit story tokens (repeatable)
  --repo OWNER/REPO            GitHub repo (or $GH_REPO)
  --project-root <path>        Project root (default: cwd)
  --base-branch <name>         Sweep/PR base (default: resolved delivery branch)
  --delivery-branch <name>     Delivery-branch override when policy is untyped
  --label <name>               Feature-branch label
  --dry-run                    Print plan; no git mutation
  --no-commit                  Sweep without committing / opening a PR
  --no-open-pr                 Commit without opening a PR
  --json                       Machine-readable result
  -h, --help                   Show this help
`;

function equalsValue(arg: string, flag: string): string {
  return arg.slice(flag.length + 1);
}

export function parseFinalizeCohortArgv(argv: readonly string[]): ParsedFinalizeCohortArgv {
  const prNumbers: number[] = [];
  const storyTokens: string[] = [];
  let repo: string | null = null;
  let projectRoot = ".";
  let baseBranch: string | undefined;
  let deliveryBranch: string | null = null;
  let label: string | null = null;
  let dryRun = false;
  let noCommit = false;
  let noOpenPr = false;
  let emitJson = false;
  let help = false;
  let error: string | null = null;

  const reject = (arg: string): void => {
    error ??= `unrecognized argument: ${arg}`;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--pr" && next !== undefined) {
      for (const piece of next.split(",")) {
        const trimmed = piece.trim();
        if (/^\d+$/.test(trimmed)) {
          prNumbers.push(Number.parseInt(trimmed, 10));
        }
      }
      i += 1;
    } else if (arg?.startsWith("--pr=")) {
      for (const piece of arg.slice("--pr=".length).split(",")) {
        const trimmed = piece.trim();
        if (/^\d+$/.test(trimmed)) {
          prNumbers.push(Number.parseInt(trimmed, 10));
        }
      }
    } else if (arg === "--stories" && next !== undefined) {
      storyTokens.push(next);
      i += 1;
    } else if (arg?.startsWith("--stories=")) {
      const value = equalsValue(arg, "--stories");
      if (value.length === 0) {
        reject(arg);
      } else {
        storyTokens.push(value);
      }
    } else if (arg === "--repo" && next !== undefined) {
      repo = next;
      i += 1;
    } else if (arg?.startsWith("--repo=")) {
      repo = arg.slice("--repo=".length);
    } else if (arg === "--project-root" && next !== undefined) {
      projectRoot = next;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      const value = equalsValue(arg, "--project-root");
      if (value.length === 0) {
        reject(arg);
      } else {
        projectRoot = value;
      }
    } else if (arg === "--base-branch" && next !== undefined) {
      baseBranch = next;
      i += 1;
    } else if (arg?.startsWith("--base-branch=")) {
      const value = equalsValue(arg, "--base-branch");
      if (value.length === 0) {
        reject(arg);
      } else {
        baseBranch = value;
      }
    } else if (arg === "--delivery-branch" && next !== undefined) {
      deliveryBranch = next;
      i += 1;
    } else if (arg?.startsWith("--delivery-branch=")) {
      deliveryBranch = arg.slice("--delivery-branch=".length);
    } else if (arg === "--label" && next !== undefined) {
      label = next;
      i += 1;
    } else if (arg?.startsWith("--label=")) {
      const value = equalsValue(arg, "--label");
      if (value.length === 0) {
        reject(arg);
      } else {
        label = value;
      }
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--no-commit") {
      noCommit = true;
    } else if (arg === "--no-open-pr") {
      noOpenPr = true;
    } else if (arg === "--json") {
      emitJson = true;
    } else if (arg !== undefined && !arg.startsWith("-")) {
      storyTokens.push(arg);
    } else if (arg !== undefined) {
      reject(arg);
    }
  }

  return {
    prNumbers,
    storyTokens,
    repo,
    projectRoot,
    ...(baseBranch !== undefined ? { baseBranch } : {}),
    deliveryBranch,
    label,
    dryRun,
    noCommit,
    noOpenPr,
    emitJson,
    help,
    error,
  };
}

export function finalizeCohortMain(argv: string[] = process.argv.slice(2)): number {
  const parsed = parseFinalizeCohortArgv(argv);
  if (parsed.help) {
    process.stdout.write(FINALIZE_COHORT_USAGE);
    return EXIT_OK;
  }
  if (parsed.error !== null) {
    process.stderr.write(`${parsed.error}\n`);
    return EXIT_CONFIG_ERROR;
  }
  const result = finalizeCohort(parsed);
  if (result.stdout.length > 0) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr.length > 0) {
    process.stderr.write(result.stderr);
  }
  return result.exitCode;
}

/* v8 ignore start -- entry guard */
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(finalizeCohortMain());
}
/* v8 ignore stop */
