/**
 * Unified `deft-ts <verb> [args]` dispatcher (#1828 s0).
 * Routes to ported command modules in packages/cli and packages/core.
 */

import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

export type CommandHandler = (argv: string[]) => number | Promise<number>;

export interface DispatchIo {
  writeOut: (text: string) => void;
  writeErr: (text: string) => void;
}

interface CliResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

const HANDLER_KEYS = [
  "run",
  "main",
  "mainEntry",
  "launchMain",
  "completeCohortMain",
  "readinessMain",
  "verifyReviewCleanMain",
  "worktreesMain",
] as const;

/** CLI modules in packages/cli/src (excluding parity harnesses and bin/index). */
export const CLI_MODULE_VERBS = [
  "cache",
  "capacity-backfill",
  "capacity-show",
  "codebase-default-extractor",
  "codebase-map",
  "codebase-map-fresh",
  "codebase-projection-registry",
  "codebase-provider",
  "doctor",
  "parity",
  "policy",
  "pr-closing-keywords",
  "pr-merge-readiness",
  "pr-monitor",
  "pr-protected-issues",
  "pr-wait-mergeable",
  "probe-session",
  "release",
  "release-e2e",
  "release-publish",
  "release-rollback",
  "scope-lifecycle",
  "slice",
  "subagent-monitor",
  "toolchain-check",
  "triage-actions",
  "triage-bootstrap",
  "triage-bulk",
  "triage-classify",
  "triage-help",
  "triage-queue",
  "triage-reconcile",
  "triage-refresh",
  "triage-scope",
  "triage-scope-drift",
  "triage-smoketest",
  "triage-subscribe",
  "triage-summary",
  "triage-welcome",
  "vbrief-activate",
  "vbrief-build",
  "vbrief-preflight",
  "vbrief-reconcile",
  "vbrief-validate",
  "vbrief-validation",
  "verify-branch",
  "verify-encoding",
  "verify-hooks-installed",
  "verify-investigation",
  "verify-judgment-gates",
  "verify-no-task-runtime",
  "verify-story-ready",
  "verify-tools",
  "verify-wip-cap",
] as const;

/** Core-only CLI entrypoints without a packages/cli wrapper. */
export const CORE_MODULE_VERBS = [
  "scm",
  "github-auth-modes",
  "github-body",
  "issue-emit",
  "issue-ingest",
  "reconcile-issues",
  "swarm-launch",
  "swarm-complete-cohort",
  "swarm-readiness",
  "swarm-verify-review-clean",
  "swarm-worktrees",
  "framework-commands",
  "pack-render",
  "packs-slice",
  "roadmap-render",
  "code-structure-validate",
  "pack-migrate-skills",
  "pack-migrate-rules",
  "pack-migrate-strategies",
  "pack-migrate-patterns",
  "pack-migrate-swarm-spec",
  "policy-set",
] as const;

/** Task-style aliases (framework_commands / Taskfile names). */
export const VERB_ALIASES: Readonly<Record<string, string>> = {
  "verify:encoding": "verify-encoding",
  "verify:branch": "verify-branch",
  "verify:wip-cap": "verify-wip-cap",
  "verify:hooks-installed": "verify-hooks-installed",
  "verify:no-task-runtime": "verify-no-task-runtime",
  "vbrief:validate": "vbrief-validate",
  "vbrief:preflight": "vbrief-preflight",
  "vbrief:activate": "vbrief-activate",
  "verify:story-ready": "verify-story-ready",
  "verify:tools": "verify-tools",
  "verify:investigation": "verify-investigation",
  "verify:judgment-gates": "verify-judgment-gates",
  "verify:codebase-map-fresh": "codebase-map-fresh",
  "codebase:map": "codebase-map",
  "triage:welcome": "triage-welcome",
  "triage:bootstrap": "triage-bootstrap",
  "triage:summary": "triage-summary",
  "triage:queue": "triage-queue",
  "triage:scope": "triage-scope",
  "triage:accept": "triage-actions",
  "triage:status": "triage-actions",
  "session:start": "framework-commands",
  "toolchain:check": "toolchain-check",
  doctor: "doctor",
  build: "framework-commands",
};

