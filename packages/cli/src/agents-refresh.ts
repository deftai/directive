#!/usr/bin/env node
/**
 * agents:refresh — rewrite AGENTS.md managed section from the canonical template (#768 / #1996).
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentsRefreshPlan } from "@deftai/directive-core/platform";

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

  const plan = agentsRefreshPlan(args.projectRoot) as Record<string, unknown>;
  const state = String(plan.state ?? "unknown");

  if (args.check) {
    if (state === "current") return 0;
    process.stderr.write(`agents:refresh --check: AGENTS.md state is ${state}\n`);
    return 1;
  }

  if (state === "current") {
    process.stdout.write("AGENTS.md managed section is current — no changes.\n");
    return 0;
  }

  if (state === "template-missing" || state === "template-malformed" || state === "unreadable") {
    process.stderr.write(`agents:refresh failed: ${state}\n`);
    return 2;
  }

  const newContent = plan.new_content;
  if (typeof newContent !== "string") {
    process.stderr.write("agents:refresh failed: plan produced no new_content\n");
    return 2;
  }

  const path = String(plan.path ?? resolve(args.projectRoot, "AGENTS.md"));
  if (args.dryRun) {
    process.stdout.write(`[dry-run] would write ${path} (state=${state})\n`);
    return 0;
  }

  writeFileSync(path, newContent, "utf8");
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
