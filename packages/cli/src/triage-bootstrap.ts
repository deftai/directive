#!/usr/bin/env node
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ParsedArgs {
  projectRoot: string;
  repo: string | null;
  limit?: number;
  state?: string;
  labels: string[];
  author?: string;
  batchSize?: number;
  delayMs?: number;
  fetchTimeoutS: number;
  quiet: boolean;
  emitJson: boolean;
  error?: string;
}

type BootstrapModule = typeof import("@deftai/directive-core/dist/triage/bootstrap/index.js");

async function loadBootstrapModule(): Promise<BootstrapModule> {
  // Direct dynamic import of the published package subpath -- resolves via core's
  // "./dist/*.js" export map in both the monorepo and a flat npm install (#1993).
  // The prior hand-built relative path broke once published (and my mechanical
  // import rewrite turned it into a non-existent path under packages/cli/dist).
  return import(
    "@deftai/directive-core/dist/triage/bootstrap/index.js"
  ) as Promise<BootstrapModule>;
}

/** Parse triage-bootstrap CLI args, mirroring the Python argparse surface. */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    projectRoot: process.env.DEFT_PROJECT_ROOT ?? ".",
    repo: process.env.DEFT_TRIAGE_REPO ?? null,
    labels: [],
    fetchTimeoutS: Number.NaN,
    quiet: false,
    emitJson: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--quiet") {
      parsed.quiet = true;
    } else if (arg === "--json") {
      parsed.emitJson = true;
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
      parsed.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--repo") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --repo: expected one argument" };
      }
      parsed.repo = value;
      i += 1;
    } else if (arg?.startsWith("--repo=")) {
      parsed.repo = arg.slice("--repo=".length);
    } else if (arg === "--limit") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --limit: expected one argument" };
      }
      parsed.limit = Number.parseInt(value, 10);
      i += 1;
    } else if (arg === "--state") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --state: expected one argument" };
      }
      if (value !== "open" && value !== "closed" && value !== "all") {
        return {
          ...parsed,
          error: `invalid choice: '${value}' (choose from 'open', 'closed', 'all')`,
        };
      }
      parsed.state = value;
      i += 1;
    } else if (arg === "--label") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --label: expected one argument" };
      }
      parsed.labels.push(value);
      i += 1;
    } else if (arg === "--author") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --author: expected one argument" };
      }
      parsed.author = value;
      i += 1;
    } else if (arg === "--batch-size") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --batch-size: expected one argument" };
      }
      parsed.batchSize = Number.parseInt(value, 10);
      i += 1;
    } else if (arg === "--delay-ms") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --delay-ms: expected one argument" };
      }
      parsed.delayMs = Number.parseInt(value, 10);
      i += 1;
    } else if (arg === "--fetch-timeout-s") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --fetch-timeout-s: expected one argument" };
      }
      parsed.fetchTimeoutS = Number.parseFloat(value);
      i += 1;
    } else {
      return { ...parsed, error: `unrecognized arguments: ${arg}` };
    }
  }

  return parsed;
}

/** Run triage:bootstrap with an injected core module (test seam). */
export async function runWithModule(mod: BootstrapModule, argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`triage_bootstrap: ${args.error}\n`);
    return 2;
  }

  const fetchTimeoutS = Number.isNaN(args.fetchTimeoutS)
    ? mod.defaultFetchTimeoutFromEnv()
    : args.fetchTimeoutS;

  const projectRoot = resolve(args.projectRoot);
  let isDir = false;
  try {
    isDir = statSync(projectRoot).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    process.stderr.write(
      `❌ triage:bootstrap: --project-root ${projectRoot} does not exist or is not a directory.\n`,
    );
    return 2;
  }

  const labels = mod.normaliseLabelFilter(args.labels);
  const result = await mod.runBootstrap(projectRoot, args.repo, {
    batchSize: args.batchSize,
    delayMs: args.delayMs,
    state: args.state,
    limit: args.limit,
    labels,
    author: args.author,
    fetchTimeoutS,
    progress: args.quiet ? null : mod.PROGRESS_DEFAULT,
  });

  if (args.emitJson) {
    process.stdout.write(`${mod.formatJson(result)}\n`);
  } else {
    process.stdout.write(`${mod.formatSummary(result)}\n`);
  }

  return result.exitCode;
}

/** Run triage:bootstrap and return the process exit code. */
export async function run(argv: string[]): Promise<number> {
  return runWithModule(await loadBootstrapModule(), argv);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  run(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((err: unknown) => {
      process.stderr.write(`triage_bootstrap: ${String(err)}\n`);
      process.exit(2);
    });
}