const WRAPPER_CLI_STEMS = new Set<string>([
  "capacity-backfill",
  "capacity-show",
  "codebase-default-extractor",
  "codebase-map",
  "codebase-map-fresh",
  "codebase-projection-registry",
  "codebase-provider",
  "vbrief-activate",
  "vbrief-build",
  "vbrief-reconcile",
  "vbrief-validate",
  "vbrief-validation",
]);

function emitCliResult(result: CliResult, io: DispatchIo): number {
  if (result.stdout) io.writeOut(result.stdout);
  if (result.stderr) io.writeErr(result.stderr);
  return result.exitCode;
}

function resolveHandler(mod: Record<string, unknown>): CommandHandler | null {
  for (const key of HANDLER_KEYS) {
    const fn = mod[key];
    if (typeof fn === "function") {
      return fn as CommandHandler;
    }
  }
  return null;
}

async function loadWrapperCliHandler(stem: string, io: DispatchIo): Promise<CommandHandler> {
  switch (stem) {
    case "capacity-backfill": {
      const { runCapacityBackfillCli } = await import("@deftai/core/capacity");
      return async (argv) => emitCliResult(await runCapacityBackfillCli(argv), io);
    }
    case "capacity-show": {
      const { runCapacityShowCli } = await import("@deftai/core/capacity");
      return (argv) => emitCliResult(runCapacityShowCli(argv), io);
    }
    case "codebase-default-extractor": {
      const { runDefaultExtractorCli } = await import("@deftai/core/codebase");
      return (argv) => emitCliResult(runDefaultExtractorCli(argv), io);
    }
    case "codebase-map": {
      const { runCodebaseMapCli } = await import("@deftai/core/codebase");
      return (argv) => emitCliResult(runCodebaseMapCli(argv), io);
    }
    case "codebase-map-fresh": {
      const { runCodebaseMapFreshCli } = await import("@deftai/core/codebase");
      return (argv) => emitCliResult(runCodebaseMapFreshCli(argv), io);
    }
    case "codebase-projection-registry": {
      const { runProjectionRegistryCli } = await import("@deftai/core/codebase");
      return (argv) => emitCliResult(runProjectionRegistryCli(argv), io);
    }
    case "codebase-provider": {
      const { runProviderCli } = await import("@deftai/core/codebase");
      return (argv) => emitCliResult(runProviderCli(argv), io);
    }
    case "vbrief-activate": {
      const { run } = await import("@deftai/core/vbrief-activate");
      return run;
    }
    case "vbrief-build": {
      const { cmdVbriefBuild } = await import("@deftai/core/vbrief-build");
      return cmdVbriefBuild;
    }
    case "vbrief-reconcile": {
      const { cmdVbriefReconcile } = await import("@deftai/core/vbrief-reconcile");
      return cmdVbriefReconcile;
    }
    case "vbrief-validate": {
      const { cmdVbriefValidate } = await import("@deftai/core/vbrief-validate");
      return cmdVbriefValidate;
    }
    case "vbrief-validation": {
      const { cmdVbriefValidation } = await import("@deftai/core/vbrief-validation");
      return cmdVbriefValidation;
    }
    default:
      throw new Error(`no wrapper handler for ${stem}`);
  }
}

async function loadCliModuleHandler(stem: string, io: DispatchIo): Promise<CommandHandler> {
  if (WRAPPER_CLI_STEMS.has(stem)) {
    return loadWrapperCliHandler(stem, io);
  }
  const mod = (await import(`./${stem}.js`)) as Record<string, unknown>;
  const handler = resolveHandler(mod);
  if (handler === null) {
    throw new Error(`module ${stem} has no command handler export`);
  }
  return handler;
}

function resolveDeftRoot(): string {
  if (process.env.DEFT_ROOT !== undefined && process.env.DEFT_ROOT.length > 0) {
    return resolve(process.env.DEFT_ROOT);
  }
  return resolve(import.meta.dirname, "..", "..", "..");
}

