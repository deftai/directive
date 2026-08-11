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
import {
  formatRejectedLedger,
  resolveLiteralAcceptanceDetailed,
} from "@deftai/directive-core/literal-acceptance";
import {
  evaluateVerifyAcFromPath,
  readPlanAcceptance,
  type VerifyAcResult,
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

/** Result of scanning lifecycle active/ for a unique scope artifact. */
export type FindActiveXbriefResult =
  | { readonly kind: "one"; readonly path: string }
  | { readonly kind: "none" }
  | { readonly kind: "ambiguous"; readonly count: number; readonly dir: string };

function findActiveXbriefDetailed(projectRoot: string): FindActiveXbriefResult {
  for (const dirName of ["xbrief", "vbrief"]) {
    const active = join(projectRoot, dirName, "active");
    if (!existsSync(active)) continue;
    let names: string[] = [];
    try {
      names = readdirSync(active).filter(
        (n) => n.endsWith(".xbrief.json") || n.endsWith(".vbrief.json"),
      );
    } catch {
      continue;
    }
    if (names.length === 1) {
      return { kind: "one", path: join(active, names[0] as string) };
    }
    if (names.length > 1) {
      return { kind: "ambiguous", count: names.length, dir: active };
    }
  }
  return { kind: "none" };
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
  let xbriefPath = args.xbriefPath !== null ? resolve(projectRoot, args.xbriefPath) : null;
  if (xbriefPath === null) {
    const found = findActiveXbriefDetailed(projectRoot);
    if (found.kind === "one") {
      xbriefPath = found.path;
    } else if (found.kind === "ambiguous") {
      // Greptile P1 #3284: multi-active must not soft-pass as "missing" — fail closed.
      process.stderr.write(
        `verify_ac: ambiguous active scope (${found.count} artifacts in ${found.dir}).\n` +
          "  Pass an explicit xBRIEF path: task verify:ac -- <path-to-active.xbrief.json>\n" +
          "  Refs #3284 product-first done-gate (must not skip mandatory AC under multi-active)\n",
      );
      return 1;
    } else if (args.softMissingXbrief) {
      if (!args.quiet) {
        process.stdout.write(
          "verify:ac skipped (#3284 soft-missing): no active xBRIEF in xbrief/active/\n",
        );
      }
      return 0;
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
    try {
      const data = asRecord(JSON.parse(readFileSync(xbriefPath, "utf8")));
      if (data === null) {
        process.stderr.write("verify_ac: xBRIEF top-level is not an object\n");
        return 2;
      }
      const plan = asRecord(data.plan);
      if (plan === null) {
        process.stderr.write("verify_ac: xBRIEF missing plan object\n");
        return 2;
      }
      const acceptance = readPlanAcceptance(plan);
      const resolved = resolveLiteralAcceptanceDetailed(plan, { captureFromNarratives: true });
      const payload = {
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
      };
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      if (resolved.rejected.length > 0) {
        process.stderr.write(`${formatRejectedLedger(resolved.rejected)}\n`);
      }
      return 0;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`verify_ac: ${msg}\n`);
      return 2;
    }
  }

  const result: VerifyAcResult = evaluateVerifyAcFromPath(xbriefPath, {
    projectRoot,
    quiet: args.quiet,
    softMissingXbrief: args.softMissingXbrief,
    // Check graph uses --soft-missing-xbrief; treat as check-integrated composition.
    checkIntegrated: args.softMissingXbrief,
  });

  if (result.message.length > 0) {
    if (result.ok) {
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
