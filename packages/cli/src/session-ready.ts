#!/usr/bin/env node
/**
 * CLI: deft session:ready — one-shot mutation recovery (#2993).
 *
 * Composes session:start (when needed) + verify:session-ritual --tier=gated
 * + cache fetch-all recovery so PreToolUse gated inspect goes green in one verb.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSessionReady } from "@deftai/directive-core/session";

export interface ParsedSessionReadyArgs {
  projectRoot: string;
  emitJson: boolean;
  withNetwork: boolean;
  repo: string | null;
  error?: string;
}

/** Parse session:ready CLI args. */
export function parseArgs(argv: readonly string[]): ParsedSessionReadyArgs {
  const parsed: ParsedSessionReadyArgs = {
    projectRoot: ".",
    emitJson: false,
    withNetwork: false,
    repo: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--") continue;
    if (arg === "--json") {
      parsed.emitJson = true;
      continue;
    }
    if (arg === "--with-network") {
      parsed.withNetwork = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return {
        ...parsed,
        error:
          "usage: session:ready [--project-root <path>] [--repo OWNER/NAME] [--with-network] [--json]\n" +
          "  One-shot recovery: session:start (if needed) + gated ritual + cache recovery (#2993).",
      };
    }
    if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
      parsed.projectRoot = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
      continue;
    }
    if (arg === "--repo") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --repo: expected one argument" };
      }
      parsed.repo = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--repo=")) {
      parsed.repo = arg.slice("--repo=".length);
      continue;
    }
    if (arg.startsWith("-")) {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    }
    return { ...parsed, error: `unexpected argument: ${arg}` };
  }
  return parsed;
}

/** Native session:ready handler (#2993). */
export function run(argv: readonly string[] = process.argv.slice(2)): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`session_ready: ${args.error}\n`);
    return 2;
  }

  const projectRoot = resolve(args.projectRoot);
  const result = runSessionReady(projectRoot, {
    repo: args.repo,
    sessionStartOptions: {
      allowOptionalNetwork: args.withNetwork ? true : undefined,
      writeHistory: false,
    },
  });

  if (args.emitJson) {
    process.stdout.write(
      `${JSON.stringify({
        ready: result.code === 0,
        exit_code: result.code,
        path: result.path,
        message: result.message,
        steps: result.steps,
        duration_ms: result.duration_ms,
      })}\n`,
    );
    return result.code;
  }

  const sink = result.code === 0 ? process.stdout : process.stderr;
  // Prefer the canonical single success/failure line; keep intermediate lines
  // only when they add recovery context (start output / cache progress).
  const intermediates = result.lines.filter((line) => line !== result.message);
  for (const line of intermediates) {
    sink.write(`${line}\n`);
  }
  sink.write(`${result.message}\n`);
  return result.code;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
