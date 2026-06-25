#!/usr/bin/env node
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bulkActionWithDefaults,
  CacheEmptyError,
} from "@deftai/directive-core/dist/triage/bulk/index.js";
import { interceptHelp } from "@deftai/directive-core/dist/triage/help/index.js";

interface ParsedArgs {
  action: string;
  repo: string;
  label: string | null;
  author: string | null;
  ageDays: number | null;
  cluster: string | null;
  reason: string | null;
  reAction: boolean;
  showHelp: boolean;
  error?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    action: "",
    repo: "",
    label: null,
    author: null,
    ageDays: null,
    cluster: null,
    reason: null,
    reAction: false,
    showHelp: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--help" || arg === "-h") {
      parsed.showHelp = true;
    } else if (arg === "--re-action") {
      parsed.reAction = true;
    } else if (arg === "--repo") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --repo: expected one argument" };
      }
      parsed.repo = value;
      i += 1;
    } else if (arg.startsWith("--repo=")) {
      parsed.repo = arg.slice("--repo=".length);
    } else if (arg === "--label") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --label: expected one argument" };
      }
      parsed.label = value;
      i += 1;
    } else if (arg.startsWith("--label=")) {
      parsed.label = arg.slice("--label=".length);
    } else if (arg === "--author") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --author: expected one argument" };
      }
      parsed.author = value;
      i += 1;
    } else if (arg.startsWith("--author=")) {
      parsed.author = arg.slice("--author=".length);
    } else if (arg === "--age-days") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --age-days: expected one argument" };
      }
      parsed.ageDays = Number.parseInt(value, 10);
      i += 1;
    } else if (arg.startsWith("--age-days=")) {
      parsed.ageDays = Number.parseInt(arg.slice("--age-days=".length), 10);
    } else if (arg === "--cluster") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --cluster: expected one argument" };
      }
      parsed.cluster = value;
      i += 1;
    } else if (arg.startsWith("--cluster=")) {
      parsed.cluster = arg.slice("--cluster=".length);
    } else if (arg === "--reason") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --reason: expected one argument" };
      }
      parsed.reason = value;
      i += 1;
    } else if (arg.startsWith("--reason=")) {
      parsed.reason = arg.slice("--reason=".length);
    } else if (arg.startsWith("-")) {
      return { ...parsed, error: `unrecognized arguments: ${arg}` };
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 0 && positional[0] !== undefined) {
    parsed.action = positional[0];
  }
  return parsed;
}

export function run(argv: string[]): number {
  const helpRc = interceptHelp("triage_bulk", argv);
  if (helpRc !== null) {
    return helpRc;
  }

  const args = parseArgs(argv);
  if (args.showHelp && args.action === "") {
    return 0;
  }
  if (args.error !== undefined) {
    process.stderr.write(`${args.error}\n`);
    return 2;
  }
  if (!["accept", "reject", "defer", "needs-ac"].includes(args.action)) {
    process.stderr.write("triage_bulk: action required (accept|reject|defer|needs-ac)\n");
    return 2;
  }
  if (args.repo === "") {
    process.stderr.write("triage_bulk: --repo is required\n");
    return 2;
  }

  const projectRoot = process.cwd();
  const frameworkRoot = resolve(process.env.DEFT_ROOT ?? projectRoot);

  try {
    bulkActionWithDefaults(args.action, args.repo, {
      label: args.label,
      author: args.author,
      ageDays: args.ageDays,
      cluster: args.cluster,
      reason: args.reason,
      reAction: args.reAction,
      deftRoot: projectRoot,
      scriptsDir: join(frameworkRoot, "scripts"),
    });
  } catch (exc: unknown) {
    if (exc instanceof CacheEmptyError) {
      process.stderr.write(`${exc.message}\n`);
      return 2;
    }
    throw exc;
  }
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
