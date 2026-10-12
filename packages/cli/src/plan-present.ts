/**
 * Human plan/progress/report presentation (UNIFIED §C9 Examples A–F / F-002 UX-PRESENT).
 * Default stdout is prose + labels; keyed machine dumps stay behind verbosity ≥1.
 */
import type { PackageManager } from "./pm.js";
import { INSTALL_SCRIPT_POLICY_PLAN_LINE } from "./pm.js";

/** Local IO shape (matches bookends BookendIo; avoid circular import). */
export interface PresentIo {
  writeOut(text: string): void;
  writeErr(text: string): void;
}

/** 0 = human default; 1 = -v/--verbose; 2 = -vv/--debug */
export type Verbosity = 0 | 1 | 2;

export const HUMAN_INSTALL_SCRIPT_LINE =
  "Installation may run scripts allowed by your project's settings.";

export const HUMAN_GIT_HOOKS_INACTIVE_LINE =
  "Git hooks stay inactive until you run git init, then repair or an eligible runtime command.";

export function lockfileNameFor(pm: PackageManager): string {
  return pm === "pnpm" ? "pnpm-lock.yaml" : "package-lock.json";
}

export function parseVerbosityFlags(argv: readonly string[]): {
  verbosity: Verbosity;
  rest: string[];
} {
  const rest: string[] = [];
  let verbosity: Verbosity = 0;
  for (const a of argv) {
    if (a === "-v" || a === "--verbose") {
      verbosity = Math.max(verbosity, 1) as Verbosity;
      continue;
    }
    if (a === "-vv" || a === "--debug") {
      verbosity = 2;
      continue;
    }
    // curl-like: -vvv treated as debug
    if (/^-v{2,}$/.test(a)) {
      verbosity = 2;
      continue;
    }
    rest.push(a);
  }
  return { verbosity, rest };
}

export interface CommonPlanFields {
  readonly projectRoot: string;
  readonly pm: PackageManager;
  readonly pmEvidence: string;
  readonly version: string;
  readonly gitHooksInactive: boolean;
  readonly nodeWarning: string | null;
  readonly verbosity: Verbosity;
}

export interface FirstInstallPlanFields extends CommonPlanFields {
  readonly pmCommand: string;
  readonly willCreatePkg: boolean;
}

export interface RepairPlanFields extends CommonPlanFields {
  readonly needsPmRestore: boolean;
  readonly pmCommand: string | null;
  readonly restoreReason: string | null;
}

export interface UpgradePlanFields extends CommonPlanFields {
  readonly currentVersion: string;
  readonly targetVersion: string;
  readonly versionChange: boolean;
  readonly pmCommand: string | null;
  readonly needSetup: boolean;
  readonly needMigrate: boolean;
  readonly oldStyle: boolean;
}

export interface UninstallPlanFields {
  readonly projectRoot: string;
  readonly pm: PackageManager | null;
  readonly pmEvidence: string | null;
  readonly pinVersion: string | null;
  readonly pmCommand: string | null;
  readonly verbosity: Verbosity;
  readonly extraHumanLines?: readonly string[];
}

function writeBlank(io: PresentIo): void {
  io.writeOut("\n");
}

function writeLabeled(io: PresentIo, label: string, value: string, width = 18): void {
  const pad = label.length >= width ? `${label} ` : `${label}${" ".repeat(width - label.length)}`;
  io.writeOut(`${pad}${value}\n`);
}

function writeDisclosures(
  io: PresentIo,
  fields: Pick<CommonPlanFields, "gitHooksInactive" | "nodeWarning" | "verbosity">,
): void {
  io.writeOut(`${HUMAN_INSTALL_SCRIPT_LINE}\n`);
  if (fields.gitHooksInactive) {
    io.writeOut(`${HUMAN_GIT_HOOKS_INACTIVE_LINE}\n`);
  }
  if (fields.nodeWarning) {
    io.writeOut(`${fields.nodeWarning}\n`);
  }
  if (fields.verbosity >= 1) {
    writeBlank(io);
    io.writeOut(`  ${INSTALL_SCRIPT_POLICY_PLAN_LINE}\n`);
  }
}

