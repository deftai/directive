#!/usr/bin/env node
/**
 * CLI: task verify:ac — product-first acceptance criteria gate (#3284).
 *
 * Runs plan.acceptance.commands (or #3267 literal ledger) verbatim.
 * Primary name for the product-first done-gate; verify:literal-ac remains
 * the #3267 mechanism alias.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSessionCompletedVerifyAcTarget } from "@deftai/directive-core/check";
import {
  formatRejectedLedger,
  resolveLiteralAcceptanceDetailed,
} from "@deftai/directive-core/literal-acceptance";
import {
  applyAcceptanceDispositionGrants,
  type GrantedClause,
} from "@deftai/directive-core/policy";
import type { ControllerVerifyAcResult } from "@deftai/directive-core/pre-pr-controller";
import {
  emitVerifyAcTerminalOutcome,
  evaluateVerifyAcFromPath,
  readAdmittedSourceDigest,
  readAdmittedSourceSentences,
  readBranchBindContext,
  readPlanAcceptance,
  resolveAcceptanceGateProfile,
  resolveSoftMissingAcTargets,
  VERIFY_AC_NO_OBLIGATION_EXIT,
} from "@deftai/directive-core/product-first-done-gate";
import {
  discoverLandsWithProductMoves,
  persistClauseKeyedPendingItems,
  pinNamesLandsWithProductMove,
} from "@deftai/directive-core/scope";

export { VERIFY_AC_NO_OBLIGATION_EXIT };

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

/**
 * Three-state exit: pass=0, fail=1, config=2, plus deliberate no-obligation=6.
 * A printed pass must not leak 201. No-obligation is a named clamp exception so
 * both check dispatch paths keep the distinct exit (#5855 Recut-8).
 */
export function clampVerifyAcExit(ok: boolean, code: number): number {
  if (ok) return 0;
  if (code === VERIFY_AC_NO_OBLIGATION_EXIT) return VERIFY_AC_NO_OBLIGATION_EXIT;
  if (code === 2) return 2;
  return 1;
}

/**
 * Spec-path briefs persist the refused GitHub body under plan.metadata.issueBody
 * (#4524 / #5055), including empty string when the origin body was empty. Live
 * recovery must use the Bound-remedy harvest (Overview), not body-normative REST.
 */
function planHasSpecPathRefusedBody(plan: Record<string, unknown>): boolean {
  const meta = asRecord(plan.metadata);
  if (meta === null) {
    return false;
  }
  return Object.hasOwn(meta, "issueBody") && typeof meta.issueBody === "string";
}

/**
 * Spec-path admitted source = Overview harvest remainder (#5055).
 * Fail closed when Overview is empty — do not fall through to the refused body.
 */
function fetchSpecPathHarvest(
  plan: Record<string, unknown>,
): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string } {
  const narratives = asRecord(plan.narratives);
  const overview = narratives?.Overview;
  if (typeof overview === "string" && overview.trim().length > 0) {
    return { ok: true, text: overview };
  }
  return {
    ok: false,
    reason:
      "Spec-path Bound-remedy harvest unavailable (Overview empty); refuse offline / restore from git",
  };
}

/**
 * Live REST body for the origin issue (body-normative admitted source, #5055).
 * Fail closed on forge outage — do not skip.
 */
function fetchOriginIssueBody(
  plan: Record<string, unknown>,
): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string } {
  const refs = Array.isArray(plan.references) ? plan.references : [];
  let issueUrl: string | null = null;
  for (const entry of refs) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const row = entry as Record<string, unknown>;
    if (row.type === "x-xbrief/github-issue" && typeof row.uri === "string") {
      issueUrl = row.uri;
      break;
    }
  }
  if (issueUrl === null) {
    return { ok: false, reason: "no github-issue reference on the brief for live REST" };
  }
  const match = issueUrl.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/i);
  if (match === null) {
    return { ok: false, reason: `unparseable github-issue uri: ${issueUrl}` };
  }
  const owner = match[1] ?? "";
  const repo = match[2] ?? "";
  const number = match[3] ?? "";
  const apiPath = `repos/${owner}/${repo}/issues/${number}`;
  const proc = spawnSync("gh", ["api", apiPath, "--jq", ".body"], {
    encoding: "utf8",
    env: process.env,
  });
  if (proc.error) {
    return { ok: false, reason: `forge outage: ${proc.error.message}` };
  }
  if (proc.status !== 0) {
    const detail =
      `${proc.stderr ?? ""}${proc.stdout ?? ""}`.trim() || `gh api exited ${String(proc.status)}`;
    return { ok: false, reason: `forge outage: ${detail}` };
  }
  return { ok: true, text: typeof proc.stdout === "string" ? proc.stdout : "" };
}

