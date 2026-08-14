#!/usr/bin/env node
/**
 * CLI: task verify:ac — product-first acceptance criteria gate (#3284).
 *
 * Runs plan.acceptance.commands (or #3267 literal ledger) verbatim.
 * Primary name for the product-first done-gate; verify:literal-ac remains
 * the #3267 mechanism alias.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSessionCompletedVerifyAcTarget } from "@deftai/directive-core/check";
import {
  formatRejectedLedger,
  resolveLiteralAcceptanceDetailed,
} from "@deftai/directive-core/literal-acceptance";
import {
  evaluateVerifyAcFromPath,
  readPlanAcceptance,
} from "@deftai/directive-core/product-first-done-gate";

interface ParsedArgs {
  projectRoot: string;
  xbriefPath: string | null;
  quiet: boolean;
  captureOnly: boolean;
  softMissingXbrief: boolean;
  error?: string;
}

/** Parse verify:ac CLI args. */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    projectRoot: ".",
    xbriefPath: null,
    quiet: false,
    captureOnly: false,
    softMissingXbrief: false,
  };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--quiet") {
      parsed.quiet = true;
    } else if (arg === "--capture-only") {
      parsed.captureOnly = true;
    } else if (arg === "--soft-missing-xbrief") {
      parsed.softMissingXbrief = true;
    } else if (arg === "--project-root") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: "argument --project-root: expected one argument" };
      }
      parsed.projectRoot = value;
      i += 1;
    } else if (arg?.startsWith("--project-root=")) {
      parsed.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--xbrief" || arg === "--vbrief") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ...parsed, error: `argument ${arg}: expected one argument` };
      }
      parsed.xbriefPath = value;
      i += 1;
    } else if (arg?.startsWith("--xbrief=") || arg?.startsWith("--vbrief=")) {
      parsed.xbriefPath = arg.slice(arg.indexOf("=") + 1);
    } else if (arg?.startsWith("-")) {
      return { ...parsed, error: `unrecognized argument: ${arg}` };
    } else if (arg !== undefined) {
      positionals.push(arg);
    }
  }
  if (parsed.xbriefPath === null && positionals.length > 0) {
    parsed.xbriefPath = positionals[0] ?? null;
  }
  return parsed;
}

/** Result of scanning lifecycle active/ for scope artifacts. */
export type FindActiveXbriefResult =
  | { readonly kind: "one"; readonly path: string }
  | { readonly kind: "none" }
  | { readonly kind: "many"; readonly paths: readonly string[]; readonly dir: string };

function listActiveXbriefs(projectRoot: string): FindActiveXbriefResult {
  // Greptile conf residual #3284: scan BOTH lifecycle roots (xbrief + read-accepted
  // vbrief). Returning after the first non-empty root left the other unchecked.
  const paths: string[] = [];
  const dirs: string[] = [];
  for (const dirName of ["xbrief", "vbrief"]) {
    const active = join(projectRoot, dirName, "active");
    if (!existsSync(active)) continue;
    let names: string[] = [];
    try {
      names = readdirSync(active)
        .filter((n) => n.endsWith(".xbrief.json") || n.endsWith(".vbrief.json"))
        .sort();
    } catch {
      continue;
    }
    if (names.length === 0) continue;
    dirs.push(active);
    for (const n of names) {
      paths.push(join(active, n));
    }
  }
  if (paths.length === 0) return { kind: "none" };
  if (paths.length === 1) {
    return { kind: "one", path: paths[0] as string };
  }
  return {
    kind: "many",
    paths,
    dir: dirs.join(" + "),
  };
}