function writeKeyedBlock(io: PresentIo, lines: readonly string[]): void {
  io.writeOut("Plan (verbose):\n");
  for (const line of lines) {
    io.writeOut(`  ${line}\n`);
  }
}

/** §C9 Example A — first initialization plan. */
export function presentFirstInstallPlan(io: PresentIo, fields: FirstInstallPlanFields): void {
  const lock = lockfileNameFor(fields.pm);
  io.writeOut("Set up Deft Directive\n");
  writeBlank(io);
  writeLabeled(io, "Project:", fields.projectRoot);
  writeLabeled(io, "Package manager:", `${fields.pm} (${fields.pmEvidence})`);
  writeLabeled(io, "Directive version:", fields.version);
  writeBlank(io);
  if (fields.willCreatePkg) {
    io.writeOut(
      "I'll create a minimal package.json, add Directive to this project's development\n" +
        `tools, update ${lock}, and run the installed version to create\n` +
        "Directive's project files.\n",
    );
  } else {
    io.writeOut(
      "I'll add Directive to this project's development tools, update\n" +
        `package.json and ${lock}, and run the installed version\n` +
        "to create Directive's project files.\n",
    );
  }
  writeBlank(io);
  io.writeOut("Install command:\n");
  io.writeOut(`  ${fields.pmCommand}\n`);
  writeBlank(io);
  writeDisclosures(io, fields);
  writeBlank(io);

  if (fields.verbosity >= 1) {
    const keyed = [
      `operation: install (first-time)`,
      `root: ${fields.projectRoot}`,
      `package manager: ${fields.pm} (${fields.pmEvidence})`,
      `target: @deftai/directive-runtime@${fields.version}`,
      fields.willCreatePkg
        ? `manifest: create package.json { "private": true }`
        : `manifest: add exact pin to existing package.json`,
      `PM command: ${fields.pmCommand}`,
      `expected: package.json pin + lockfile update via PM`,
      `setup: runtime setup --operation install --from none (wiring, GENERATION.json, readiness; may create missing seed placeholders)`,
      INSTALL_SCRIPT_POLICY_PLAN_LINE,
    ];
    if (fields.gitHooksInactive) {
      keyed.push(
        "Git hooks: inactive until git init + eligible repair/self-complete (cannot set core.hooksPath=.githooks yet)",
      );
    }
    if (fields.nodeWarning) keyed.push(`node: ${fields.nodeWarning}`);
    writeKeyedBlock(io, keyed);
    writeBlank(io);
  }
}

