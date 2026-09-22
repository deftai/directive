#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveContentPackageRoot } from "@deftai/directive-core/dist/content-root.js";
import { resolveInstalledContentRoot } from "@deftai/directive-core/dist/deposit/resolve-content.js";
import { setDoctorAgentsTemplateRoot } from "@deftai/directive-core/dist/doctor/agents-md.js";
import { parseDoctorFlags } from "@deftai/directive-core/dist/doctor/flags.js";
import { cmdDoctor } from "@deftai/directive-core/dist/doctor/main.js";
import { findPackageAbsentDepositPathsSync } from "@deftai/directive-core/dist/init-deposit/hygiene.js";
import {
  evaluateInstalledDepositClosure,
  renderDeclaredDepositClosureLine,
} from "@deftai/directive-core/dist/validate-content/deposit-required.js";
import { renderPrecutoverLine } from "@deftai/directive-core/dist/vbrief-validate/precutover.js";
import {
  renderStaleHeaderLine,
  renderXbriefMigrationLine,
} from "@deftai/directive-core/xbrief-migrate";

export interface DepositFileSetHygieneResult {
  readonly absent: readonly string[];
  readonly contentRoot: string | null;
  readonly walkRoot: string | null;
  readonly installedRoot: string | null;
  readonly skipped: boolean;
}

export interface EvaluateDepositFileSetOptions {
  readonly contentRoot?: string;
  readonly walkRoot?: string | null;
  readonly installedRoot?: string | null;
}

export function sameResolvedPath(left: string, right: string): boolean {
  return canonicalizeExistingPath(left) === canonicalizeExistingPath(right);
}