/** Evaluate one or many xBRIEF paths; return worst non-zero code (fail closed). */
function evaluatePaths(
  paths: readonly string[],
  options: {
    readonly projectRoot: string;
    readonly quiet: boolean;
    readonly softMissingXbrief: boolean;
  },
): number {
  let worst = 0;
  for (const path of paths) {
    if (!options.quiet && paths.length > 1) {
      process.stdout.write(`verify:ac — evaluating ${path}\n`);
    }
    const result = evaluateVerifyAcFromPath(path, {
      projectRoot: options.projectRoot,
      quiet: options.quiet,
      softMissingXbrief: options.softMissingXbrief,
      checkIntegrated: options.softMissingXbrief,
      env: process.env,
    });
    if (result.message.length > 0) {
      if (result.ok) {
        process.stdout.write(`${result.message}\n`);
      } else {
        process.stderr.write(`${result.message}\n`);
      }
    }
    if (result.code !== 0 && (worst === 0 || result.code > worst)) {
      // Prefer code 1 (fail) over 2 when both present — still non-zero.
      worst = result.code;
    }
  }
  return worst;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/** Run the gate and return the process exit code. */
export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`verify_ac: ${args.error}\n`);
    return 2;
  }

  const projectRoot = resolve(args.projectRoot);
  let paths: string[] = [];
  if (args.xbriefPath !== null) {
    paths = [resolve(projectRoot, args.xbriefPath)];
  } else {
    const found = listActiveXbriefs(projectRoot);
    if (found.kind === "one") {
      paths = [found.path];
    } else if (found.kind === "many") {
      // Greptile #3284: multi-active must verify EVERY active scope, not skip.
      if (args.softMissingXbrief || args.captureOnly) {
        paths = [...found.paths];
        if (!args.quiet) {
          process.stdout.write(
            `verify:ac multi-active (#3284): evaluating ${paths.length} scopes in ${found.dir}\n`,
          );
        }
      } else {
        process.stderr.write(
          `verify_ac: ${found.paths.length} active scopes in ${found.dir}.\n` +
            "  Pass an explicit path, or use check composition (--soft-missing-xbrief) to evaluate all.\n" +
            "  Usage: task verify:ac -- <path-to-active.xbrief.json>\n" +
            "  Refs #3284 product-first done-gate\n",
        );
        return 1;
      }
    } else if (args.softMissingXbrief) {
      const completed = resolveSessionCompletedVerifyAcTarget({
        projectRoot,
        env: process.env,
      });
      if (completed.kind === "target") {
        paths = [completed.path];
        if (!args.quiet) {
          process.stdout.write(
            `verify:ac targeting just-completed brief (#3357): ${completed.path}\n`,
          );
        }
      } else if (completed.kind === "cannot") {
        process.stderr.write(`${completed.message}\n`);
        return 1;
      } else if (!args.quiet) {
        process.stdout.write(
          "verify:ac skipped (#3284 soft-missing): no active xBRIEF in xbrief/active/\n",
        );
      }
      if (completed.kind === "none") {
        return 0;
      }
    } else {
      process.stderr.write(
        "verify_ac: pass an xBRIEF path or ensure exactly one artifact in xbrief/active/\n" +
          "  Usage: task verify:ac -- <path-to-active.xbrief.json>\n" +
          "  Refs #3284 product-first done-gate (mechanism #3267)\n",
      );
      return 2;
    }
  }

  if (args.captureOnly) {
    // Capture-only: report each path (multi-active) as a list.
    const reports: unknown[] = [];
    for (const xbriefPath of paths) {
      try {
        const data = asRecord(JSON.parse(readFileSync(xbriefPath, "utf8")));
        if (data === null) {
          process.stderr.write(`verify_ac: xBRIEF top-level is not an object: ${xbriefPath}\n`);
          return 2;
        }
        const plan = asRecord(data.plan);
        if (plan === null) {
          process.stderr.write(`verify_ac: xBRIEF missing plan object: ${xbriefPath}\n`);
          return 2;
        }
        const acceptance = readPlanAcceptance(plan);
        const resolved = resolveLiteralAcceptanceDetailed(plan, { captureFromNarratives: true });
        reports.push({
          xbrief: xbriefPath,
          source_rung: acceptance.source_rung,
          none_stated: acceptance.none_stated,
          acceptance_commands: acceptance.commands,
          count: resolved.commands.length,
          rejected_count: resolved.rejected.length,
          commands: resolved.commands.map((c) => ({
            command: c.command,
            source: c.source,
            sourceSpan: c.sourceSpan ?? null,
            cwd: c.cwd ?? null,
            expectedExitCode: c.expectedExitCode ?? 0,
          })),
          rejected: resolved.rejected.map((r) => ({
            command: r.command,
            reason: r.reason,
            sourceSpan: r.sourceSpan ?? null,
          })),
        });
        if (resolved.rejected.length > 0) {
          process.stderr.write(`${formatRejectedLedger(resolved.rejected)}\n`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`verify_ac: ${msg}\n`);
        return 2;
      }
    }
    process.stdout.write(
      `${JSON.stringify(reports.length === 1 ? reports[0] : { scopes: reports }, null, 2)}\n`,
    );
    return 0;
  }

  return evaluatePaths(paths, {
    projectRoot,
    quiet: args.quiet,
    softMissingXbrief: args.softMissingXbrief,
  });
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