/** §C9 Example B — repair plan. */
export function presentRepairPlan(io: PresentIo, fields: RepairPlanFields): void {
  io.writeOut("Repair Directive\n");
  writeBlank(io);
  writeLabeled(io, "Project:", fields.projectRoot);
  writeLabeled(io, "Package manager:", `${fields.pm} (${fields.pmEvidence})`);
  writeLabeled(io, "Directive version:", `${fields.version} (unchanged)`);
  writeBlank(io);
  if (!fields.needsPmRestore) {
    io.writeOut("The installed package is healthy. No reinstall is needed.\n");
    writeBlank(io);
    io.writeOut(
      `I'll rerun setup using Directive ${fields.version} and recreate missing\n` +
        "managed project files as needed.\n",
    );
    writeBlank(io);
    io.writeOut("Your existing settings and other files will be preserved.\n");
  } else {
    io.writeOut(
      `The installed package needs restoration (${fields.restoreReason ?? "mismatch"}).\n`,
    );
    writeBlank(io);
    if (fields.pmCommand) {
      io.writeOut("Install command:\n");
      io.writeOut(`  ${fields.pmCommand}\n`);
      writeBlank(io);
    }
    io.writeOut(
      `I'll restore the pin and rerun setup using Directive ${fields.version}.\n`,
    );
    writeBlank(io);
    io.writeOut("Your existing settings and other files will be preserved.\n");
  }
  writeBlank(io);
  writeDisclosures(io, fields);
  writeBlank(io);

  if (fields.verbosity >= 1) {
    const keyed = [
      `operation: repair`,
      `root: ${fields.projectRoot}`,
      `package manager: ${fields.pm} (${fields.pmEvidence})`,
      `pin (unchanged): @deftai/directive-runtime@${fields.version}`,
      fields.needsPmRestore
        ? `PM: restore pin via exact add (${fields.restoreReason ?? "needed"})`
        : `PM: none (lockfile records pin; installed package matches)`,
      fields.needsPmRestore && fields.pmCommand
        ? `PM command: ${fields.pmCommand}`
        : `PM command: (none)`,
      `setup: runtime setup --operation repair --from ${fields.version} (wiring/GENERATION/readiness; does not create seed files; never migrates xbrief)`,
      INSTALL_SCRIPT_POLICY_PLAN_LINE,
    ];
    if (fields.gitHooksInactive) {
      keyed.push(
        "Git hooks: inactive until git init + eligible repair/self-complete (cannot set core.hooksPath=.githooks yet)",
      );
    }
    if (fields.nodeWarning) keyed.push(`node: ${fields.nodeWarning}`);
    writeKeyedBlock(io, keyed);
    writeBlank(io);
  }
}

/** §C9 Example C — upgrade plan. */
export function presentUpgradePlan(io: PresentIo, fields: UpgradePlanFields): void {
  const lock = lockfileNameFor(fields.pm);
  io.writeOut("Upgrade Directive\n");
  writeBlank(io);
  writeLabeled(io, "Project:", fields.projectRoot);
  writeLabeled(io, "Package manager:", `${fields.pm} (${fields.pmEvidence})`);
  writeLabeled(io, "Current version:", fields.currentVersion);
  writeLabeled(io, "Target version:", fields.targetVersion);
  writeBlank(io);
  if (fields.versionChange) {
    io.writeOut(
      "I'll update the exact version in package.json, update\n" +
        `${lock}, and run project setup and any required project-data\n` +
        `migrations using Directive ${fields.targetVersion}.\n`,
    );
  } else {
    io.writeOut(
      `I'll finish equal-version work for Directive ${fields.targetVersion}` +
        (fields.needSetup ? " (setup, then migration as needed)" : " (migration as needed)") +
        ".\n",
    );
  }
  writeBlank(io);
  io.writeOut("Your existing project settings will be preserved.\n");
  writeBlank(io);
  if (fields.versionChange && fields.pmCommand) {
    io.writeOut("Install command:\n");
    io.writeOut(`  ${fields.pmCommand}\n`);
    writeBlank(io);
  }
  writeDisclosures(io, fields);
  writeBlank(io);

  if (fields.verbosity >= 1) {
    const keyed = [
      `operation: upgrade`,
      `root: ${fields.projectRoot}`,
      `package manager: ${fields.pm} (${fields.pmEvidence})`,
      `current: @deftai/directive-runtime@${fields.currentVersion}${fields.oldStyle ? " (old-style)" : ""}`,
      `target: @deftai/directive-runtime@${fields.targetVersion}`,
      fields.versionChange
        ? `PM: exact add target (pin + lockfile change)`
        : `PM: none (equal version; package already matches pin)`,
      fields.versionChange && fields.pmCommand
        ? `PM command: ${fields.pmCommand}`
        : `PM command: (none)`,
      fields.needSetup
        ? `setup: runtime setup --operation upgrade --from ${fields.currentVersion}`
        : `setup: none (wiring current for pin)`,
      fields.needMigrate
        ? `migrate: runtime migrate --from ${fields.currentVersion}`
        : `migrate: none`,
      `disclosure: target runtime performs required setup/migrations; project settings/data preserved`,
      `global launcher: unchanged`,
      INSTALL_SCRIPT_POLICY_PLAN_LINE,
    ];
    if (fields.gitHooksInactive) {
      keyed.push(
        "Git hooks: inactive until git init + eligible repair/self-complete (cannot set core.hooksPath=.githooks yet)",
      );
    }
    if (fields.nodeWarning) keyed.push(`node: ${fields.nodeWarning}`);
    writeKeyedBlock(io, keyed);
    writeBlank(io);
  }
}

