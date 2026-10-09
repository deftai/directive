#!/usr/bin/env node
/**
 * preflight-gh.ts -- CLI for the destructive-gh-verb gate (#1019).
 *
 * Usage:
 *   deft-ts preflight-gh --self-test
 *   deft-ts preflight-gh --command "<gh ...>"
 *   deft-ts preflight-gh --pre-push-stdin  (reads from stdin)
 *
 * Thin shim -- delegates through @deftai/directive-core/preflight
 * (re-exports the preflight-gh API; vitest already aliases that subpath).
 * --project-root is consulted by evaluatePrePush / evaluateCommand (#4384).
 */
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { resolveDeliveryBranch } from "@deftai/directive-core/policy";
import {
  DEFAULT_BRANCHES,
  evaluateCommand,
  evaluatePrePush,
  parsePrePushStdin,
  runSelfTest,
} from "@deftai/directive-core/preflight";

interface ParsedArgs {
  mode?: "self-test" | "command" | "pre-push-stdin";
  command?: string;
  defaultBranches?: Set<string>;
  projectRoot?: string;
  quiet?: boolean;
  error?: string;
}

/** Typed-only deliveryBranch union for CLI-seeded DEFAULT_BRANCHES (#5520). */
export function enrichBranchesWithTypedDelivery(
  projectRoot: string | undefined,
  branches: ReadonlySet<string>,
): Set<string> {
  const next = new Set(branches);
  if (projectRoot === undefined || projectRoot.length === 0) return next;
  const delivery = resolveDeliveryBranch(projectRoot);
  if (delivery.source === "typed" && delivery.error === null && delivery.branch.trim().length > 0) {
    next.add(delivery.branch);
  }
  return next;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { defaultBranches: new Set(DEFAULT_BRANCHES) };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--self-test") {
      parsed.mode = "self-test";
    } else if (arg === "--pre-push-stdin") {
      parsed.mode = "pre-push-stdin";
    } else if (arg === "--command") {
      const next = argv[i + 1];
      if (next === undefined) {
        return { ...parsed, error: "argument --command: expected one argument" };
      }
      parsed.mode = "command";
      parsed.command = next;
      i++;
    } else if (arg === "--quiet") {
      parsed.quiet = true;
    } else if (arg === "--default-branch") {
      const next = argv[i + 1];
      if (next === undefined) {
        return { ...parsed, error: "argument --default-branch: expected one argument" };
      }
      parsed.defaultBranches ??= new Set();
      parsed.defaultBranches.add(next);
      i++;
    } else if (arg === "--project-root") {
      const next = argv[i + 1];
      if (next === undefined) {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
      parsed.projectRoot = next;
      i++;
    } else {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    }
  }
  return parsed;
}

export function run(argv: string[]): number | Promise<number> {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`preflight-gh: ${args.error}\n`);
    return 2;
  }

  const quiet = args.quiet ?? false;
  // CLI seeds DEFAULT_BRANCHES; union typed delivery when --project-root is set (#5520).
  const branches = enrichBranchesWithTypedDelivery(
    args.projectRoot,
    args.defaultBranches ?? new Set(DEFAULT_BRANCHES),
  );

  if (args.mode === "self-test") {
    const [code, msg] = runSelfTest();
    if (code === 0) {
      if (!quiet) process.stdout.write(`${msg}\n`);
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return code;
  }

  if (args.mode === "command" && args.command !== undefined) {
    const [code, msg] = evaluateCommand(args.command, branches, {
      projectRoot: args.projectRoot,
    });
    if (code === 0) {
      if (!quiet) process.stdout.write(`${msg}\n`);
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return code;
  }

  if (args.mode === "pre-push-stdin") {
    return runPrePushStdin(branches, quiet, args.projectRoot);
  }

  process.stderr.write(
    "preflight-gh: one of --self-test / --command / --pre-push-stdin required\n",
  );
  return 2;
}

function runPrePushStdin(
  branches: ReadonlySet<string>,
  quiet: boolean,
  projectRoot: string | undefined,
): Promise<number> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (l) => lines.push(l));
    rl.on("close", () => {
      const refs = parsePrePushStdin(lines.join("\n"));
      const [code, msg] = evaluatePrePush(refs, { branches, projectRoot });
      if (code === 0) {
        if (!quiet) process.stdout.write(`${msg}\n`);
      } else {
        process.stderr.write(`${msg}\n`);
      }
      resolve(code);
    });
  });
}

/* v8 ignore start -- entry guard */
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = run(process.argv.slice(2));
  if (result instanceof Promise) {
    result.then((code) => process.exit(code)).catch(() => process.exit(2));
  } else {
    process.exit(result);
  }
}
/* v8 ignore stop */
