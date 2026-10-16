/**
 * Human plan/progress/report presentation (UNIFIED §C9 Examples A–F / F-002 UX-PRESENT).
 * Wave 3g: F-009 plain shop English, F-011 TTY word-wrap, F-014 uninstall summaries.
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

/** Prefer readable paragraph width even on ultra-wide TTYs. */
export const WRAP_FLOOR = 40;
export const WRAP_CEILING = 100;
export const WRAP_FALLBACK = 80;

/**
 * Insider script-policy sentence — kept for tests / -v dumps only.
 * Default plan uses §C9 HUMAN_INSTALL_SCRIPT_SETTINGS_LINE instead.
 */
export const HUMAN_INSTALL_SCRIPT_LINE =
  "Installation skips package lifecycle scripts for the Directive pin add; other project registry, authentication, proxy, and lockfile settings still apply.";

/** §C9 Examples A/C — default-plan install-script disclosure (AC5.1). */
export const HUMAN_INSTALL_SCRIPT_SETTINGS_LINE =
  "Installation may run scripts allowed by your project's settings.";

/** §C9 Examples A/C — label for the actual PM command on the default plan. */
export const INSTALL_COMMAND_LABEL = "Install command:";

/** Plain no-git disclosure (F-009 / F-010 voice) — incomplete install / precondition. */
export const HUMAN_GIT_HOOKS_INACTIVE_LINE =
  "Incomplete install: this folder is not a git repository yet, so git hooks will not be installed. After you run git init, run directive install --repair so hooks get installed.";

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
  /** WAVE3-V2 convert-via-removals shape id when upgrading a historical layout. */
  readonly convertShapeId?: string | null;
}

export interface UninstallRemovalSummary {
  readonly skillPointers: number;
  readonly hostHooks: number;
  readonly gitHooks: number;
  readonly projectWiring: number;
  readonly other: number;
  readonly legacyCore: boolean;
  readonly willRemovePin: boolean;
  readonly pathInventory: readonly string[];
  readonly preserveLabels: readonly string[];
}

export interface UninstallPlanFields {
  readonly projectRoot: string;
  readonly pm: PackageManager | null;
  readonly pmEvidence: string | null;
  readonly pinVersion: string | null;
  readonly pmCommand: string | null;
  readonly verbosity: Verbosity;
  readonly removal?: UninstallRemovalSummary | null;
  /** @deprecated Prefer removal summary; kept for callers that still pass prose lines at -v. */
  readonly extraHumanLines?: readonly string[];
}

function writeBlank(io: PresentIo): void {
  io.writeOut("\n");
}

function writeLabeled(io: PresentIo, label: string, value: string, width = 18): void {
  const pad = label.length >= width ? `${label} ` : `${label}${" ".repeat(width - label.length)}`;
  io.writeOut(`${pad}${value}\n`);
}

/**
 * Resolve wrap width for human paragraphs.
 * Non-TTY → null (do not invent wraps for pipes/CI).
 * TTY → columns clamped to [WRAP_FLOOR, WRAP_CEILING]; unknown → WRAP_FALLBACK.
 */
export function resolveWrapWidth(opts?: {
  columns?: number | null;
  isTTY?: boolean;
}): number | null {
  const isTTY = opts?.isTTY ?? Boolean(process.stdout.isTTY);
  if (!isTTY) return null;
  let cols = opts?.columns;
  if (cols == null || !Number.isFinite(cols) || cols <= 0) {
    const fromStdout = process.stdout.columns;
    const fromEnv = Number(process.env.COLUMNS);
    if (typeof fromStdout === "number" && fromStdout > 0) cols = fromStdout;
    else if (Number.isFinite(fromEnv) && fromEnv > 0) cols = fromEnv;
    else cols = WRAP_FALLBACK;
  }
  return Math.max(WRAP_FLOOR, Math.min(WRAP_CEILING, Math.floor(cols)));
}