function parseCodeStructureArgs(argv: readonly string[]): {
  projectRoot: string;
  paths: string[];
  json: boolean;
  strict: boolean;
  error?: string;
} {
  let projectRoot = ".";
  const paths: string[] = [];
  let json = false;
  let strict = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project-root") {
      const v = argv[i + 1];
      if (v === undefined)
        return { projectRoot, paths, json, strict, error: "missing --project-root value" };
      projectRoot = v;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--path") {
      const v = argv[i + 1];
      if (v === undefined)
        return { projectRoot, paths, json, strict, error: "missing --path value" };
      paths.push(v);
      i += 1;
    } else if (arg?.startsWith("--path=")) {
      paths.push(arg.slice("--path=".length));
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--strict") {
      strict = true;
    } else {
      return { projectRoot, paths, json, strict, error: `unrecognized argument: ${arg}` };
    }
  }
  return { projectRoot, paths, json, strict };
}

function loadPythonScriptHandler(scriptName: string): CommandHandler {
  return (argv) => {
    const deftRoot = resolveDeftRoot();
    try {
      execFileSync(
        "uv",
        ["--project", deftRoot, "run", "python", join(deftRoot, "scripts", scriptName), ...argv],
        {
          cwd: deftRoot,
          encoding: "utf8",
          env: { ...process.env, PYTHONUTF8: "1", DEFT_CACHE_DISABLE: "1" },
          stdio: "inherit",
        },
      );
      return 0;
    } catch (err) {
      const e = err as { status?: number };
      return typeof e.status === "number" ? e.status : 1;
    }
  };
}

async function loadCoreModuleHandler(verb: string, io: DispatchIo): Promise<CommandHandler> {
  switch (verb) {
    case "scm": {
      const { main } = await import("../../core/dist/scm/main.js");
      return (argv) => main(argv);
    }
    case "github-auth-modes": {
      const { mainEntry } = await import("../../core/dist/intake/github-auth-modes-cli.js");
      return mainEntry;
    }
    case "github-body": {
      const { mainEntry } = await import("../../core/dist/intake/github-body-cli.js");
      return mainEntry;
    }
    case "issue-emit": {
      const { mainEntry } = await import("../../core/dist/intake/issue-emit-cli.js");
      return mainEntry;
    }
    case "issue-ingest": {
      const { mainEntry } = await import("../../core/dist/intake/issue-ingest-cli.js");
      return mainEntry;
    }
    case "reconcile-issues": {
      const { mainEntry } = await import("../../core/dist/intake/reconcile-issues-cli.js");
      return mainEntry;
    }
    case "swarm-launch": {
      const { launchMain } = await import("../../core/dist/swarm/launch-cli.js");
      return launchMain;
    }
    case "swarm-complete-cohort": {
      const { completeCohortMain } = await import("../../core/dist/swarm/complete-cohort-cli.js");
      return completeCohortMain;
    }
    case "swarm-readiness": {
      const { readinessMain } = await import("../../core/dist/swarm/readiness-cli.js");
      return readinessMain;
    }
    case "swarm-verify-review-clean": {
      const { verifyReviewCleanMain } = await import(
        "../../core/dist/swarm/verify-review-clean-cli.js"
      );
      return verifyReviewCleanMain;
    }
    case "swarm-worktrees": {
      const { worktreesMain } = await import("../../core/dist/swarm/worktrees-cli.js");
      return worktreesMain;
    }
    case "framework-commands": {
      const { frameworkCommandsMain } = await import("@deftai/core/render");
      return (argv) => frameworkCommandsMain(argv);
    }
    case "pack-render": {
      const { main } = await import("../../core/dist/packs/pack-render.js");
      return (argv) => main([...argv]);
    }
    case "packs-slice": {
      const { main } = await import("../../core/dist/packs/packs-slice.js");
      return (argv) => main([...argv]);
    }
    case "roadmap-render": {
      const { main } = await import("../../core/dist/render/roadmap-render.js");
      return (argv) => main(argv);
    }
    case "code-structure-validate": {
      const { evaluateCodeStructure } = await import("@deftai/core/verify-source");
      return (argv) => {
        const parsed = parseCodeStructureArgs(argv);
        if (parsed.error !== undefined) {
          io.writeErr(`code_structure_validate: ${parsed.error}\n`);
          return 2;
        }
        const result = evaluateCodeStructure(parsed.projectRoot, {
          paths: parsed.paths.length > 0 ? parsed.paths : undefined,
          json: parsed.json,
          strict: parsed.strict,
        });
        if (result.stdout) io.writeOut(result.stdout);
        if (result.stderr) io.writeErr(result.stderr);
        return result.code;
      };
    }
    case "pack-migrate-skills":
      return loadPythonScriptHandler("pack_migrate_skills.py");
    case "pack-migrate-rules":
      return loadPythonScriptHandler("pack_migrate_rules.py");
    case "pack-migrate-strategies":
      return loadPythonScriptHandler("pack_migrate_strategies.py");
    case "pack-migrate-patterns":
      return loadPythonScriptHandler("pack_migrate_patterns.py");
    case "pack-migrate-swarm-spec":
      return loadPythonScriptHandler("pack_migrate_swarm_spec.py");
    case "policy-set":
      return loadPythonScriptHandler("policy_set.py");
    default:
      throw new Error(`unknown core verb: ${verb}`);
  }
}