/** Uninstall plan — human title + disclosures (no §C9 lettered example; keep clear). */
export function presentUninstallPlan(io: PresentIo, fields: UninstallPlanFields): void {
  io.writeOut("Uninstall Directive\n");
  writeBlank(io);
  writeLabeled(io, "Project:", fields.projectRoot);
  if (fields.pm && fields.pmEvidence) {
    writeLabeled(io, "Package manager:", `${fields.pm} (${fields.pmEvidence})`);
  }
  if (fields.pinVersion) {
    writeLabeled(io, "Pinned version:", fields.pinVersion);
  }
  writeBlank(io);
  io.writeOut(
    "I'll remove Directive-owned wiring and the runtime pin from this project.\n" +
      "Your xbrief/project data and unrelated files stay in place.\n",
  );
  writeBlank(io);
  if (fields.pmCommand) {
    io.writeOut("Remove command:\n");
    io.writeOut(`  ${fields.pmCommand}\n`);
    writeBlank(io);
  }
  if (fields.extraHumanLines) {
    for (const line of fields.extraHumanLines) {
      io.writeOut(`${line}\n`);
    }
    writeBlank(io);
  }
  if (fields.verbosity >= 1) {
    const keyed = [
      `operation: uninstall`,
      `root: ${fields.projectRoot}`,
      fields.pm ? `package manager: ${fields.pm} (${fields.pmEvidence})` : `package manager: (none)`,
      fields.pinVersion ? `pin: ${fields.pinVersion}` : `pin: (none)`,
      fields.pmCommand ? `PM command: ${fields.pmCommand}` : `PM command: (none)`,
    ];
    writeKeyedBlock(io, keyed);
    writeBlank(io);
  }
}

export interface SetupSummary {
  readonly created: readonly string[];
  readonly modified: readonly string[];
  readonly removed: readonly string[];
  readonly migrated?: readonly string[];
  readonly conflicts?: readonly string[];
  readonly message?: string;
}

/** Default: short human summary; -v counts; -vv full JSON arrays. */
export function presentPathSummary(
  io: PresentIo,
  label: string,
  summary: SetupSummary,
  verbosity: Verbosity,
): void {
  const created = summary.created ?? [];
  const modified = summary.modified ?? [];
  const removed = summary.removed ?? [];
  const migrated = summary.migrated ?? [];
  if (verbosity >= 2) {
    io.writeOut(
      `${label}: ` +
        `created=${JSON.stringify(created)} ` +
        `modified=${JSON.stringify(modified)} ` +
        `removed=${JSON.stringify(removed)}` +
        (migrated.length > 0 ? ` migrated=${JSON.stringify(migrated)}` : "") +
        (summary.conflicts && summary.conflicts.length > 0
          ? ` conflicts=${JSON.stringify(summary.conflicts)}`
          : "") +
        "\n",
    );
  } else if (verbosity >= 1) {
    io.writeOut(
      `${label}: created=${created.length} modified=${modified.length} removed=${removed.length}` +
        (migrated.length > 0 ? ` migrated=${migrated.length}` : "") +
        "\n",
    );
  }
  // verbosity 0: path dump omitted; checkmarks / ready block carry the story
  if (summary.message) {
    io.writeOut(`${summary.message}\n`);
  }
}