/**
 * Live admitted-source text for digest compare / missing-pin recovery (#5055).
 * Spec-path → Bound-remedy harvest; body-normative → origin issue body.
 */
function fetchAdmittedSourceForPlan(
  plan: Record<string, unknown>,
): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string } {
  if (planHasSpecPathRefusedBody(plan)) {
    return fetchSpecPathHarvest(plan);
  }
  return fetchOriginIssueBody(plan);
}

type AdmittedSourceFetcher = () =>
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Arm live admitted-source fetch when a pin is present (digest compare), a
 * digest remains after pin delete (honor recorded digest), or Spec-path
 * refused-body metadata marks harvest recovery (#5055). Spec-path callbacks
 * return the Bound-remedy harvest, not the refused raw issue body. Body-
 * normative both-deleted recovery prefers git HEAD / merge-base so
 * pre-#5055 briefs without a pin are not suddenly floored by live REST.
 */
function admittedSourceFetcherFor(
  plan: Record<string, unknown> | null,
): AdmittedSourceFetcher | undefined {
  if (plan === null) return undefined;
  const pin = readAdmittedSourceSentences(plan.acceptance);
  const digest = readAdmittedSourceDigest(plan.acceptance);
  if (pin !== null || digest !== null || planHasSpecPathRefusedBody(plan)) {
    return () => fetchAdmittedSourceForPlan(plan);
  }
  return undefined;
}

/** A brief's plan object, or null when the brief is unreadable. */
function readPlanAt(path: string): Record<string, unknown> | null {
  try {
    return asRecord(asRecord(JSON.parse(readFileSync(path, "utf8")) as unknown)?.plan);
  } catch {
    return null;
  }
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
  // One shared option profile per reader (#3497) — scope:complete resolves its own
  // profile from the same table, so the two readers cannot drift apart again.
  const profile = resolveAcceptanceGateProfile(options.softMissingXbrief ? "check" : "standalone");
  for (const path of paths) {
    if (!options.quiet && paths.length > 1) {
      process.stdout.write(`verify:ac — evaluating ${path}\n`);
    }
    // Path evaluation still runs on an unreadable brief; evaluateVerifyAcFromPath reports it.
    const fetchAdmittedSourceText = admittedSourceFetcherFor(readPlanAt(path));
    const result = evaluateVerifyAcFromPath(path, {
      projectRoot: options.projectRoot,
      quiet: options.quiet,
      softMissingXbrief: options.softMissingXbrief,
      checkIntegrated: profile.checkIntegrated,
      captureFromNarratives: profile.captureFromNarratives,
      reuseMode: profile.reuseMode,
      env: process.env,
      ...(fetchAdmittedSourceText !== undefined ? { fetchAdmittedSourceText } : {}),
    });
    if (result.message.length > 0) {
      if (result.ok) {
        process.stdout.write(`${result.message}\n`);
      } else {
        process.stderr.write(`${result.message}\n`);
      }
    }
    const code = clampVerifyAcExit(result.ok, result.code);
    if (code !== 0 && (worst === 0 || code > worst)) {
      // Prefer code 1 (fail) over 2 when both present — still non-zero.
      worst = code;
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

/** Selection of a just-completed brief when no active brief is selected (#3357 / #5855). */
type CompletedSelection =
  | { readonly kind: "paths"; readonly paths: readonly string[]; readonly note: string }
  | { readonly kind: "refuse"; readonly message: string }
  | { readonly kind: "none" };

function selectJustCompleted(projectRoot: string, env: NodeJS.ProcessEnv): CompletedSelection {
  const completed = resolveSessionCompletedVerifyAcTarget({ projectRoot, env });
  if (completed.kind === "target") {
    return {
      kind: "paths",
      paths: [completed.path],
      note: `verify:ac targeting just-completed brief (#3357): ${completed.path}`,
    };
  }
  if (completed.kind === "cannot") {
    return { kind: "refuse", message: completed.message };
  }
  return { kind: "none" };
}

/**
 * Story selection that `verify:ac --soft-missing-xbrief` runs when no path is
 * passed (#4285 / #5855 / #6277). `deft check` and `pre-pr:run --complete`
 * (#6888) share it, so the two cannot select different stories.
 * - `paths`: evaluate these briefs; `notes` are the selection lines.
 * - `untied`: admitted untied branch (standalone exit 6, no-obligation).
 * - `no-target`: no brief to run (standalone soft-missing exit 0).
 * - `refuse`: selection failed (standalone exit 1).
 */
export type SoftMissingSelection =
  | {
      readonly kind: "paths";
      readonly paths: readonly string[];
      readonly notes: readonly string[];
    }
  | { readonly kind: "untied"; readonly message: string }
  | { readonly kind: "no-target"; readonly message: string }
  | { readonly kind: "refuse"; readonly message: string };

export function selectSoftMissingVerifyAcTargets(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): SoftMissingSelection {
  // #6277 Bound 6: a change set that moves its story brief to completed/ as
  // lands-with-product runs that brief's AC, not another active story's. An
  // explicit DEFT_ACTIVE_SCOPE pin keeps priority unless it names the moved brief.
  const pin = env.DEFT_ACTIVE_SCOPE?.trim() ?? "";
  const landed = discoverLandsWithProductMoves(projectRoot).filter(
    (move) => pin.length === 0 || pinNamesLandsWithProductMove(projectRoot, pin, move),
  );
  if (landed.length > 0) {
    return {
      kind: "paths",
      paths: landed.map((move) => join(projectRoot, ...move.completedRel.split("/"))),
      notes: [
        `verify:ac targeting lands-with-product brief(s) of this change set (#6277): ${landed
          .map((move) => move.completedRel)
          .join(", ")}`,
      ],
    };
  }
  const found = listActiveXbriefs(projectRoot);
  if (found.kind === "one") {
    return { kind: "paths", paths: [found.path], notes: [] };
  }
  if (found.kind === "many") {
    // #4285: soft-missing selects via DEFT_ACTIVE_SCOPE / explicit path
    // (or fail closed). ALL-paths soft-missing is not the #3284 product bar.
    const bindContext = readBranchBindContext(projectRoot);
    const selected = resolveSoftMissingAcTargets(projectRoot, {
      env,
      scannedPaths: found.paths,
      branchBind: { ...bindContext, env, projectRoot },
    });
    if (selected.kind === "untied") {
      // #5855 P3: completed-target precedence, then soft-missing no-obligation.
      const completed = selectJustCompleted(projectRoot, env);
      if (completed.kind === "paths") {
        return { kind: "paths", paths: completed.paths, notes: [completed.note] };
      }
      if (completed.kind === "refuse") return completed;
      return { kind: "untied", message: selected.message };
    }
    if (selected.kind === "one") {
      return {
        kind: "paths",
        paths: [selected.path],
        notes: [`verify:ac soft-missing multi-active (#4285): selected ${selected.path}`],
      };
    }
    return {
      kind: "refuse",
      message:
        `${selected.kind === "need-pin" ? selected.message : "verify_ac: multi-active soft-missing needs a pin"}\n` +
        "  Usage: task verify:ac -- <path-to-active.xbrief.json>\n" +
        `  Or set DEFT_ACTIVE_SCOPE to the dispatched story under ${found.dir}\n` +
        "  Refs #4285 / #3284 product-first done-gate",
    };
  }
  const completed = selectJustCompleted(projectRoot, env);
  if (completed.kind === "paths") {
    return { kind: "paths", paths: completed.paths, notes: [completed.note] };
  }
  if (completed.kind === "refuse") return completed;
  return {
    kind: "no-target",
    message: "verify:ac skipped (#3284 soft-missing): no active xBRIEF in xbrief/active/",
  };
}

/** Run the gate and return the process exit code. */
export function run(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    process.stderr.write(`verify_ac: ${args.error}\n`);
    emitVerifyAcTerminalOutcome({
      projectRoot: resolve(args.projectRoot),
      env: process.env,
      outcome: "config-error",
    });
    return 2;
  }

  const projectRoot = resolve(args.projectRoot);
  let paths: string[] = [];
  if (args.xbriefPath !== null) {
    paths = [resolve(projectRoot, args.xbriefPath)];
  } else if (args.softMissingXbrief && !args.captureOnly) {
    const selection = selectSoftMissingVerifyAcTargets(projectRoot, process.env);
    if (selection.kind === "refuse") {
      process.stderr.write(`${selection.message}\n`);
      emitVerifyAcTerminalOutcome({ projectRoot, env: process.env, outcome: "config-error" });
      return 1;
    }
    if (selection.kind === "untied" || selection.kind === "no-target") {
      if (!args.quiet) {
        process.stdout.write(`${selection.message}\n`);
      }
      emitVerifyAcTerminalOutcome({ projectRoot, env: process.env, outcome: "soft-missing" });
      // Distinct non-zero for untied: exit 0 keeps meaning executed AC only (#5855 Recut-8).
      return selection.kind === "untied" ? VERIFY_AC_NO_OBLIGATION_EXIT : 0;
    }
    if (!args.quiet) {
      for (const note of selection.notes) {
        process.stdout.write(`${note}\n`);
      }
    }
    paths = [...selection.paths];
  } else {
    // #6277 Bound 6: lands-with-product targeting (see selectSoftMissingVerifyAcTargets).
    const pin = process.env.DEFT_ACTIVE_SCOPE?.trim() ?? "";
    const landed = !args.captureOnly
      ? discoverLandsWithProductMoves(projectRoot).filter(
          (move) => pin.length === 0 || pinNamesLandsWithProductMove(projectRoot, pin, move),
        )
      : [];
    const found = listActiveXbriefs(projectRoot);
    if (landed.length > 0) {
      paths = landed.map((move) => join(projectRoot, ...move.completedRel.split("/")));
      if (!args.quiet) {
        process.stdout.write(
          `verify:ac targeting lands-with-product brief(s) of this change set (#6277): ${landed
            .map((move) => move.completedRel)
            .join(", ")}\n`,
        );
      }
    } else if (found.kind === "one") {
      paths = [found.path];
    } else if (found.kind === "many") {
      // --capture-only still lists every active artifact (inventory, not run).
      if (args.captureOnly) {
        paths = [...found.paths];
        if (!args.quiet) {
          process.stdout.write(
            `verify:ac capture-only multi-active: listing ${paths.length} scopes in ${found.dir}\n`,
          );
        }
      } else {
        process.stderr.write(
          `verify_ac: ${found.paths.length} active scopes in ${found.dir}.\n` +
            "  Pass an explicit path, or set DEFT_ACTIVE_SCOPE with check composition (--soft-missing-xbrief).\n" +
            "  Usage: task verify:ac -- <path-to-active.xbrief.json>\n" +
            "  Refs #4285 / #3284 product-first done-gate\n",
        );
        emitVerifyAcTerminalOutcome({
          projectRoot,
          env: process.env,
          outcome: "config-error",
        });
        return 1;
      }
    } else if (args.softMissingXbrief) {
      // Reached only with --capture-only (the run path selects above).
      const completed = selectJustCompleted(projectRoot, process.env);
      if (completed.kind === "refuse") {
        process.stderr.write(`${completed.message}\n`);
        emitVerifyAcTerminalOutcome({
          projectRoot,
          env: process.env,
          outcome: "config-error",
        });
        return 1;
      }
      if (completed.kind === "none") {
        if (!args.quiet) {
          process.stdout.write(
            "verify:ac skipped (#3284 soft-missing): no active xBRIEF in xbrief/active/\n",
          );
        }
        emitVerifyAcTerminalOutcome({
          projectRoot,
          env: process.env,
          outcome: "soft-missing",
        });
        return 0;
      }
      if (!args.quiet) {
        process.stdout.write(`${completed.note}\n`);
      }
      paths = [...completed.paths];
    } else {
      process.stderr.write(
        "verify_ac: pass an xBRIEF path or ensure exactly one artifact in xbrief/active/\n" +
          "  Usage: task verify:ac -- <path-to-active.xbrief.json>\n" +
          "  Refs #3284 product-first done-gate (mechanism #3267)\n",
      );
      emitVerifyAcTerminalOutcome({
        projectRoot,
        env: process.env,
        outcome: "config-error",
      });
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
        // Executor reads plan.acceptance.commands when the #3267 ledger is empty (#3449).
        const executorCommands =
          resolved.commands.length > 0
            ? resolved.commands
            : acceptance.commands.map((c) => ({
                command: c.command,
                source: "explicit" as const,
                sourceSpan: "plan.acceptance.commands",
                cwd: c.cwd ?? null,
                expectedExitCode: c.expectedExitCode ?? 0,
              }));
        reports.push({
          xbrief: xbriefPath,
          source_rung: acceptance.source_rung,
          none_stated: acceptance.none_stated,
          acceptance_commands: acceptance.commands,
          count: executorCommands.length,
          rejected_count: resolved.rejected.length,
          commands: executorCommands.map((c) => ({
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

/** Inputs for the verify:ac run that `pre-pr:run --complete` owns (#6888). */
export interface ControllerVerifyAcOptions {
  readonly projectRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: Date;
}

/**
 * The verify:ac run that `pre-pr:run --complete` owns (#6888). Same story
 * selection and check-profile evaluation as `verify:ac --soft-missing-xbrief`;
 * standalone exit codes do not change. Clauses covered by a resolver-accepted
 * acceptance-disposition grant are left out of the walk, as at scope:complete:
 * the grants are applied to an in-memory copy of the plan only, so nothing is
 * written to the brief or the grant store and no grant is marked used. The
 * evaluator's brief-writing autofix is not used.
 */
export function resolveControllerVerifyAc(
  options: ControllerVerifyAcOptions,
): ControllerVerifyAcResult {
  const projectRoot = resolve(options.projectRoot);
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const selection = selectSoftMissingVerifyAcTargets(projectRoot, env);
  if (selection.kind === "refuse") {
    return { kind: "fail", output: selection.message };
  }
  if (selection.kind === "untied") {
    return { kind: "untied-no-obligation", output: selection.message };
  }
  if (selection.kind === "no-target") {
    return { kind: "no-target", output: selection.message };
  }
  const profile = resolveAcceptanceGateProfile("check");
  const output: string[] = [...selection.notes];
  let passed = true;
  for (const path of selection.paths) {
    const plan = readPlanAt(path);
    let grantedClauses: readonly GrantedClause[] = [];
    if (plan !== null) {
      const copy = structuredClone(plan);
      persistClauseKeyedPendingItems(copy);
      const granted = applyAcceptanceDispositionGrants({
        projectRoot,
        plan: copy,
        now,
        recordedAt: now.toISOString(),
      });
      if (!granted.ok) {
        output.push(granted.reason);
        passed = false;
        continue;
      }
      grantedClauses = granted.grantedClauses;
    }
    const fetchAdmittedSourceText = admittedSourceFetcherFor(plan);
    const result = evaluateVerifyAcFromPath(path, {
      projectRoot,
      quiet: false,
      softMissingXbrief: true,
      checkIntegrated: profile.checkIntegrated,
      captureFromNarratives: profile.captureFromNarratives,
      reuseMode: profile.reuseMode,
      env,
      grantedClauses,
      persistRequirementSourcesAutofix: () => {},
      ...(fetchAdmittedSourceText !== undefined ? { fetchAdmittedSourceText } : {}),
    });
    if (result.message.length > 0) {
      output.push(result.message);
    }
    if (clampVerifyAcExit(result.ok, result.code) !== 0) {
      passed = false;
    }
  }
  return { kind: passed ? "evaluated-pass" : "fail", output: output.join("\n") };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
