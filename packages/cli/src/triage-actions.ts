#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  accept,
  createDefaultDeps,
  deferAction,
  reject,
  TriageError,
  UpstreamCloseError,
} from "../../core/dist/triage/actions/index.js";

interface ParsedArgs {
  cmd?: string;
  issue?: number;
  repo?: string;
  reason?: string;
  resumeOn?: string;
  actor?: string;
  projectRoot: string;
  error?: string;
}

/** Parse triage-actions CLI argv mirroring ``triage_actions.py`` argparse. */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { projectRoot: process.cwd() };
  if (argv.length === 0) {
    return { ...parsed, error: "missing subcommand" };
  }
  parsed.cmd = argv[0];
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--issue") {
      const value = argv[i + 1];
      if (value === undefined)
        return { ...parsed, error: "argument --issue: expected one argument" };
      parsed.issue = Number.parseInt(value, 10);
      i += 1;
    } else if (arg?.startsWith("--issue=")) {
      parsed.issue = Number.parseInt(arg.slice("--issue=".length), 10);
    } else if (arg === "--repo") {
      const value = argv[i + 1];
      if (value === undefined)
        return { ...parsed, error: "argument --repo: expected one argument" };
      parsed.repo = value;
      i += 1;
    } else if (arg?.startsWith("--repo=")) {
      parsed.repo = arg.slice("--repo=".length);
    } else if (arg === "--reason") {
      const value = argv[i + 1];
      if (value === undefined)
        return { ...parsed, error: "argument --reason: expected one argument" };
      parsed.reason = value;
      i += 1;
    } else if (arg?.startsWith("--reason=")) {
      parsed.reason = arg.slice("--reason=".length);
    } else if (arg === "--resume-on") {
      const value = argv[i + 1];
      if (value === undefined)
        return { ...parsed, error: "argument --resume-on: expected one argument" };
      parsed.resumeOn = value;
      i += 1;
    } else if (arg?.startsWith("--resume-on=")) {
      parsed.resumeOn = arg.slice("--resume-on=".length);
    } else if (arg === "--actor") {
      const value = argv[i + 1];
      if (value === undefined)
        return { ...parsed, error: "argument --actor: expected one argument" };
      parsed.actor = value;
      i += 1;
    } else if (arg?.startsWith("--actor=")) {
      parsed.actor = arg.slice("--actor=".length);
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined)
        return { ...parsed, error: "argument --project-root: expected one argument" };
      parsed.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    }
  }
  return parsed;
}

/** Run triage-actions CLI and return exit code. */
export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`triage_actions: ${args.error}\n`);
    return 2;
  }
  if (args.cmd !== "accept" && args.cmd !== "reject" && args.cmd !== "defer") {
    process.stderr.write(`triage_actions: unknown subcommand ${args.cmd ?? ""}\n`);
    return 2;
  }
  if (args.issue === undefined || Number.isNaN(args.issue)) {
    process.stderr.write("triage_actions: argument --issue: expected one argument\n");
    return 2;
  }
  if (args.repo === undefined) {
    process.stderr.write("triage_actions: argument --repo: expected one argument\n");
    return 2;
  }
  if (args.cmd === "reject" && args.reason === undefined) {
    process.stderr.write("triage_actions: argument --reason: expected one argument\n");
    return 2;
  }
  if (args.cmd === "defer" && args.reason === undefined) {
    process.stderr.write("triage_actions: argument --reason: expected one argument\n");
    return 2;
  }

  const projectRoot = resolve(args.projectRoot);
  const deps = createDefaultDeps(projectRoot);
  const n = args.issue;
  const repo = args.repo;

  try {
    if (args.cmd === "accept") {
      const decisionId = accept(n, repo, deps, { actor: args.actor, projectRoot });
      process.stdout.write(`accept #${n} (${repo}) -> ${decisionId}\n`);
    } else if (args.cmd === "reject") {
      const decisionId = reject(n, repo, args.reason ?? "", deps, {
        actor: args.actor,
        projectRoot,
      });
      process.stdout.write(`reject #${n} (${repo}) -> ${decisionId}\n`);
    } else {
      const decisionId = deferAction(n, repo, args.reason, deps, {
        actor: args.actor,
        resumeOn: args.resumeOn,
        projectRoot,
      });
      process.stdout.write(`defer #${n} (${repo}) -> ${decisionId}\n`);
    }
  } catch (err) {
    if (err instanceof TriageError || err instanceof UpstreamCloseError) {
      process.stderr.write(`triage_actions: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