/** §C9 Example A completion after successful first install. */
export function presentInstallSuccess(
  io: PresentIo,
  opts: {
    version: string;
    projectRoot: string;
    pm: PackageManager;
    summary: SetupSummary | null;
    verbosity: Verbosity;
  },
): void {
  const lock = lockfileNameFor(opts.pm);
  io.writeOut(`✓ Installed Directive ${opts.version}\n`);
  io.writeOut(`✓ Created Directive's project files\n`);
  io.writeOut(`✓ Verified the project-local installation\n`);
  writeBlank(io);
  io.writeOut(`Directive ${opts.version} is ready in ${opts.projectRoot}.\n`);
  writeBlank(io);
  io.writeOut("Next:\n");
  io.writeOut("  directive --help\n");
  writeBlank(io);
  io.writeOut("Review and commit:\n");
  io.writeOut("  package.json\n");
  io.writeOut(`  ${lock}\n`);
  const review = collectReviewPaths(opts.summary);
  for (const p of review) {
    io.writeOut(`  ${p}\n`);
  }
  writeBlank(io);
  io.writeOut("Commands in this project use its pinned Directive version.\n");
  io.writeOut("Updating the global launcher will not upgrade this project.\n");
  if (opts.verbosity >= 1 && opts.summary) {
    writeBlank(io);
    presentPathSummary(io, "setup install", opts.summary, opts.verbosity);
  }
}

/** §C9 Example B completion after repair. */
export function presentRepairSuccess(
  io: PresentIo,
  opts: {
    version: string;
    restoredPackage: boolean;
    summary: SetupSummary | null;
    verbosity: Verbosity;
  },
): void {
  if (opts.restoredPackage) {
    io.writeOut(`✓ Restored the installed Directive ${opts.version} package\n`);
  } else {
    io.writeOut(`✓ Verified the installed Directive ${opts.version} package\n`);
  }
  io.writeOut(`✓ Reran project setup\n`);
  if (opts.summary && opts.summary.created.length + opts.summary.modified.length > 0) {
    io.writeOut(`✓ Restored managed project files\n`);
  }
  writeBlank(io);
  io.writeOut(`Directive ${opts.version} is ready.\n`);
  io.writeOut("The project version has not changed.\n");
  const review = collectReviewPaths(opts.summary);
  if (review.length > 0) {
    writeBlank(io);
    io.writeOut("Review and commit:\n");
    for (const p of review) {
      io.writeOut(`  ${p}\n`);
    }
  }
  if (opts.verbosity >= 1 && opts.summary) {
    writeBlank(io);
    presentPathSummary(io, "setup repair", opts.summary, opts.verbosity);
  }
}

/** §C9 Example C completion after upgrade. */
export function presentUpgradeSuccess(
  io: PresentIo,
  opts: {
    version: string;
    versionChange: boolean;
    pm: PackageManager;
    summary: SetupSummary | null;
    migrateSummary: SetupSummary | null;
    verbosity: Verbosity;
  },
): void {
  if (opts.versionChange) {
    io.writeOut(`✓ Installed Directive ${opts.version}\n`);
  }
  io.writeOut(`✓ Completed project setup\n`);
  io.writeOut(`✓ Verified the project-local installation\n`);
  writeBlank(io);
  if (opts.versionChange) {
    io.writeOut(`This project now uses Directive ${opts.version}.\n`);
    io.writeOut("The global launcher was not changed.\n");
  } else {
    io.writeOut(`Directive ${opts.version} is ready.\n`);
    io.writeOut("The project version has not changed.\n");
  }
  writeBlank(io);
  io.writeOut("Review and commit:\n");
  if (opts.versionChange) {
    io.writeOut("  package.json\n");
    io.writeOut(`  ${lockfileNameFor(opts.pm)}\n`);
  }
  const review = [
    ...collectReviewPaths(opts.summary),
    ...collectReviewPaths(opts.migrateSummary),
  ];
  const seen = new Set<string>();
  for (const p of review) {
    if (seen.has(p)) continue;
    seen.add(p);
    io.writeOut(`  ${p}\n`);
  }
  if (opts.verbosity >= 1) {
    writeBlank(io);
    if (opts.summary) presentPathSummary(io, "setup upgrade", opts.summary, opts.verbosity);
    if (opts.migrateSummary) {
      presentPathSummary(io, "migrate", opts.migrateSummary, opts.verbosity);
    }
  }
}