function canonicalizeExistingPath(path: string): string {
  let canonical = resolve(path);
  try {
    if (existsSync(canonical)) canonical = realpathSync(canonical);
  } catch {
    // keep resolve() fallback
  }
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function rootsDiverge(walkRoot: string | null, installedRoot: string | null): boolean {
  return walkRoot !== null && installedRoot !== null && !sameResolvedPath(walkRoot, installedRoot);
}

/** Compare `.deft/core/` against `@deftai/directive-content` (#2804 / #4706). */
export function evaluateDepositFileSetHygiene(
  projectRoot: string,
  options: EvaluateDepositFileSetOptions = {},
): DepositFileSetHygieneResult {
  const deftDir = join(projectRoot, ".deft", "core");
  const walkRoot =
    options.walkRoot !== undefined ? options.walkRoot : resolveContentPackageRoot(projectRoot);
  const installedRoot = options.installedRoot ?? null;
  if (!existsSync(deftDir)) {
    return { absent: [], contentRoot: null, walkRoot, installedRoot, skipped: true };
  }
  const contentRoot = options.contentRoot ?? installedRoot ?? walkRoot;
  if (contentRoot === null || !existsSync(contentRoot)) {
    return { absent: [], contentRoot: null, walkRoot, installedRoot, skipped: true };
  }
  return {
    absent: findPackageAbsentDepositPathsSync(deftDir, contentRoot),
    contentRoot,
    walkRoot,
    installedRoot,
    skipped: false,
  };
}

function hygieneRootDivergenceNote(result: DepositFileSetHygieneResult): string {
  if (!rootsDiverge(result.walkRoot, result.installedRoot ?? result.contentRoot)) {
    return "";
  }
  const compared = result.contentRoot ?? "";
  const walk = result.walkRoot ?? "";
  const installed = result.installedRoot ?? compared;
  return ` Compared content root: ${compared}. Project walk-root: ${walk}. Engine content root: ${installed}.`;
}

function namesUpdatePruneRecovery(result: DepositFileSetHygieneResult): boolean {
  const compared = result.contentRoot;
  const walkRoot = result.walkRoot;
  if (compared === null || walkRoot === null) {
    return true;
  }
  if (!rootsDiverge(walkRoot, result.installedRoot)) {
    return true;
  }
  return !sameResolvedPath(compared, walkRoot);
}

export function renderDepositFileSetHygieneLine(
  projectRoot: string,
  result: DepositFileSetHygieneResult = evaluateDepositFileSetHygiene(projectRoot),
): string {
  const deftDir = join(projectRoot, ".deft", "core");
  if (!existsSync(deftDir)) {
    return "Deposit hygiene: none -- no .deft/core deposit.";
  }
  if (result.skipped) {
    return (
      "Deposit hygiene: skip -- @deftai/directive-content is not installed " +
      "(cannot compare deposit file-set)."
    );
  }
  if (result.absent.length === 0) {
    return "Deposit hygiene: none -- .deft/core file-set matches @deftai/directive-content.";
  }
  const sample = result.absent.slice(0, 5).join(", ");
  const suffix = result.absent.length > 5 ? ` (+${result.absent.length - 5} more)` : "";
  const divergence = hygieneRootDivergenceNote(result);
  const recovery = namesUpdatePruneRecovery(result)
    ? "Run `directive update` to auto-prune these stale deposit files (#2804)."
    : "Do not run `directive update` to prune extras versus the project walk-root; that tree is not the engine content update reconciled (#4706). Leftover pin reconstitution is #4710.";
  return (
    `Deposit hygiene: fail -- ${result.absent.length} package-absent file(s) in .deft/core ` +
    `(not shipped by @deftai/directive-content). Examples: ${sample}${suffix}.${divergence} ` +
    recovery
  );
}

async function resolveEngineContentRoot(): Promise<string | null> {
  try {
    const installed = await resolveInstalledContentRoot();
    return typeof installed === "string" && installed.length > 0 ? installed : null;
  } catch {
    return null;
  }
}

export async function run(argv: string[]): Promise<number> {
  // Human advisory lines stay off --json so the machine report stays one object.
  // Deposit hygiene is still passed into cmdDoctor, including --json (#4812).
  const flags = parseDoctorFlags(argv);
  const installedRoot = await resolveEngineContentRoot();
  if (installedRoot !== null) {
    setDoctorAgentsTemplateRoot(installedRoot);
  }
  try {
    if (flags.help || flags.unknown.length > 0) {
      return cmdDoctor(argv);
    }
    const projectRoot = flags.projectRoot ?? process.cwd();
    const walkRoot = resolveContentPackageRoot(projectRoot);
    const depositResult = evaluateDepositFileSetHygiene(projectRoot, {
      contentRoot: installedRoot ?? undefined,
      walkRoot,
      installedRoot,
    });
    const closure = evaluateInstalledDepositClosure(projectRoot);
    const fileSetFailed = !depositResult.skipped && depositResult.absent.length > 0;
    const closureFailed =
      flags.full && !closure.skipped && (closure.missing.length > 0 || closure.error !== null);
    const line = renderDepositFileSetHygieneLine(projectRoot, depositResult);
    if (!flags.json) {
      process.stdout.write(`${renderPrecutoverLine(projectRoot)}\n`);
      process.stdout.write(`${renderXbriefMigrationLine(projectRoot)}\n`);
      process.stdout.write(`${renderStaleHeaderLine(projectRoot)}\n`);
      process.stdout.write(`${line}\n`);
      process.stdout.write(`${renderDeclaredDepositClosureLine(closure)}\n`);
    }
    const closureLine = renderDeclaredDepositClosureLine(closure);
    return cmdDoctor(argv, {
      depositHygiene: {
        failed: fileSetFailed || closureFailed,
        absent: depositResult.absent,
        line: fileSetFailed ? line : closureFailed ? closureLine : line,
      },
    });
  } finally {
    setDoctorAgentsTemplateRoot(undefined);
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  void run(process.argv.slice(2)).then(
    (code) => {
      process.exit(code);
    },
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.exit(1);
    },
  );
}
