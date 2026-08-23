#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CONCURRENCY,
  EvaluateError,
  evaluateIssues,
  renderEvaluateText,
} from "@deftai/directive-core/dist/triage/evaluate/index.js";
import { interceptHelp } from "@deftai/directive-core/dist/triage/help/index.js";
import { resolveRepo } from "@deftai/directive-core/dist/triage/queue/repo.js";

interface Parsed {
  projectRoot: string;
  repo: string | null;
  issues: number[];
  concurrency: number;
  json: boolean;
  error?: string;
}

export function parseArgs(argv: string[]): Parsed {
  const parsed: Parsed = {
    projectRoot: process.env.DEFT_PROJECT_ROOT ?? process.cwd(),
    repo: process.env.DEFT_TRIAGE_REPO ?? null,
    issues: [],
    concurrency: DEFAULT_CONCURRENCY,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined || arg === "--") {
      continue;
    }
    if (arg === "--project-root") {
      const value = argv[++i];
      if (value === undefined) {
        return { ...parsed, error: "--project-root requires a path" };
      }
      parsed.projectRoot = value;
    } else if (arg.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--repo") {
      const value = argv[++i];
      if (value === undefined) {
        return { ...parsed, error: "--repo requires owner/name" };
      }
      parsed.repo = value;
    } else if (arg.startsWith("--repo=")) {
      parsed.repo = arg.slice("--repo=".length);
    } else if (arg === "--issue") {
      const value = argv[++i];
      if (value === undefined) {
        return { ...parsed, error: "--issue requires a number" };
      }
      const n = Number.parseInt(value, 10);
      if (!Number.isInteger(n) || n < 1) {
        return { ...parsed, error: `--issue invalid: ${value}` };
      }
      parsed.issues.push(n);
    } else if (arg.startsWith("--issue=")) {
      const n = Number.parseInt(arg.slice("--issue=".length), 10);
      if (!Number.isInteger(n) || n < 1) {
        return { ...parsed, error: `--issue invalid: ${arg}` };
      }
      parsed.issues.push(n);
    } else if (arg === "--concurrency") {
      const value = argv[++i];
      if (value === undefined) {
        return { ...parsed, error: "--concurrency requires a positive integer" };
      }
      const n = Number.parseInt(value, 10);
      if (!Number.isInteger(n) || n < 1) {
        return { ...parsed, error: `--concurrency invalid: ${value}` };
      }
      parsed.concurrency = n;
    } else if (arg.startsWith("--concurrency=")) {
      const n = Number.parseInt(arg.slice("--concurrency=".length), 10);
      if (!Number.isInteger(n) || n < 1) {
        return { ...parsed, error: `--concurrency invalid: ${arg}` };
      }
      parsed.concurrency = n;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg.startsWith("-")) {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    } else {
      const n = Number.parseInt(arg.replace(/^#/u, ""), 10);
      if (!Number.isInteger(n) || n < 1) {
        return { ...parsed, error: `invalid issue number: ${arg}` };
      }
      parsed.issues.push(n);
    }
  }
  return parsed;
}

export async function run(argv: string[]): Promise<number> {
  const help = interceptHelp("triage_evaluate", argv);
  if (help !== null) {
    return help;
  }
  const parsed = parseArgs(argv);
  if (parsed.error !== undefined) {
    process.stderr.write(`triage:evaluate: ${parsed.error}\n`);
    return 2;
  }
  const projectRoot = resolve(parsed.projectRoot);
  const repo = resolveRepo(parsed.repo, projectRoot);
  if (repo === null) {
    process.stderr.write("triage:evaluate: --repo owner/name is required\n");
    return 2;
  }
  try {
    const result = await evaluateIssues({
      projectRoot,
      repo,
      issues: parsed.issues,
      concurrency: parsed.concurrency,
    });
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(renderEvaluateText(result));
    }
    return result.verdicts.some((v) => v.error !== null) ? 1 : 0;
  } catch (err: unknown) {
    const message = err instanceof EvaluateError ? err.message : String(err);
    process.stderr.write(`triage:evaluate: ${message}\n`);
    return err instanceof EvaluateError ? 2 : 1;
  }
}

export async function main(argv: string[]): Promise<number> {
  return run(argv);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  void run(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
