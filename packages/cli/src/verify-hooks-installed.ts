#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentHookHealthResult,
  type AgentHookReadinessResult,
  type EvaluateResult,
  evaluate,
  evaluateAgentHookReadiness,
  evaluateAgentHookReadinessSafely,
  evaluateAgentHooks,
  formatAgentHookRepairDisposition,
  repairAgentHookRegistrations,
} from "@deftai/directive-core/verify-env";

type HookScope = "git" | "agent" | "all";

interface ParsedArgs {
  projectRoot: string;
  quiet: boolean;
  scope: HookScope;
  live: boolean;
  repair: boolean;
  error?: string;
}

export interface VerifyHooksInstalledCliSeams {
  readonly evaluateGit?: (projectRoot: string) => EvaluateResult;
  readonly evaluateAgent?: (projectRoot: string) => AgentHookHealthResult;
  readonly evaluateReadiness?: (projectRoot: string) => AgentHookReadinessResult;
  readonly repairRegistrations?: typeof repairAgentHookRegistrations;
  readonly writeOut?: (text: string) => void;
  readonly writeErr?: (text: string) => void;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    projectRoot: ".",
    quiet: false,
    scope: "git",
    live: false,
    repair: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--quiet") parsed.quiet = true;
    else if (arg === "--live") parsed.live = true;
    else if (arg === "--repair") parsed.repair = true;
    else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
      parsed.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--scope") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --scope: expected one argument" };
      }
      if (value !== "git" && value !== "agent" && value !== "all") {
        return { ...parsed, error: `argument --scope: invalid choice: '${value}'` };
      }
      parsed.scope = value;
      i += 1;
    } else if (arg?.startsWith("--scope=")) {
      const value = arg.slice("--scope=".length);
      if (value !== "git" && value !== "agent" && value !== "all") {
        return { ...parsed, error: `argument --scope: invalid choice: '${value}'` };
      }
      parsed.scope = value;
    } else {
      return { ...parsed, error: `unrecognized arguments: ${arg}` };
    }
  }
  if (parsed.live && parsed.scope === "git") {
    return { ...parsed, error: "argument --live requires --scope=agent or --scope=all" };
  }
  if (parsed.repair && parsed.scope === "git") {
    return { ...parsed, error: "argument --repair requires --scope=agent or --scope=all" };
  }
  return parsed;
}

/** Verify git hooks, structural agent hooks, or functional agent-hook readiness. */
export function run(argv: string[], seams: VerifyHooksInstalledCliSeams = {}): number {
  const args = parseArgs(argv);
  const writeOut = seams.writeOut ?? ((text: string) => process.stdout.write(text));
  const writeErr = seams.writeErr ?? ((text: string) => process.stderr.write(text));
  if (args.error !== undefined) {
    writeErr(`${args.error}\n`);
    return 2;
  }
  const projectRoot = resolve(args.projectRoot);
  const evaluateGit = seams.evaluateGit ?? evaluate;
  const evaluateAgent = seams.evaluateAgent ?? evaluateAgentHooks;
  const evaluateReadiness = seams.evaluateReadiness
    ? (root: string) => evaluateAgentHookReadinessSafely(root, seams.evaluateReadiness)
    : evaluateAgentHookReadinessSafely;
  if (args.repair) {
    const repair = seams.repairRegistrations ?? repairAgentHookRegistrations;
    try {
      let live: AgentHookReadinessResult | undefined;
      const evaluateRepairReadiness = seams.evaluateReadiness
        ? (root: string) => evaluateAgentHookReadinessSafely(root, seams.evaluateReadiness)
        : (root: string) =>
            evaluateAgentHookReadinessSafely(root, (next) =>
              evaluateAgentHookReadiness(next, { consumerContext: () => true }),
            );
      const repaired = repair(projectRoot, {
        reevaluate: (root) => {
          live = evaluateRepairReadiness(root);
          return live;
        },
      });
      if (live === undefined) {
        writeErr("agent hook repair refused: live recheck did not run\n");
        return 2;
      }
      if (!args.quiet) {
        writeOut(`${formatAgentHookRepairDisposition(repaired.written)}\n`);
        if (live.stream === "stdout") writeOut(`${live.message}\n`);
        else writeErr(`${live.message}\n`);
      }
      const gitResults = args.scope === "all" ? [evaluateGit(projectRoot)] : [];
      if (!args.quiet) {
        for (const result of gitResults) {
          if (result.stream === "stdout") writeOut(`${result.message}\n`);
          else if (result.stream === "stderr") writeErr(`${result.message}\n`);
        }
      }
      const gitCode =
        gitResults.length > 0 ? Math.max(...gitResults.map((result) => result.code)) : 0;
      return Math.max(repaired.after.code, gitCode);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      writeErr(`agent hook repair refused: ${detail}\n`);
      return 2;
    }
  }
  const results = [
    ...(args.scope === "git" || args.scope === "all" ? [evaluateGit(projectRoot)] : []),
    ...(args.scope === "agent" || args.scope === "all"
      ? [args.live ? evaluateReadiness(projectRoot) : evaluateAgent(projectRoot)]
      : []),
  ];
  if (!args.quiet) {
    for (const result of results) {
      if (result.stream === "stdout") {
        writeOut(`${result.message}\n`);
      } else if (result.stream === "stderr") {
        writeErr(`${result.message}\n`);
      }
    }
  }
  return Math.max(...results.map((result) => result.code));
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
