#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gitPorcelain } from "../../core/dist/story-ready/git.js";
import { evaluate, parseAllocationSection } from "../../core/dist/story-ready/index.js";

interface ParsedArgs {
  vbriefPath: string | null;
  projectRoot: string;
  allocationContext: string | null;
  allowDirty: boolean;
  emitJson: boolean;
  help?: boolean;
  error?: string;
}

/** Parse verify-story-ready CLI args, mirroring the Python argparse surface. */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    vbriefPath: null,
    projectRoot: ".",
    allocationContext: null,
    allowDirty: false,
    emitJson: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--allow-dirty") {
      parsed.allowDirty = true;
    } else if (arg === "--json") {
      parsed.emitJson = true;
    } else if (arg === "--vbrief-path") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --vbrief-path: expected one argument" };
      }
      parsed.vbriefPath = value;
      i += 1;
    } else if (arg?.startsWith("--vbrief-path=")) {
      parsed.vbriefPath = arg.slice("--vbrief-path=".length);
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
      parsed.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--allocation-context") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --allocation-context: expected one argument" };
      }
      parsed.allocationContext = value;
      i += 1;
    } else if (arg?.startsWith("--allocation-context=")) {
      parsed.allocationContext = arg.slice("--allocation-context=".length);
    } else if (arg === "--help" || arg === "-h") {
      return { ...parsed, help: true };
    } else {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    }
  }

  if (parsed.vbriefPath === null) {
    return { ...parsed, error: "argument --vbrief-path is required" };
  }
  return parsed;
}

const HELP_TEXT = `usage: verify-story-ready [--vbrief-path PATH] [--project-root PATH]
                          [--allocation-context PATH] [--allow-dirty] [--json]

Deterministic story-start Gate 0 (#1378). Three-state exit: 0 ready / 1 not ready / 2 config error.
`;

function emitJson(
  vbriefPath: string,
  exitCode: number,
  message: string,
  dispatchKind: string | null,
): string {
  const payload: Record<string, unknown> = {
    dispatch_kind: dispatchKind,
    exit_code: exitCode,
    message,
    ready: exitCode === 0,
    vbrief_path: vbriefPath,
  };
  const sorted = Object.fromEntries(
    Object.keys(payload)
      .sort()
      .map((k) => [k, payload[k]]),
  );
  return JSON.stringify(sorted);
}

/** Run the gate and return the process exit code. */
export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  if (args.error !== undefined) {
    process.stderr.write(`verify_story_ready: ${args.error}\n`);
    return 2;
  }

  const vbriefPath = resolve(args.vbriefPath as string);
  const projectRoot = resolve(args.projectRoot);

  let allocationContextText: string | null = null;
  if (args.allocationContext !== null) {
    const envelopePath = resolve(args.allocationContext);
    try {
      allocationContextText = readFileSync(envelopePath, "utf8");
    } catch (err: unknown) {
      const message = `config error: could not read --allocation-context file ${envelopePath}: ${String((err as Error).message ?? err)}.`;
      if (args.emitJson) {
        process.stdout.write(`${emitJson(vbriefPath, 2, message, null)}\n`);
      } else {
        process.stderr.write(`${message}\n`);
      }
      return 2;
    }
  }

  const gitStatus = gitPorcelain(projectRoot);
  const parsed = parseAllocationSection(allocationContextText);
  const result = evaluate(vbriefPath, {
    gitStatus,
    allocationContext: allocationContextText,
    allowDirty: args.allowDirty,
    parsed,
  });

  if (args.emitJson) {
    process.stdout.write(
      `${emitJson(vbriefPath, result.exitCode, result.message, result.dispatchKind)}\n`,
    );
  } else if (result.exitCode === 0) {
    process.stdout.write(`${result.message}\n`);
  } else {
    process.stderr.write(`${result.message}\n`);
  }

  return result.exitCode;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
