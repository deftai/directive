#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
/**
 * CLI for verify:completed-write-guard (#3679).
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateCompletedWriteGuard } from "@deftai/directive-core/lifecycle";

interface ParsedArgs {
  projectRoot: string;
  baseRef: string;
  quiet: boolean;
  /** PR body file for the lands-with-product keyword check (#6277). */
  prBodyFile: string;
  error?: string;
}

/** Parse verify-completed-write-guard CLI args (#3679). */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    projectRoot: ".",
    baseRef: "",
    quiet: false,
    prBodyFile: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--quiet") {
      parsed.quiet = true;
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
      parsed.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--base-ref") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --base-ref: expected one argument" };
      }
      parsed.baseRef = value;
      i += 1;
    } else if (arg?.startsWith("--base-ref=")) {
      parsed.baseRef = arg.slice("--base-ref=".length);
    } else if (arg === "--pr-body-file") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --pr-body-file: expected one argument" };
      }
      parsed.prBodyFile = value;
      i += 1;
    } else if (arg?.startsWith("--pr-body-file=")) {
      parsed.prBodyFile = arg.slice("--pr-body-file=".length);
    } else {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    }
  }
  return parsed;
}

const PULL_REQUEST_EVENTS = new Set(["pull_request", "pull_request_target"]);

/**
 * PR body for the lands-with-product keyword check (#6277): `--pr-body-file`,
 * else the pull_request event payload in CI. `undefined` outside a PR context
 * (local run, merge queue); an error when a PR event payload cannot be read.
 */
export function resolvePrBody(
  prBodyFile: string,
  env: NodeJS.ProcessEnv = process.env,
): { body: string | undefined } | { error: string } {
  if (prBodyFile.length > 0) {
    try {
      return { body: readFileSync(prBodyFile, "utf8") };
    } catch (err: unknown) {
      return { error: `cannot read --pr-body-file ${prBodyFile}: ${String(err)}` };
    }
  }
  const eventName = env.GITHUB_EVENT_NAME ?? "";
  const eventPath = env.GITHUB_EVENT_PATH ?? "";
  if (!PULL_REQUEST_EVENTS.has(eventName)) {
    return { body: undefined };
  }
  if (eventPath.length === 0 || !existsSync(eventPath)) {
    return { error: `${eventName} event payload is missing (GITHUB_EVENT_PATH)` };
  }
  try {
    const event = JSON.parse(readFileSync(eventPath, "utf8")) as {
      pull_request?: { body?: unknown };
    };
    const body = event.pull_request?.body;
    return { body: typeof body === "string" ? body : "" };
  } catch (err: unknown) {
    return { error: `cannot read the ${eventName} event payload: ${String(err)}` };
  }
}

/** Run the gate and return the process exit code. */
export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`verify_completed_write_guard: ${args.error}\n`);
    return 2;
  }
  const prBody = resolvePrBody(args.prBodyFile);
  if ("error" in prBody) {
    process.stderr.write(`verify_completed_write_guard: ${prBody.error}\n`);
    return 2;
  }
  const projectRoot = resolve(args.projectRoot);
  const result = evaluateCompletedWriteGuard(projectRoot, {
    ...(args.baseRef.length > 0 ? { baseRef: args.baseRef } : {}),
    ...(prBody.body !== undefined ? { prBody: prBody.body } : {}),
    runGh: (command) => {
      const proc = spawnSync(command[0] ?? "gh", command.slice(1), {
        cwd: projectRoot,
        encoding: "utf8",
        timeout: 15_000,
      });
      return {
        returncode: proc.status ?? 1,
        stdout: proc.stdout ?? "",
      };
    },
  });
  if (result.message.length > 0 && !args.quiet) {
    if (result.code === 0) {
      process.stdout.write(`${result.message}\n`);
    } else {
      process.stderr.write(`${result.message}\n`);
    }
  }
  return result.code;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
