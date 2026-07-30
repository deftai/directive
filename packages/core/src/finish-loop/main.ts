/**
 * CLI entry for pr:finish-loop and directive:finish-loop (#871).
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { runDirectiveFinishLoop } from "./directive-finish-loop.js";
import { runPrFinishLoop } from "./pr-finish-loop.js";
import { EXIT_BLOCKED, EXIT_OK } from "./types.js";

export interface ParsedPrFinishArgs {
  readonly prNumber: number | null;
  readonly repo: string | null;
  readonly projectRoot: string;
  readonly maxWaitMinutes: number | null;
  readonly pollSeconds: number | null;
  readonly oneShot: boolean;
  readonly merge: boolean;
  readonly emitJson: boolean;
  readonly help: boolean;
  readonly error?: string;
}

export interface ParsedDirectiveFinishArgs {
  readonly prNumber: number | null;
  readonly repo: string | null;
  readonly projectRoot: string;
  readonly maxIterations: number | null;
  readonly maxWaitMinutes: number | null;
  readonly pollSeconds: number | null;
  readonly oneShot: boolean;
  readonly merge: boolean;
  readonly emitJson: boolean;
  readonly help: boolean;
  readonly error?: string;
}

const PR_HELP =
  "usage: task pr:finish-loop -- <pr_number> [options]\n" +
  "\n" +
  "Walk-away PR finish loop (#871 Wave 5). Requires a finish-loop human-origin\n" +
  "grant (`deft authz:grant -- --template finish-loop`) or DEFT_ALLOW_FINISH_LOOP=1.\n" +
  "Polls via pr:watch until CLEAN. NEW_P0_P1 → exit 1 (agent address path).\n" +
  "Respects plan.policy.requireHumanMerge (never force bot merge).\n" +
  "\n" +
  "options:\n" +
  "  -h, --help              Show this help\n" +
  "  --json                  Emit structured JSON\n" +
  "  --one-shot              Single pr:watch probe\n" +
  "  --merge                 Attempt merge when CLEAN and policy allows\n" +
  "  --max-wait-minutes N    pr:watch cap (default 30)\n" +
  "  --poll-seconds N        pr:watch interval (default 90)\n" +
  "  --repo OWNER/REPO       Override repository\n" +
  "  --project-root PATH     Project root (default cwd)\n" +
  "\n" +
  "exit codes:\n" +
  "  0  CLEAN / MERGED\n" +
  "  1  ACTION_REQUIRED (NEW_P0_P1 address, or require-human-merge)\n" +
  "  2  BLOCKED (no grant) / watch error / timeout\n";

const DIRECTIVE_HELP =
  "usage: task directive:finish-loop -- [options]\n" +
  "\n" +
  "Outer walk-away cascade (#871 Wave 5). Gates on finish-loop grant, scans\n" +
  "xbrief active/pending queue, logs `.deft-cache/finish-loop-progress.jsonl`,\n" +
  "optionally shepherds a PR via pr:finish-loop. Implementation steps are\n" +
  "agent-orchestrated (exit 1 AGENT_STEP) — full autonomous coding is not\n" +
  "inlined in the CLI.\n" +
  "\n" +
  "Mint once, walk away:\n" +
  "  deft authz:grant -- --template finish-loop\n" +
  "  task directive:finish-loop --\n" +
  "\n" +
  "options:\n" +
  "  -h, --help              Show this help\n" +
  "  --json                  Emit structured JSON\n" +
  "  --pr N                  Shepherd PR N via pr:finish-loop this run\n" +
  "  --merge                 Pass --merge to pr:finish-loop\n" +
  "  --one-shot              Single pr:watch probe\n" +
  "  --max-iterations N      Outer loop cap (default 20)\n" +
  "  --max-wait-minutes N    pr:watch cap\n" +
  "  --poll-seconds N        pr:watch interval\n" +
  "  --repo OWNER/REPO       Override repository\n" +
  "  --project-root PATH     Project root (default cwd)\n" +
  "\n" +
  "exit codes:\n" +
  "  0  empty queue / clean complete\n" +
  "  1  AGENT_STEP / address findings / require-human-merge\n" +
  "  2  BLOCKED (grant/gate/max-iterations/error)\n";

function takePositive(
  label: string,
  raw: string | undefined,
): { value: number } | { error: string } {
  if (raw === undefined) return { error: `argument ${label}: expected one argument` };
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return { error: `invalid ${label} value: ${raw}` };
  }
  return { value: parsed };
}

export function parsePrFinishArgs(argv: readonly string[]): ParsedPrFinishArgs {
  const acc: ParsedPrFinishArgs = {
    prNumber: null,
    repo: null,
    projectRoot: process.cwd(),
    maxWaitMinutes: null,
    pollSeconds: null,
    oneShot: false,
    merge: false,
    emitJson: false,
    help: false,
  };
  let prNumber: number | null = null;
  let repo: string | null = null;
  let projectRoot = process.cwd();
  let maxWaitMinutes: number | null = null;
  let pollSeconds: number | null = null;
  let oneShot = false;
  let merge = false;
  let emitJson = false;
  let help = false;

  const args = [...argv];
  while (args[0] === "--") args.shift();

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) break;
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--json") {
      emitJson = true;
    } else if (arg === "--one-shot") {
      oneShot = true;
    } else if (arg === "--merge") {
      merge = true;
    } else if (arg === "--repo") {
      const value = args[++i];
      if (value === undefined) return { ...acc, error: "argument --repo: expected one argument" };
      repo = value;
    } else if (arg.startsWith("--repo=")) {
      repo = arg.slice("--repo=".length);
    } else if (arg === "--project-root") {
      const value = args[++i];
      if (value === undefined) {
        return { ...acc, error: "argument --project-root: expected one argument" };
      }
      projectRoot = value;
    } else if (arg.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--max-wait-minutes") {
      const r = takePositive("--max-wait-minutes", args[++i]);
      if ("error" in r) return { ...acc, error: r.error };
      maxWaitMinutes = r.value;
    } else if (arg === "--poll-seconds") {
      const r = takePositive("--poll-seconds", args[++i]);
      if ("error" in r) return { ...acc, error: r.error };
      pollSeconds = r.value;
    } else if (arg.startsWith("-")) {
      return { ...acc, error: `unrecognized arguments: ${arg}` };
    } else if (prNumber === null) {
      const n = Number(arg);
      if (!Number.isInteger(n) || n <= 0) {
        return { ...acc, error: `invalid PR number: ${arg}` };
      }
      prNumber = n;
    } else {
      return { ...acc, error: `unrecognized arguments: ${arg}` };
    }
  }

  if (help) {
    return {
      prNumber,
      repo,
      projectRoot,
      maxWaitMinutes,
      pollSeconds,
      oneShot,
      merge,
      emitJson,
      help,
    };
  }
  if (prNumber === null) {
    return { ...acc, error: "the following arguments are required: pr_number" };
  }
  return {
    prNumber,
    repo,
    projectRoot,
    maxWaitMinutes,
    pollSeconds,
    oneShot,
    merge,
    emitJson,
    help,
  };
}

export function parseDirectiveFinishArgs(argv: readonly string[]): ParsedDirectiveFinishArgs {
  const acc: ParsedDirectiveFinishArgs = {
    prNumber: null,
    repo: null,
    projectRoot: process.cwd(),
    maxIterations: null,
    maxWaitMinutes: null,
    pollSeconds: null,
    oneShot: false,
    merge: false,
    emitJson: false,
    help: false,
  };
  let prNumber: number | null = null;
  let repo: string | null = null;
  let projectRoot = process.cwd();
  let maxIterations: number | null = null;
  let maxWaitMinutes: number | null = null;
  let pollSeconds: number | null = null;
  let oneShot = false;
  let merge = false;
  let emitJson = false;
  let help = false;

  const args = [...argv];
  while (args[0] === "--") args.shift();

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) break;
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--json") {
      emitJson = true;
    } else if (arg === "--one-shot") {
      oneShot = true;
    } else if (arg === "--merge") {
      merge = true;
    } else if (arg === "--pr") {
      const r = takePositive("--pr", args[++i]);
      if ("error" in r) return { ...acc, error: r.error };
      prNumber = r.value;
    } else if (arg.startsWith("--pr=")) {
      const r = takePositive("--pr", arg.slice("--pr=".length));
      if ("error" in r) return { ...acc, error: r.error };
      prNumber = r.value;
    } else if (arg === "--repo") {
      const value = args[++i];
      if (value === undefined) return { ...acc, error: "argument --repo: expected one argument" };
      repo = value;
    } else if (arg.startsWith("--repo=")) {
      repo = arg.slice("--repo=".length);
    } else if (arg === "--project-root") {
      const value = args[++i];
      if (value === undefined) {
        return { ...acc, error: "argument --project-root: expected one argument" };
      }
      projectRoot = value;
    } else if (arg.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--max-iterations") {
      const r = takePositive("--max-iterations", args[++i]);
      if ("error" in r) return { ...acc, error: r.error };
      maxIterations = r.value;
    } else if (arg === "--max-wait-minutes") {
      const r = takePositive("--max-wait-minutes", args[++i]);
      if ("error" in r) return { ...acc, error: r.error };
      maxWaitMinutes = r.value;
    } else if (arg === "--poll-seconds") {
      const r = takePositive("--poll-seconds", args[++i]);
      if ("error" in r) return { ...acc, error: r.error };
      pollSeconds = r.value;
    } else if (arg.startsWith("-")) {
      return { ...acc, error: `unrecognized arguments: ${arg}` };
    } else {
      return { ...acc, error: `unrecognized arguments: ${arg}` };
    }
  }

  return {
    prNumber,
    repo,
    projectRoot,
    maxIterations,
    maxWaitMinutes,
    pollSeconds,
    oneShot,
    merge,
    emitJson,
    help,
  };
}

export function formatPrFinishHelp(): string {
  return PR_HELP;
}

export function formatDirectiveFinishHelp(): string {
  return DIRECTIVE_HELP;
}

export function cmdPrFinishLoop(argv: readonly string[] = process.argv.slice(2)): number {
  const args = parsePrFinishArgs(argv);
  if (args.help) {
    process.stdout.write(formatPrFinishHelp());
    return EXIT_OK;
  }
  if (args.error !== undefined) {
    process.stderr.write(`pr:finish-loop: ${args.error}\n`);
    process.stderr.write("Try: task pr:finish-loop -- --help\n");
    return EXIT_BLOCKED;
  }
  const root = resolve(args.projectRoot);
  if (!existsSync(root)) {
    process.stderr.write(`pr:finish-loop: --project-root does not exist: ${root}\n`);
    return EXIT_BLOCKED;
  }

  const result = runPrFinishLoop({
    projectRoot: root,
    prNumber: args.prNumber as number,
    repo: args.repo,
    maxWaitMinutes: args.maxWaitMinutes ?? undefined,
    pollSeconds: args.pollSeconds ?? undefined,
    oneShot: args.oneShot,
    merge: args.merge,
  });

  if (args.emitJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${result.message}\n`);
  }
  return result.exitCode;
}

export function cmdDirectiveFinishLoop(argv: readonly string[] = process.argv.slice(2)): number {
  const args = parseDirectiveFinishArgs(argv);
  if (args.help) {
    process.stdout.write(formatDirectiveFinishHelp());
    return EXIT_OK;
  }
  if (args.error !== undefined) {
    process.stderr.write(`directive:finish-loop: ${args.error}\n`);
    process.stderr.write("Try: task directive:finish-loop -- --help\n");
    return EXIT_BLOCKED;
  }
  const root = resolve(args.projectRoot);
  if (!existsSync(root)) {
    process.stderr.write(`directive:finish-loop: --project-root does not exist: ${root}\n`);
    return EXIT_BLOCKED;
  }

  const result = runDirectiveFinishLoop({
    projectRoot: root,
    prNumber: args.prNumber,
    repo: args.repo,
    maxIterations: args.maxIterations ?? undefined,
    maxWaitMinutes: args.maxWaitMinutes ?? undefined,
    pollSeconds: args.pollSeconds ?? undefined,
    oneShot: args.oneShot,
    merge: args.merge,
  });

  if (args.emitJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${result.message}\n`);
    process.stdout.write(`  progress: ${result.progressPath}\n`);
  }
  return result.exitCode;
}
