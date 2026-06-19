#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { interceptHelp } from "../../core/dist/triage/help/index.js";
import { RECONCILE_HINT, subscribe, unsubscribe } from "../../core/dist/triage/subscribe/index.js";

interface ParsedArgs {
  op: string;
  projectRoot: string;
  label: string | null;
  milestone: string | null;
  issue: number | null;
  issueNote: string;
  actor: string | null;
  error?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    op: "",
    projectRoot: process.env.DEFT_PROJECT_ROOT ?? ".",
    label: null,
    milestone: null,
    issue: null,
    issueNote: "added via task triage:subscribe",
    actor: null,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
      parsed.projectRoot = value;
      i += 1;
    } else if (arg.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--label") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --label: expected one argument" };
      }
      parsed.label = value;
      i += 1;
    } else if (arg.startsWith("--label=")) {
      parsed.label = arg.slice("--label=".length);
    } else if (arg === "--milestone") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --milestone: expected one argument" };
      }
      parsed.milestone = value;
      i += 1;
    } else if (arg.startsWith("--milestone=")) {
      parsed.milestone = arg.slice("--milestone=".length);
    } else if (arg === "--issue") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --issue: expected one argument" };
      }
      parsed.issue = Number.parseInt(value, 10);
      i += 1;
    } else if (arg.startsWith("--issue=")) {
      parsed.issue = Number.parseInt(arg.slice("--issue=".length), 10);
    } else if (arg === "--issue-note") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --issue-note: expected one argument" };
      }
      parsed.issueNote = value;
      i += 1;
    } else if (arg.startsWith("--issue-note=")) {
      parsed.issueNote = arg.slice("--issue-note=".length);
    } else if (arg === "--actor") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --actor: expected one argument" };
      }
      parsed.actor = value;
      i += 1;
    } else if (arg.startsWith("--actor=")) {
      parsed.actor = arg.slice("--actor=".length);
    } else if (arg.startsWith("-")) {
      return { ...parsed, error: `unrecognized arguments: ${arg}` };
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 0 && positional[0] !== undefined) {
    parsed.op = positional[0];
  }
  return parsed;
}

export function run(argv: string[]): number {
  const helpRc = interceptHelp("triage_subscribe", argv);
  if (helpRc !== null) {
    return helpRc;
  }

  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`${args.error}\n`);
    return 2;
  }
  if (args.op !== "subscribe" && args.op !== "unsubscribe") {
    process.stderr.write(
      "triage:subscribe: first positional arg must be 'subscribe' or " +
        "'unsubscribe'; e.g. task triage:subscribe -- --label=bug\n",
    );
    return 2;
  }

  const projectRoot = resolve(args.projectRoot);
  if (!existsSync(projectRoot) || !statSync(projectRoot).isDirectory()) {
    process.stderr.write(
      `triage:${args.op}: --project-root ${projectRoot} does not exist ` +
        "or is not a directory.\n",
    );
    return 2;
  }

  const chosen = [args.label, args.milestone, args.issue].filter((v) => v !== null).length;
  if (chosen !== 1) {
    process.stderr.write(
      `triage:${args.op}: exactly one of --label / --milestone / --issue is required.\n`,
    );
    return 2;
  }

  try {
    const [changed, message] =
      args.op === "subscribe"
        ? subscribe(projectRoot, {
            label: args.label,
            milestone: args.milestone,
            issue: args.issue,
            issueNote: args.issueNote,
            actor: args.actor,
          })
        : unsubscribe(projectRoot, {
            label: args.label,
            milestone: args.milestone,
            issue: args.issue,
            actor: args.actor,
          });

    if (!changed) {
      process.stderr.write(`triage:${args.op}: ${message} (no-op).\n`);
      return 0;
    }
    process.stdout.write(`triage:${args.op}: ${message}.\n`);
    process.stderr.write(`${RECONCILE_HINT}\n`);
    return 0;
  } catch (exc: unknown) {
    process.stderr.write(`triage:${args.op}: ${String(exc)}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
