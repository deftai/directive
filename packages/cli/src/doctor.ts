#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveContentPackageRoot } from "@deftai/directive-core/dist/content-root.js";
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
  readonly skipped: boolean;
}

export interface EvaluateDepositFileSetOptions {
  readonly contentRoot?: string;
}

/** Compare `.deft/core/` against `@deftai/directive-content` (#2804). */
export function evaluateDepositFileSetHygiene(
  projectRoot: string,
  options: EvaluateDepositFileSetOptions = {},
): DepositFileSetHygieneResult {
  const deftDir = join(projectRoot, ".deft", "core");
  if (!existsSync(deftDir)) {
    return { absent: [], contentRoot: null, skipped: true };
  }
  const contentRoot = options.contentRoot ?? resolveContentPackageRoot(projectRoot);
  if (contentRoot === null || !existsSync(contentRoot)) {
    return { absent: [], contentRoot: null, skipped: true };
  }
  return {
    absent: findPackageAbsentDepositPathsSync(deftDir, contentRoot),
    contentRoot,
    skipped: false,
  };
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
  return (
    `Deposit hygiene: fail -- ${result.absent.length} package-absent file(s) in .deft/core ` +
    `(not shipped by @deftai/directive-content). Examples: ${sample}${suffix}. ` +
    "Run `directive update` to auto-prune these stale deposit files (#2804)."
  );
}

export function run(argv: string[]): number {
  // #2022: surface pre-cutover (pre-v0.20 document model) migration state alongside the
  // core doctor report. Only emit on a valid, human-readable invocation: suppressed under
  // --json (so the machine-readable report stays valid), on --help, and when unknown flags
  // are present (so an invalid invocation still mirrors the core error path exactly).
  const flags = parseDoctorFlags(argv);
  let depositHygieneExit = 0;
  if (!flags.json && !flags.help && flags.unknown.length === 0) {
    const projectRoot = flags.projectRoot ?? process.cwd();
    const depositResult = evaluateDepositFileSetHygiene(projectRoot);
    process.stdout.write(`${renderPrecutoverLine(projectRoot)}\n`);
    process.stdout.write(`${renderXbriefMigrationLine(projectRoot)}\n`);
    process.stdout.write(`${renderStaleHeaderLine(projectRoot)}\n`);
    process.stdout.write(`${renderDepositFileSetHygieneLine(projectRoot, depositResult)}\n`);
    const closure = evaluateInstalledDepositClosure(projectRoot);
    process.stdout.write(`${renderDeclaredDepositClosureLine(closure)}\n`);
    if (flags.full && !depositResult.skipped && depositResult.absent.length > 0) {
      depositHygieneExit = 1;
    }
    if (flags.full && !closure.skipped && closure.missing.length > 0) {
      depositHygieneExit = 1;
    }
  }
  const doctorExit = cmdDoctor(argv);
  return Math.max(depositHygieneExit, doctorExit);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run(process.argv.slice(2)));
}