/** Soft-wrap a single paragraph on word boundaries. Preserves the word sequence. */
export function wrapWords(text: string, width: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return "";
  if (width < 1) return normalized;
  const words = normalized.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length === 0) {
      current = word;
      continue;
    }
    if (current.length + 1 + word.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.join("\n");
}

/** Write a human paragraph; wraps on TTY only. */
export function writeHumanParagraph(
  io: PresentIo,
  text: string,
  wrapOpts?: { columns?: number | null; isTTY?: boolean },
): void {
  const width = resolveWrapWidth(wrapOpts);
  const body = width == null ? text.replace(/\s+/g, " ").trim() : wrapWords(text, width);
  if (body.length === 0) return;
  io.writeOut(`${body}\n`);
}

function writeBullet(io: PresentIo, text: string): void {
  const width = resolveWrapWidth();
  if (width == null) {
    io.writeOut(`  • ${text}\n`);
    return;
  }
  const inner = Math.max(WRAP_FLOOR - 4, width - 4);
  const wrapped = wrapWords(text, inner);
  const parts = wrapped.split("\n");
  io.writeOut(`  • ${parts[0]}\n`);
  for (let i = 1; i < parts.length; i++) {
    io.writeOut(`    ${parts[i]}\n`);
  }
}

function writeGitHooksDisclosure(io: PresentIo, inactive: boolean): void {
  if (!inactive) return;
  writeHumanParagraph(io, HUMAN_GIT_HOOKS_INACTIVE_LINE);
}

function writeNodeWarning(io: PresentIo, warning: string | null): void {
  if (!warning) return;
  writeHumanParagraph(io, warning);
}

function writeDisclosures(
  io: PresentIo,
  fields: Pick<CommonPlanFields, "gitHooksInactive" | "nodeWarning" | "verbosity">,
): void {
  // Default: plain git/node only. Insider install-script policy stays in -v keyed dump.
  writeGitHooksDisclosure(io, fields.gitHooksInactive);
  writeNodeWarning(io, fields.nodeWarning);
}

function writeKeyedBlock(io: PresentIo, lines: readonly string[]): void {
  io.writeOut("Plan (verbose):\n");
  for (const line of lines) {
    io.writeOut(`  ${line}\n`);
  }
}

/**
 * §C9 Examples A/C / AC5.1 — Install command + script disclosure on the default plan.
 * Uninstall keeps the verbosity-gated helper below (F-014).
 */
function writeInstallCommandAndScriptDisclosure(
  io: PresentIo,
  command: string | null,
): void {
  if (!command) return;
  writeBlank(io);
  io.writeOut(`${INSTALL_COMMAND_LABEL}\n`);
  io.writeOut(`  ${command}\n`);
  writeBlank(io);
  io.writeOut(`${HUMAN_INSTALL_SCRIPT_SETTINGS_LINE}\n`);
}

/** Uninstall / optional -v-only PM command (F-014 hides Remove command on default). */
function writePmCommandVerbose(
  io: PresentIo,
  label: string,
  command: string | null,
  verbosity: Verbosity,
): void {
  if (verbosity < 1 || !command) return;
  writeBlank(io);
  io.writeOut(`${label}\n`);
  io.writeOut(`  ${command}\n`);
}

