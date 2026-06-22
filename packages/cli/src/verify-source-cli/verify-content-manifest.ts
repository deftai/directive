#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateContentManifest } from "@deftai/core/verify-source";

interface ParsedArgs {
  manifestPath: string | null;
  projectRoot: string | null;
  error?: string;
}

/** Parse verify-content-manifest CLI args (#1821). */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { manifestPath: null, projectRoot: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--manifest") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --manifest: expected one argument" };
      }
      parsed.manifestPath = value;
      i += 1;
    } else if (arg?.startsWith("--manifest=")) {
      parsed.manifestPath = arg.slice("--manifest=".length);
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
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

/** Run the gate and return the process exit code. */
export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`verify_content_manifest: ${args.error}\n`);
    return 2;
  }
  const root = resolve(args.projectRoot ?? ".");
  const result = evaluateContentManifest(root, {
    root,
    manifestPath: args.manifestPath !== null ? resolve(args.manifestPath) : undefined,
  });
  if (result.stream === "stdout") {
    process.stdout.write(`${result.message}\n`);
  } else {
    process.stderr.write(`${result.message}\n`);
  }
  return result.code;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
