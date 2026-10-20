#!/usr/bin/env node
/**
 * agents:refresh — rewrite AGENTS.md managed section from the canonical template (#768 / #1996).
 * #3286: when the managed section is already current, print one-line
 * "unchanged - sha match" (content-based; always plans against the live AGENTS.md).
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyAgentsRefresh } from "@deftai/directive-core/platform";
import { formatDepositShaMatchLine } from "@deftai/directive-core/session";

export interface AgentsRefreshArgs {
  projectRoot: string;
  check: boolean;
  dryRun: boolean;
  error?: string;
}

export function parseAgentsRefreshArgs(argv: readonly string[]): AgentsRefreshArgs {
  let projectRoot = process.cwd();
  let check = false;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--check") {
      check = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--project-root") {
      const next = argv[i + 1];
      if (next === undefined) {
        return { projectRoot, check, dryRun, error: "missing --project-root value" };
      }
      projectRoot = next;
      i += 1;
    } else if (arg.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else {
      return { projectRoot, check, dryRun, error: `unrecognized argument: ${arg}` };
    }
  }
  return { projectRoot: resolve(projectRoot), check, dryRun };
}

export function runAgentsRefresh(argv: readonly string[]): number {
  const args = parseAgentsRefreshArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`agents:refresh: ${args.error}\n`);
    return 2;
  }

  // Always plan against live AGENTS.md (#3286 Greptile P1: deposit fingerprint
  // alone cannot detect local managed-section edits). Content-current → one-line
  // sha-match phrasing for harness parsers.
  // The read->compute->write is serialized behind an advisory lock and written
  // atomically inside applyAgentsRefresh, so concurrent refreshers cannot clobber
  // one another's session= write or observe a partial write (#1329).
  const { state, path, writable } = applyAgentsRefresh(args.projectRoot, {
    check: args.check,
    dryRun: args.dryRun,
  });

  if (args.check) {
    if (state === "current") return 0;
    process.stderr.write(`agents:refresh --check: AGENTS.md state is ${state}\n`);
    return 1;
  }

  if (state === "current") {
    // #3286: one-line no-op phrasing when managed section already matches template.
    process.stdout.write(`${formatDepositShaMatchLine("agents:refresh")}\n`);
    return 0;
  }

  if (state === "template-missing" || state === "template-malformed" || state === "unreadable") {
    process.stderr.write(`agents:refresh failed: ${state}\n`);
    return 2;
  }

  if (!writable) {
    process.stderr.write("agents:refresh failed: plan produced no new_content\n");
    return 2;
  }

  if (args.dryRun) {
    process.stdout.write(`[dry-run] would write ${path} (state=${state})\n`);
    return 0;
  }

  process.stdout.write(`AGENTS.md updated (state=${state}).\n`);
  return 0;
}

export function run(argv: readonly string[]): number {
  return runAgentsRefresh(argv);
}

/* v8 ignore start -- entry guard */
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
/* v8 ignore stop */