/** §C9 Example A — first initialization plan (F-009 plain English). */
export function presentFirstInstallPlan(io: PresentIo, fields: FirstInstallPlanFields): void {
  const lock = lockfileNameFor(fields.pm);
  io.writeOut("Set up Deft Directive\n");
  writeBlank(io);
  writeLabeled(io, "Project:", fields.projectRoot);
  writeLabeled(io, "Package manager:", `${fields.pm} (${fields.pmEvidence})`);
  writeLabeled(io, "Directive version:", fields.version);
  writeBlank(io);
  io.writeOut("If you approve, Directive will:\n");
  if (fields.willCreatePkg) {
    writeBullet(io, "create a minimal package.json for this project");
  }
  writeBullet(
    io,
    `add Directive ${fields.version} to this project's development tools with ${fields.pm}`,
  );
  writeBullet(io, `update ${lock}`);
  writeBullet(io, "set up Directive's project files");
  writeBlank(io);
  writeDisclosures(io, fields);
  writeInstallCommandAndScriptDisclosure(io, fields.pmCommand);

  if (fields.verbosity >= 1) {
    writeBlank(io);
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
        "Git hooks: not installed until git init + directive install --repair (cannot set core.hooksPath=.githooks yet)",
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
    writeHumanParagraph(io, "The installed package is healthy. No reinstall is needed.");
    writeBlank(io);
    io.writeOut("If you approve, Directive will:\n");
    writeBullet(io, `rerun setup using Directive ${fields.version}`);
    writeBullet(io, "recreate missing managed project files as needed");
    writeBlank(io);
    writeHumanParagraph(io, "Your existing settings and other files will be preserved.");
  } else {
    writeHumanParagraph(
      io,
      `The installed package needs restoration (${fields.restoreReason ?? "mismatch"}).`,
    );
    writeBlank(io);
    io.writeOut("If you approve, Directive will:\n");
    writeBullet(io, `restore the Directive ${fields.version} pin with ${fields.pm}`);
    writeBullet(io, "rerun project setup");
    writeBlank(io);
    writeHumanParagraph(io, "Your existing settings and other files will be preserved.");
  }
  writeBlank(io);
  writeDisclosures(io, fields);
  writeInstallCommandAndScriptDisclosure(io, fields.pmCommand);

  if (fields.verbosity >= 1) {
    writeBlank(io);
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
        "Git hooks: not installed until git init + directive install --repair (cannot set core.hooksPath=.githooks yet)",
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
  if (fields.oldStyle) {
    writeHumanParagraph(io, "This project uses an older Directive layout (old-style).");
  } else if (fields.convertShapeId) {
    writeHumanParagraph(
      io,
      `This project uses a historical Directive layout ('${fields.convertShapeId}').`,
    );
  }
  io.writeOut("If you approve, Directive will:\n");
  if (fields.oldStyle) {
    writeBullet(io, "remove the legacy `.deft/core` content copy (including any local edits)");
    writeBullet(
      io,
      `replace the legacy launcher pin with Directive ${fields.targetVersion}`,
    );
    writeBullet(io, `update ${lock}`);
    writeBullet(io, "run setup and any required project-data migrations");
  } else if (fields.convertShapeId) {
    writeBullet(
      io,
      "remove the legacy install footprint (keeping xbrief/ and your files)",
    );
    writeBullet(io, `add Directive ${fields.targetVersion} with ${fields.pm}`);
    writeBullet(io, `update ${lock}`);
    writeBullet(io, "run setup and any required project-data migrations");
  } else if (fields.versionChange) {
    writeBullet(io, `update the exact version in package.json to ${fields.targetVersion}`);
    writeBullet(io, `update ${lock}`);
    writeBullet(io, "run project setup and any required project-data migrations");
  } else {
    writeBullet(
      io,
      `finish equal-version work for Directive ${fields.targetVersion}` +
        (fields.needSetup ? " (setup, then migration as needed)" : " (migration as needed)"),
    );
  }
  writeBlank(io);
  writeHumanParagraph(io, "Your existing project settings will be preserved.");
  writeBlank(io);
  writeDisclosures(io, fields);
  if (fields.versionChange) {
    writeInstallCommandAndScriptDisclosure(io, fields.pmCommand);
  }

  if (fields.verbosity >= 1) {
    writeBlank(io);
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
    if (fields.oldStyle) {
      keyed.splice(
        5,
        0,
        `remove: .deft/core (legacy content copy, even if edited)`,
        `replace: @deftai/directive pin → @deftai/directive-runtime@${fields.targetVersion}`,
      );
    }
    if (fields.gitHooksInactive) {
      keyed.push(
        "Git hooks: not installed until git init + directive install --repair (cannot set core.hooksPath=.githooks yet)",
      );
    }
    if (fields.nodeWarning) keyed.push(`node: ${fields.nodeWarning}`);
    writeKeyedBlock(io, keyed);
    writeBlank(io);
  }
}

export type UninstallPathCategory =
  | "skill"
  | "host-hook"
  | "git-hook"
  | "wiring"
  | "legacy-core"
  | "other";

/** Classify a removable path label for uninstall category counts (F-014). */
export function classifyUninstallPath(pathLabel: string): UninstallPathCategory {
  const p = pathLabel.replace(/\s*\(.*\)$/, "");
  if (p === ".deft/core" || p.startsWith(".deft/core/")) return "legacy-core";
  if (p.includes("/skills/") || /\/SKILL\.md$/i.test(p)) return "skill";
  if (
    p === ".claude/settings.json" ||
    p === ".cursor/hooks.json" ||
    p === ".codex/hooks.json" ||
    p === ".grok/hooks/deft.json" ||
    p.endsWith("/hooks.json") ||
    p.includes("/hooks/")
  ) {
    return "host-hook";
  }
  if (p.startsWith(".githooks/") || p.includes("githooks")) return "git-hook";
  if (
    p === ".deft/GENERATION.json" ||
    p.startsWith(".deft/directive/") ||
    p === "AGENTS.md" ||
    p.startsWith("AGENTS.md") ||
    p === "Taskfile.yml" ||
    p.startsWith("Taskfile.yml") ||
    p === ".gitignore"
  ) {
    return "wiring";
  }
  return "other";
}

export function summarizeUninstallRemovals(
  pathInventory: readonly string[],
  opts: {
    willRemovePin: boolean;
    legacyCore?: boolean;
    preserveLabels?: readonly string[];
  },
): UninstallRemovalSummary {
  let skillPointers = 0;
  let hostHooks = 0;
  let gitHooks = 0;
  let projectWiring = 0;
  let other = 0;
  let legacyCore = Boolean(opts.legacyCore);
  for (const p of pathInventory) {
    switch (classifyUninstallPath(p)) {
      case "skill":
        skillPointers += 1;
        break;
      case "host-hook":
        hostHooks += 1;
        break;
      case "git-hook":
        gitHooks += 1;
        break;
      case "wiring":
        projectWiring += 1;
        break;
      case "legacy-core":
        legacyCore = true;
        break;
      default:
        other += 1;
        break;
    }
  }
  return {
    skillPointers,
    hostHooks,
    gitHooks,
    projectWiring,
    other,
    legacyCore,
    willRemovePin: opts.willRemovePin,
    pathInventory: [...pathInventory],
    preserveLabels: [...(opts.preserveLabels ?? [])],
  };
}

function writeUninstallActionBullets(io: PresentIo, removal: UninstallRemovalSummary, pm: string | null): void {
  io.writeOut("If you approve, Directive will:\n");
  if (removal.skillPointers > 0) {
    writeBullet(
      io,
      `remove ${removal.skillPointers} skill pointer${removal.skillPointers === 1 ? "" : "s"} across agent hosts`,
    );
  }
  if (removal.hostHooks > 0) {
    writeBullet(
      io,
      `clear Directive entries from ${removal.hostHooks} host hook config${removal.hostHooks === 1 ? "" : "s"}`,
    );
  }
  const wiringBits: string[] = [];
  if (removal.gitHooks > 0) wiringBits.push("git hooks");
  if (removal.projectWiring > 0) wiringBits.push("GENERATION and project wiring");
  if (removal.legacyCore) wiringBits.push("legacy .deft/core");
  if (wiringBits.length > 0) {
    writeBullet(io, `remove ${wiringBits.join(", ")}`);
  } else if (removal.other > 0) {
    writeBullet(io, `remove ${removal.other} other Directive-owned path${removal.other === 1 ? "" : "s"}`);
  }
  if (removal.willRemovePin) {
    writeBullet(
      io,
      pm
        ? `remove the Directive runtime pin with ${pm}`
        : "remove the Directive runtime pin from package.json",
    );
  }
  if (
    removal.skillPointers === 0 &&
    removal.hostHooks === 0 &&
    wiringBits.length === 0 &&
    !removal.willRemovePin &&
    removal.other === 0
  ) {
    writeBullet(io, "remove remaining Directive-owned wiring from this project");
  }
}

/** Uninstall plan — category summary by default; path inventory at -v (F-014). */
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

  if (fields.removal) {
    writeUninstallActionBullets(io, fields.removal, fields.pm);
    writeBlank(io);
    const keep =
      fields.removal.preserveLabels.length > 0
        ? fields.removal.preserveLabels.join(", ")
        : "xbrief/ project data and unrelated files";
    writeHumanParagraph(io, `Your ${keep} stay in place.`);
  } else {
    writeHumanParagraph(
      io,
      "I'll remove Directive-owned wiring and the runtime pin from this project. Your xbrief/ project data and unrelated files stay in place.",
    );
  }
  writeBlank(io);
  writePmCommandVerbose(
    io,
    "Package manager command (Directive runs this):",
    fields.pmCommand,
    fields.verbosity,
  );

  if (fields.verbosity >= 1) {
    writeBlank(io);
    if (fields.removal && fields.removal.pathInventory.length > 0) {
      io.writeOut("Remove paths:\n");
      for (const p of fields.removal.pathInventory) {
        io.writeOut(`  ${p}\n`);
      }
      writeBlank(io);
    }
    if (fields.extraHumanLines) {
      for (const line of fields.extraHumanLines) {
        io.writeOut(`${line}\n`);
      }
      writeBlank(io);
    }
    const keyed = [
      `operation: uninstall`,
      `root: ${fields.projectRoot}`,
      fields.pm ? `package manager: ${fields.pm} (${fields.pmEvidence})` : `package manager: (none)`,
      fields.pinVersion ? `pin: ${fields.pinVersion}` : `pin: (none)`,
      fields.pmCommand ? `PM command: ${fields.pmCommand}` : `PM command: (none)`,
    ];
    if (fields.removal) {
      keyed.push(
        `counts: skills=${fields.removal.skillPointers} hostHooks=${fields.removal.hostHooks} gitHooks=${fields.removal.gitHooks} wiring=${fields.removal.projectWiring} other=${fields.removal.other}`,
      );
    }
    writeKeyedBlock(io, keyed);
    writeBlank(io);
  }
}