/** §C9 Example E — ambiguous automated rerun. */
export function presentAmbiguousYes(io: PresentIo, pinVersion: string): void {
  io.writeErr(
    `Directive is already configured at version ${pinVersion}.\n` +
      `To repair this installation, select repair explicitly:\n` +
      `\n` +
      `  directive install --repair --yes\n` +
      `\n` +
      `For a deliberate version or data upgrade, use directive upgrade --yes.\n` +
      `No project files were changed.\n`,
  );
}

/** §C9 Example F — installation succeeded, setup failed. */
export function presentSetupFailedAfterInstall(
  io: PresentIo,
  opts: {
    version: string;
    operation: "install" | "repair" | "upgrade";
    failedPaths?: readonly string[];
    reason?: string | null;
  },
): void {
  if (opts.operation === "install" || opts.operation === "upgrade") {
    io.writeErr(
      `Directive ${opts.version} is installed, but project setup did not finish.\n`,
    );
  } else {
    io.writeErr(`Directive ${opts.version} repair ran, but project setup did not finish.\n`);
  }
  writeBlankErr(io);
  if (opts.failedPaths && opts.failedPaths.length > 0) {
    io.writeErr("Setup could not update:\n");
    for (const p of opts.failedPaths) {
      io.writeErr(`  ${p}\n`);
    }
    writeBlankErr(io);
  }
  if (opts.reason) {
    io.writeErr("Reason:\n");
    io.writeErr(`  ${opts.reason}\n`);
    writeBlankErr(io);
  }
  if (opts.operation === "install" || opts.operation === "upgrade") {
    io.writeErr(
      `The project pin and lockfile now reference Directive ${opts.version}.\n`,
    );
    writeBlankErr(io);
  }
  io.writeErr("Correct the cause, then run:\n");
  io.writeErr("  directive install --repair\n");
  if (opts.operation === "upgrade") {
    io.writeErr("  (or directive upgrade again for data migration)\n");
  }
  writeBlankErr(io);
  io.writeErr("Review the existing changes before committing.\n");
}

function writeBlankErr(io: PresentIo): void {
  io.writeErr("\n");
}

/** Prefer a short, human review list — skip noisy skill forests on default. */
function collectReviewPaths(summary: SetupSummary | null | undefined): string[] {
  if (!summary) return [];
  const prefer = [
    "AGENTS.md",
    ".gitignore",
    "Taskfile.yml",
    ".deft/GENERATION.json",
  ];
  const all = [...summary.created, ...summary.modified, ...(summary.migrated ?? [])];
  const out: string[] = [];
  for (const p of prefer) {
    if (all.includes(p)) out.push(p);
  }
  // Include a few top-level host configs if present
  for (const p of all) {
    if (out.includes(p)) continue;
    if (
      p === ".claude/settings.json" ||
      p === ".cursor/hooks.json" ||
      p === ".codex/hooks.json" ||
      p === ".grok/hooks/deft.json"
    ) {
      out.push(p);
    }
  }
  return out.slice(0, 12);
}

export function tryParseSetupSummary(stdout: string): SetupSummary | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const last = trimmed.split("\n").filter(Boolean).pop() ?? "";
    const parsed: unknown = JSON.parse(last);
    if (!parsed || typeof parsed !== "object") return null;
    const rec = parsed as Record<string, unknown>;
    return {
      created: Array.isArray(rec.created) ? (rec.created as string[]) : [],
      modified: Array.isArray(rec.modified) ? (rec.modified as string[]) : [],
      removed: Array.isArray(rec.removed) ? (rec.removed as string[]) : [],
      migrated: Array.isArray(rec.migrated) ? (rec.migrated as string[]) : undefined,
      conflicts: Array.isArray(rec.conflicts) ? (rec.conflicts as string[]) : undefined,
      message: typeof rec.message === "string" ? rec.message : undefined,
    };
  } catch {
    return null;
  }
}