const handlerCache = new Map<string, Promise<CommandHandler>>();

function loadHandler(canonical: string, io: DispatchIo): Promise<CommandHandler> {
  let pending = handlerCache.get(canonical);
  if (pending === undefined) {
    pending = (CLI_MODULE_VERBS as readonly string[]).includes(canonical)
      ? loadCliModuleHandler(canonical, io)
      : loadCoreModuleHandler(canonical, io);
    handlerCache.set(canonical, pending);
  }
  return pending;
}

function defaultIo(): DispatchIo {
  return {
    writeOut: (text) => {
      process.stdout.write(text);
    },
    writeErr: (text) => {
      process.stderr.write(text);
    },
  };
}

/** Resolve a user-facing verb to its canonical handler key. */
export function resolveCanonicalVerb(verb: string): string | null {
  if ((CLI_MODULE_VERBS as readonly string[]).includes(verb)) return verb;
  if ((CORE_MODULE_VERBS as readonly string[]).includes(verb)) return verb;
  const alias = VERB_ALIASES[verb];
  if (alias !== undefined) return alias;
  return null;
}

/** Sorted list of all registered verb names (canonical + aliases). */
export function registeredVerbs(): readonly string[] {
  const names = new Set<string>([
    ...CLI_MODULE_VERBS,
    ...CORE_MODULE_VERBS,
    ...Object.keys(VERB_ALIASES),
  ]);
  return [...names].sort();
}

/** Print dispatcher help listing every registered verb. */
export function printHelp(io: DispatchIo = defaultIo()): void {
  io.writeOut("Usage: deft-ts <verb> [args...]\n\nRegistered verbs:\n");
  for (const name of registeredVerbs()) {
    io.writeOut(`  ${name}\n`);
  }
}

async function invokeHandler(handler: CommandHandler, argv: string[]): Promise<number> {
  const code = await handler(argv);
  return typeof code === "number" ? code : 0;
}

/** Dispatch argv to a registered verb; returns the handler exit code. */
export async function dispatch(argv: string[], io: DispatchIo = defaultIo()): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    printHelp(io);
    return 0;
  }

  const [verb, ...rest] = argv;
  const canonical = resolveCanonicalVerb(verb ?? "");
  if (canonical === null) {
    io.writeErr(`deft-ts: unknown verb '${verb}'\n`);
    return 1;
  }

  try {
    const handler = await loadHandler(canonical, io);
    const handlerArgv =
      canonical === "framework-commands" && verb !== undefined && verb !== canonical
        ? [verb, ...rest]
        : rest;
    return await invokeHandler(handler, handlerArgv);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    io.writeErr(`deft-ts: ${message}\n`);
    return 2;
  }
}

/** Test seam: reset lazy handler cache between cases. */
export function resetHandlerCacheForTests(): void {
  handlerCache.clear();
}