export interface SetupSummary {
  readonly created: readonly string[];
  readonly modified: readonly string[];
  readonly removed: readonly string[];
  readonly migrated?: readonly string[];
  /** Unknowable / corrupt envelopes copied under xbrief/archive/ (F-017). */
  readonly archived?: readonly string[];
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
  const archived = summary.archived ?? [];
  if (verbosity >= 2) {
    io.writeOut(
      `${label}: ` +
        `created=${JSON.stringify(created)} ` +
        `modified=${JSON.stringify(modified)} ` +
        `removed=${JSON.stringify(removed)}` +
        (migrated.length > 0 ? ` migrated=${JSON.stringify(migrated)}` : "") +
        (archived.length > 0 ? ` archived=${JSON.stringify(archived)}` : "") +
        (summary.conflicts && summary.conflicts.length > 0
          ? ` conflicts=${JSON.stringify(summary.conflicts)}`
          : "") +
        "\n",
    );
  } else if (verbosity >= 1) {
    io.writeOut(
      `${label}: created=${created.length} modified=${modified.length} removed=${removed.length}` +
        (migrated.length > 0 ? ` migrated=${migrated.length}` : "") +
        (archived.length > 0 ? ` archived=${archived.length}` : "") +
        "\n",
    );
  }
  // verbosity 0: path dump omitted; checkmarks / ready block carry the story
  if (summary.message && verbosity >= 1) {
    io.writeOut(`${summary.message}\n`);
  }
}

function gitHooksInactiveFromSummary(summary: SetupSummary | null | undefined): boolean {
  const msg = summary?.message ?? "";
  return /Git hooks inactive/i.test(msg);
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
  const hooksInactive = gitHooksInactiveFromSummary(opts.summary);
  io.writeOut(`✓ Installed Directive ${opts.version}\n`);
  io.writeOut(`✓ Created Directive's project files\n`);
  if (hooksInactive) {
    io.writeOut(`✓ Verified the project-local installation (git hooks not installed yet)\n`);
  } else {
    io.writeOut(`✓ Verified the project-local installation\n`);
  }
  writeBlank(io);
  if (hooksInactive) {
    writeHumanParagraph(io, `Directive ${opts.version} is installed in ${opts.projectRoot}.`);
    writeHumanParagraph(io, HUMAN_GIT_HOOKS_INACTIVE_LINE);
  } else {
    writeHumanParagraph(io, `Directive ${opts.version} is ready in ${opts.projectRoot}.`);
  }
  writeBlank(io);
  io.writeOut("Next:\n");
  if (hooksInactive) {
    io.writeOut("  git init\n");
    io.writeOut("  directive install --repair\n");
  } else {
    io.writeOut("  directive --help\n");
  }
  writeBlank(io);
  io.writeOut("Review and commit:\n");
  io.writeOut("  package.json\n");
  io.writeOut(`  ${lock}\n`);
  const review = collectReviewPaths(opts.summary);
  for (const p of review) {
    io.writeOut(`  ${p}\n`);
  }
  writeBlank(io);
  writeHumanParagraph(io, "Commands in this project use its pinned Directive version.");
  writeHumanParagraph(io, "Updating the global launcher will not upgrade this project.");
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
    pm?: PackageManager;
  },
): void {
  const hooksInactive = gitHooksInactiveFromSummary(opts.summary);
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
  if (hooksInactive) {
    writeHumanParagraph(io, `Directive ${opts.version} setup finished.`);
    writeHumanParagraph(io, HUMAN_GIT_HOOKS_INACTIVE_LINE);
    writeBlank(io);
    io.writeOut("Next:\n");
    io.writeOut("  git init\n");
    io.writeOut("  directive install --repair\n");
  } else {
    writeHumanParagraph(io, `Directive ${opts.version} is ready.`);
  }
  writeHumanParagraph(io, "The project version has not changed.");
  const review = collectReviewPaths(opts.summary);
  if (opts.restoredPackage && opts.pm) {
    const lock = lockfileNameFor(opts.pm);
    if (!review.includes("package.json")) review.unshift("package.json");
    if (!review.includes(lock)) review.splice(1, 0, lock);
  }
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
    writeHumanParagraph(io, `This project now uses Directive ${opts.version}.`);
    writeHumanParagraph(io, "The global launcher was not changed.");
  } else {
    writeHumanParagraph(io, `Directive ${opts.version} is ready.`);
    writeHumanParagraph(io, "The project version has not changed.");
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

/** Uninstall completion — category voice; path inventory at -v (F-014). */
export function presentUninstallSuccess(
  io: PresentIo,
  opts: {
    projectRoot: string;
    complete: boolean;
    removal: UninstallRemovalSummary | null;
    removedPaths?: readonly string[];
    preserved?: readonly string[];
    leftovers?: readonly string[];
    verbosity: Verbosity;
  },
): void {
  if (opts.complete) {
    io.writeOut(`✓ Uninstalled Directive from ${opts.projectRoot}\n`);
  } else {
    io.writeOut(`⚠ Uninstall partially finished in ${opts.projectRoot}\n`);
  }
  writeBlank(io);

  const parts: string[] = [];
  if (opts.removal) {
    if (opts.removal.skillPointers > 0) parts.push("skill pointers");
    if (opts.removal.hostHooks > 0) parts.push("host hooks");
    if (opts.removal.gitHooks > 0 || opts.removal.projectWiring > 0) parts.push("project wiring");
    if (opts.removal.legacyCore) parts.push("legacy core");
    if (opts.removal.willRemovePin) parts.push("the runtime pin");
  }
  if (parts.length > 0) {
    writeHumanParagraph(io, `Removed ${parts.join(", ")}.`);
  } else {
    writeHumanParagraph(io, "Removed Directive-owned wiring from this project.");
  }

  const preserved = opts.preserved ?? opts.removal?.preserveLabels ?? [];
  if (preserved.length > 0) {
    writeHumanParagraph(io, `Preserved: ${preserved.join(", ")}.`);
  } else {
    writeHumanParagraph(io, "Preserved xbrief/ project data and unrelated files.");
  }

  if (!opts.complete && opts.leftovers && opts.leftovers.length > 0) {
    writeBlank(io);
    writeHumanParagraph(io, `Known leftovers: ${opts.leftovers.join(", ")}.`);
  }

  writeBlank(io);
  writeHumanParagraph(
    io,
    "To uninstall the global launcher (other repos may still need it), run: npm uninstall -g @deftai/directive",
  );

  if (opts.verbosity >= 1) {
    writeBlank(io);
    const paths = opts.removedPaths ?? opts.removal?.pathInventory ?? [];
    if (paths.length > 0) {
      io.writeOut("Removed paths:\n");
      for (const p of paths) io.writeOut(`  ${p}\n`);
    }
    if (preserved.length > 0) {
      io.writeOut(`preserved: ${JSON.stringify(preserved)}\n`);
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

/**
 * AC14.18 / AC7.9 migrate half — pin may already be on the new version; default
 * verbosity must name the failed file, list migrated files, and `directive upgrade`.
 */
export function presentMigrateFailedAfterUpgrade(
  io: PresentIo,
  opts: {
    version: string;
    versionChange: boolean;
    summary: SetupSummary | null;
    reason?: string | null;
  },
): void {
  if (opts.versionChange) {
    io.writeErr(
      `Directive ${opts.version} is installed, but project data migration did not finish.\n`,
    );
  } else {
    io.writeErr(
      `Directive ${opts.version} data migration did not finish.\n`,
    );
  }
  writeBlankErr(io);

  const failed = opts.summary?.conflicts ?? [];
  const migrated = opts.summary?.migrated ?? [];
  if (failed.length > 0) {
    io.writeErr("Migration could not update:\n");
    for (const p of failed) {
      io.writeErr(`  ${p}\n`);
    }
    writeBlankErr(io);
  }
  if (migrated.length > 0) {
    io.writeErr("Migrated:\n");
    for (const p of migrated) {
      io.writeErr(`  ${p}\n`);
    }
    writeBlankErr(io);
  }
  const reason = opts.reason ?? opts.summary?.message ?? null;
  if (reason) {
    io.writeErr("Reason:\n");
    io.writeErr(`  ${reason}\n`);
    writeBlankErr(io);
  }
  if (opts.versionChange) {
    io.writeErr(
      `The project pin and lockfile now reference Directive ${opts.version}.\n`,
    );
    writeBlankErr(io);
  }
  io.writeErr("Correct the cause, then run:\n");
  io.writeErr("  directive upgrade\n");
  writeBlankErr(io);
  io.writeErr("Review the existing changes before committing.\n");
}

function writeBlankErr(io: PresentIo): void {
  io.writeErr("\n");
}

/**
 * Prefer a short, human review list — skip noisy skill forests on default.
 * Always include migrated paths (AC5.16 / Greptile): e.g. data-schema.json.
 */
function collectReviewPaths(summary: SetupSummary | null | undefined): string[] {
  if (!summary) return [];
  const prefer = [
    "AGENTS.md",
    ".gitignore",
    "Taskfile.yml",
    ".deft/GENERATION.json",
  ];
  const migrated = summary.migrated ?? [];
  const archived = summary.archived ?? [];
  const all = [...summary.created, ...summary.modified, ...migrated, ...archived];
  const out: string[] = [];
  for (const p of prefer) {
    if (all.includes(p)) out.push(p);
  }
  for (const p of [...migrated, ...archived]) {
    if (!out.includes(p)) out.push(p);
  }
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
  return out.slice(0, 16);
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
      archived: Array.isArray(rec.archived) ? (rec.archived as string[]) : undefined,
      conflicts: Array.isArray(rec.conflicts) ? (rec.conflicts as string[]) : undefined,
      message: typeof rec.message === "string" ? rec.message : undefined,
    };
  } catch {
    return null;
  }
}
