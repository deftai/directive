/**
 * Contract-1 / R12 read-only doctor diagnosis (Wave 2e).
 *
 * Covers AC12.3 surfaces via install-health + data-status. Never writes.
 * Hook probes must set DEFT_DOCTOR_HOOK_DIAGNOSTIC (AC9.10).
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { AGY_DIRECTIVE_HOOK_NAME } from "@deftai/directive-core/dist/hooks/classify/agy-hook-order.js";
import {
  hostHookConfigEntryLines,
  hostHookOuterRelPath,
  hostHookOuterSha8,
  isHostHookOuterCommand,
  isManagedAgyHookEntry,
} from "@deftai/directive-core/dist/init-deposit/host-hook-outer.js";
import {
  ENTRY_GUARD_MESSAGES,
  formatEntryGuardMessage,
  pinInvalidValues,
  projectInstallCommand,
} from "@deftai/directive-core/dist/install-health/constants.js";
import {
  checkFullInSync,
  DEFT_DOCTOR_HOOK_DIAGNOSTIC,
  type FullInSyncResult,
  type PredicateResult,
  RUNTIME_PACKAGE_PATH_PREFIX,
} from "@deftai/directive-core/dist/install-health/index.js";
import { listDirectiveOwnedPaths } from "@deftai/directive-core/dist/install-health/owned-paths.js";
import { readRuntimePin } from "@deftai/directive-core/dist/install-health/readers.js";
import {
  checkIgnoreVerboseStdout,
  displayIgnoreSource,
  indexFlagKind,
  parseCheckIgnoreVerboseLine,
  parseLsFilesVerboseRecord,
} from "@deftai/directive-core/dist/lifecycle-visible/evaluate.js";
import { envGitRunner, type GitRunner } from "@deftai/directive-core/dist/session/git.js";
import { type DataStatusValue, readProjectDataStatus } from "./data-status.js";
import {
  describeHooksPathScope,
  type HooksPathState,
  isAbsoluteHooksPathValue,
  readHooksPathState,
} from "./setup-wiring.js";

export { DEFT_DOCTOR_HOOK_DIAGNOSTIC };

// ---------------------------------------------------------------------------
// Hidden Directive files (#6618 / #6163)
//
// Warning: a Directive file that must be committed is hidden from git by
// `.git/info/exclude`, a global excludes file (`core.excludesFile`) or a
// `.gitignore` (found with `git check-ignore -v --no-index`, so a tracked
// `.cursor/hooks.json` under a blanket `.cursor/` rule still reports the next
// new `.mjs` outer), or by a skip-worktree / assume-unchanged index flag.
// Read-only (AC12.1): git probes only, with `GIT_OPTIONAL_LOCKS=0`. Readiness
// markers and `node_modules/` are meant to be ignored (AC8.5) and never checked.
// ---------------------------------------------------------------------------

export type HiddenDirectiveFileKind = "ignored" | "skip-worktree" | "assume-unchanged";

export interface HiddenDirectiveFile {
  readonly path: string;
  readonly kind: HiddenDirectiveFileKind;
  /** Display source: `.git/info/exclude`, `.gitignore`, `global excludes file (<path>)`, or `git index`. */
  readonly source: string;
  readonly line: number | null;
  readonly pattern: string | null;
}

/** Host hook config → the host whose `.mjs` outer it registers (AC9.1). */
const HOST_CONFIGS = [
  { config: ".claude/settings.json", host: "claude" },
  { config: ".cursor/hooks.json", host: "cursor" },
  { config: ".codex/hooks.json", host: "codex" },
  { config: ".grok/hooks/deft.json", host: "grok" },
  { config: ".agents/hooks.json", host: "agy" },
] as const;

/**
 * `.agents/hooks.json` is shared with the user's own agy hooks, so it counts as
 * Directive's only while it holds the `zzzz-directive` entry (#7438).
 */
function holdsDirectiveAgyEntry(abs: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(abs, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    return isManagedAgyHookEntry((parsed as Record<string, unknown>)[AGY_DIRECTIVE_HOOK_NAME]);
  } catch {
    return false;
  }
}

/** Read-only git runner: no optional index refresh (AC12.1). */
export function readOnlyGitRunner(): GitRunner {
  return envGitRunner({ GIT_OPTIONAL_LOCKS: "0" });
}

function isFilePath(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/**
 * Concrete project-relative paths Directive needs committed: owned files
 * that exist, every existing `.mjs` outer, and the current `.mjs` outer for
 * each host that has a hook config (it may be hidden before it is created).
 */
export function directiveFilesToCheck(projectRoot: string): string[] {
  const out = new Set<string>();
  for (const entry of listDirectiveOwnedPaths(projectRoot)) {
    if (!entry.mustCommit) continue;
    if (entry.kind === "retired" || entry.kind === "retained") continue;
    if (entry.pattern !== undefined) {
      const slash = entry.path.lastIndexOf("/");
      const dir = slash >= 0 ? entry.path.slice(0, slash) : "";
      for (const name of listDir(join(projectRoot, dir))) {
        const rel = dir ? `${dir}/${name}` : name;
        if (entry.pattern.test(rel) && isFilePath(join(projectRoot, rel))) out.add(rel);
      }
      continue;
    }
    const abs = join(projectRoot, entry.path);
    if (!isFilePath(abs)) continue;
    if (entry.path === ".agents/hooks.json" && !holdsDirectiveAgyEntry(abs)) continue;
    out.add(entry.path);
  }
  const sha8 = hostHookOuterSha8();
  for (const { config, host } of HOST_CONFIGS) {
    const abs = join(projectRoot, config);
    if (!existsSync(abs)) continue;
    if (host === "agy" && !holdsDirectiveAgyEntry(abs)) continue;
    out.add(hostHookOuterRelPath(host, sha8));
  }
  return [...out].filter((rel) => !rel.startsWith("node_modules/")).sort();
}

function displayHiddenSource(source: string, projectRoot: string): string {
  const shown = displayIgnoreSource(source, projectRoot);
  if (shown === ".git/info/exclude") return shown;
  if (isAbsolute(shown) || shown.startsWith("..")) return `global excludes file (${shown})`;
  return shown;
}

function findIgnoredDirectiveFiles(
  projectRoot: string,
  paths: readonly string[],
  runGit: GitRunner,
): HiddenDirectiveFile[] {
  const stdout = checkIgnoreVerboseStdout(projectRoot, runGit, paths);
  const out: HiddenDirectiveFile[] = [];
  const seen = new Set<string>();
  for (const raw of stdout.split(/\r?\n/)) {
    if (raw.length === 0) continue;
    const parsed = parseCheckIgnoreVerboseLine(raw);
    if (parsed === null) continue;
    // A negation (`!rule`) un-ignores the file; it is not a hide.
    if (parsed.pattern.startsWith("!") || parsed.pattern.trim().length === 0) continue;
    if (seen.has(parsed.path)) continue;
    seen.add(parsed.path);
    out.push({
      path: parsed.path,
      kind: "ignored",
      source: displayHiddenSource(parsed.source, projectRoot),
      line: parsed.line,
      pattern: parsed.pattern,
    });
  }
  return out;
}

/** Tracked paths among `paths`, and those hidden by an index flag. */
function readIndexState(
  projectRoot: string,
  paths: readonly string[],
  runGit: GitRunner,
): { tracked: Set<string>; flagged: HiddenDirectiveFile[] } {
  const tracked = new Set<string>();
  const flagged: HiddenDirectiveFile[] = [];
  const { code, stdout } = runGit(projectRoot, ["ls-files", "-v", "--", ...paths]);
  if (code !== 0) return { tracked, flagged };
  for (const record of stdout.split(/\r?\n/)) {
    if (record.length === 0) continue;
    const parsed = parseLsFilesVerboseRecord(record);
    if (parsed === null) continue;
    tracked.add(parsed.path);
    const kind = indexFlagKind(parsed.tag);
    if (kind === null) continue;
    flagged.push({ path: parsed.path, kind, source: "git index", line: null, pattern: null });
  }
  return { tracked, flagged };
}

/**
 * Directive files hidden from git, or null when the project is not a git
 * checkout (or git cannot be run): the check is then skipped, not failed.
 */
export function findHiddenDirectiveFiles(
  projectRoot: string,
  runGit: GitRunner = readOnlyGitRunner(),
): HiddenDirectiveFile[] | null {
  if (!existsSync(join(projectRoot, ".git"))) return null;
  const paths = directiveFilesToCheck(projectRoot);
  if (paths.length === 0) return [];
  try {
    const { tracked, flagged } = readIndexState(projectRoot, paths, runGit);
    // A tracked file stays committable under a matching ignore rule, so only
    // untracked files (including the next `.mjs` outer, not yet created) can
    // be hidden by one (#6163).
    const ignored = findIgnoredDirectiveFiles(projectRoot, paths, runGit).filter(
      (f) => !tracked.has(f.path),
    );
    return [...ignored, ...flagged];
  } catch {
    return null;
  }
}

/** One warning line per hidden file (#6618 wording). */
export function formatHiddenDirectiveFileWarning(file: HiddenDirectiveFile): string {
  if (file.kind === "ignored") {
    return (
      `Directive file ${file.path} is hidden from git by ${file.source}:${file.line} ` +
      `('${file.pattern}'). Directive's own files must stay committable. Remove or narrow that rule.`
    );
  }
  const clear =
    file.kind === "skip-worktree"
      ? `git update-index --no-skip-worktree -- ${file.path}`
      : `git update-index --no-assume-unchanged -- ${file.path}`;
  return (
    `Directive file ${file.path} is hidden from git by the ${file.kind} flag in the git index. ` +
    `Directive's own files must stay committable. Clear it with \`${clear}\`.`
  );
}

// ---------------------------------------------------------------------------
// Absolute core.hooksPath outside this worktree (#7029)
//
// Warning only (exit-exempt): an absolute `core.hooksPath` that points outside
// the current worktree makes this checkout run another folder's hooks. In a
// linked worktree that is the primary checkout's hooks, which break when the
// primary is on an older commit. Read-only: reads Git config, never writes it.
// ---------------------------------------------------------------------------

function realOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function isInsideDir(dir: string, target: string): boolean {
  const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const rel = relative(norm(realOrResolved(dir)), norm(realOrResolved(target)));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Warning text for an absolute core.hooksPath outside the worktree, else null. */
export function hooksPathOutsideWorktreeWarning(projectRoot: string): string | null {
  if (!projectHasGitDir(projectRoot)) return null;
  const value = readHooksPathState(projectRoot).value;
  if (value === null || !isAbsoluteHooksPathValue(value)) return null;
  if (isInsideDir(projectRoot, value)) return null;
  return (
    `core.hooksPath is the absolute path '${value}', outside this worktree, so this checkout ` +
    `runs hooks from that folder (a linked worktree runs another checkout's hooks). ` +
    `Run directive install --repair to set it to .githooks.`
  );
}

/**
 * F-010 / C7 — no-.git partial install: primary recovery is git init then repair,
 * not the generic AC9.7 global reinstall line.
 */
export const GIT_PRECONDITION_RECOVERY_GUIDANCE = "git init, then directive install --repair";

/** Readiness detail when wiring-ready is withheld solely because there is no .git. */
export const GIT_PRECONDITION_READINESS_DETAIL =
  "incomplete install — wiring-ready withheld until git init (hooksPath not activatable)";

/**
 * #4960 / #5846 — readiness withheld because another `core.hooksPath` is set.
 * Repair shows the takeover in its plan and asks once (ledger Problem 20).
 */
export const FOREIGN_HOOKS_PATH_RECOVERY_GUIDANCE = "directive install --repair";

/** Readiness detail naming the other hooks folder and where it is set. */
export function formatForeignHooksPathReadinessDetail(state: HooksPathState): string {
  return (
    `wiring-ready withheld — Git hooks inactive: core.hooksPath is '${state.value ?? ""}', ` +
    `set by ${describeHooksPathScope(state.scope)}`
  );
}

/**
 * #5798 — wiring-only residual (pin/install/readiness already ok).
 * Names Taskfile/probe surface; owned wiring damage → repair, never npm i -g hammer.
 */
export const WIRING_RECOVERY_GUIDANCE =
  "inspect Taskfile.yml / Directive wiring targets (or probe); for owned wiring damage: directive install --repair";

/**
 * Wiring damaged while the pinned runtime is installed (AC9.7 / AC14.14): the
 * shared message table's `wiring-damaged` row.
 */
export const WIRING_DAMAGED_RECOVERY_GUIDANCE = ENTRY_GUARD_MESSAGES["wiring-damaged"];

/** Patterns that must never appear as doctor remedies (AC12.5–12.7 / AC9.11). */
export const FORBIDDEN_DOCTOR_REMEDY_PATTERNS: readonly RegExp[] = [
  /\balign-pin\b/i,
  /\binstall-global\b/i,
  // Built from parts so shipped dist does not contain retired token literals (AC12.6).
  new RegExp(["accept", "engine", "jump"].join("-"), "i"),
  new RegExp(["DEFT", "ACCEPT", "ENGINE", "SKEW"].join("_")),
  new RegExp(["engine", "ladder"].join(" "), "i"),
  new RegExp(["skew", "window"].join(" "), "i"),
  /\bnpx\b/i,
  /pnpm\s+exec/i,
  /global product runtime/i,
  /npm i -g @deftai\/directive-runtime/i,
  /npm install -g @deftai\/directive-runtime/i,
];

export interface DoctorSurface {
  readonly ok: boolean;
  readonly detail: string | null;
  /**
   * Display state when there was nothing to check (#5967 / #6003: absent is
   * not ok). Display only: `ok` and the exit code are unchanged.
   */
  readonly display?: "not present";
}

export interface DoctorHookProbeResult {
  readonly ok: boolean;
  readonly detail: string;
  /** Default structural probe: no hook was actually run. Display only. */
  readonly display?: "not probed";
}

export interface DoctorDiagnosisInfo {
  readonly launcherPresent: boolean | null;
  readonly newerReleaseAvailable: boolean | null;
  readonly nodeBestEffortNote: string | null;
  /**
   * AC14.47 — GENERATION recorded PM vs project lockfile evidence disagree.
   * Information only; does not flip inSync / exitCode or select PM.
   */
  readonly generationPmDrift: string | null;
}

export interface DoctorDiagnosis {
  readonly inSync: boolean;
  readonly version: string | null;
  readonly failClosed: boolean;
  readonly dataStatus: DataStatusValue;
  /**
   * Install-class (AC9.7), wiring-only (#5798 WIRING_RECOVERY_GUIDANCE), or
   * F-010 git-precondition recovery. Null when healthy or schema-only.
   */
  readonly remedy: string | null;
  /** Schema/data migration remedy; never the AC9.7 global-install hammer. */
  readonly schemaRemedy: "directive upgrade" | null;
  /**
   * F-010: set when pin/lock/installed/GENERATION/wiring are ok but readiness is
   * withheld because the project has no `.git` (incomplete install / precondition).
   */
  readonly incompleteInstall: "git-precondition" | null;
  readonly surfaces: {
    readonly pin: DoctorSurface;
    readonly lockfile: DoctorSurface;
    readonly installed: DoctorSurface;
    readonly generation: DoctorSurface;
    readonly wiring: DoctorSurface;
    readonly readiness: DoctorSurface;
    readonly hookCommandForm: DoctorSurface;
    readonly skillPointers: DoctorSurface;
    readonly schemaCurrency: DoctorSurface;
  };
  readonly hookProbe: DoctorHookProbeResult | null;
  /**
   * Directive files hidden from git by an ignore rule or index flag (#6618).
   * Warnings only (exit-exempt). Null when the check was skipped (no git).
   */
  readonly hiddenFiles: readonly HiddenDirectiveFile[] | null;
  /**
   * #7029: absolute core.hooksPath outside this worktree. Warning only
   * (exit-exempt). Null when not set, relative, inside the worktree, or no git.
   */
  readonly hooksPathWarning: string | null;
  readonly info: DoctorDiagnosisInfo;
  readonly exitCode: 0 | 1;
}

export interface DoctorDiagnosisOptions {
  readonly launcherPresent?: boolean | null;
  readonly newerReleaseAvailable?: boolean | null;
  readonly nodeBestEffortNote?: string | null;
  /** When false, skip live hook spawn (unit tests). Default true. */
  readonly probeHooks?: boolean;
  /** Injected hook probe; must observe DEFT_DOCTOR_HOOK_DIAGNOSTIC. */
  readonly hookProbe?: (input: {
    readonly projectRoot: string;
    readonly env: NodeJS.ProcessEnv;
  }) => DoctorHookProbeResult;
  /** Injected hidden-file probe (tests); default runs read-only git probes. */
  readonly findHiddenFiles?: (projectRoot: string) => readonly HiddenDirectiveFile[] | null;
}

function surfaceFromPred(p: PredicateResult): DoctorSurface {
  return { ok: p.ok, detail: p.ok ? null : p.reason };
}

function schemaSurface(dataStatus: DataStatusValue): DoctorSurface {
  if (dataStatus === "current") return { ok: true, detail: null };
  if (dataStatus === "migration_needed") {
    return { ok: false, detail: "project data schema behind runtime; run directive upgrade" };
  }
  return { ok: false, detail: "project data schema diagnosis failed" };
}

/**
 * Cheap read-only check that committed hook/skill wiring uses host `.mjs` outer or package-relative form.
 * Does not spawn hooks; structural only (AC12.3 hook command form / skill pointers).
 */
function inspectHookAndSkillForm(projectRoot: string): {
  hookCommandForm: DoctorSurface;
  skillPointers: DoctorSurface;
} {
  const prefix = RUNTIME_PACKAGE_PATH_PREFIX.replace(/\/$/, "");
  const hookRelCandidates = [
    ".claude/settings.json",
    ".cursor/hooks.json",
    ".codex/hooks.json",
    ".grok/hooks/deft.json",
  ];
  const skillRelCandidates = [".agents/skills/deft/SKILL.md", "AGENTS.md"];

  let hookOk = true;
  let hookDetail: string | null = null;
  let sawHook = false;
  for (const rel of hookRelCandidates) {
    const abs = join(projectRoot, rel);
    if (!existsSync(abs)) continue;
    sawHook = true;
    try {
      const text = hostHookConfigEntryLines(readFileSync(abs, "utf8"));
      // #5994 / AC9.1: v261027 host `.mjs` outer is the registered form; pin hook-bin is spawned inside.
      const hasOuter = isHostHookOuterCommand(text);
      const hasPkg = text.includes(prefix) && text.includes("hook-bin");
      const hasLegacy =
        text.includes(".deft/core/") || /(^|[\s"`'])deft-hook([\s"`']|$)/.test(text);
      if (hasLegacy || !(hasOuter || hasPkg)) {
        hookOk = false;
        hookDetail = `${rel} does not use host .mjs outer or package-relative hook-bin form`;
        break;
      }
    } catch {
      hookOk = false;
      hookDetail = `${rel} unreadable`;
      break;
    }
  }
  if (!sawHook) {
    hookDetail = "no committed host hook configs present";
  }

  let skillOk = true;
  let skillDetail: string | null = null;
  let sawSkill = false;
  for (const rel of skillRelCandidates) {
    const abs = join(projectRoot, rel);
    if (!existsSync(abs)) continue;
    sawSkill = true;
    try {
      const text = readFileSync(abs, "utf8");
      // AGENTS.md: only the managed section is the skill-pointer surface (AC12.3).
      // Stale `.deft/core` prose outside the markers is user content (POST-CONV-DOC).
      let inspect = text;
      if (rel === "AGENTS.md") {
        if (!text.includes("deft:managed-section")) {
          continue;
        }
        const start = text.indexOf("<!-- deft:managed-section");
        const end = text.indexOf("<!-- /deft:managed-section -->");
        if (start < 0 || end < 0 || end < start) {
          skillOk = false;
          skillDetail = `${rel} managed section markers incomplete`;
          break;
        }
        inspect = text.slice(start, end + "<!-- /deft:managed-section -->".length);
      }
      if (!inspect.includes(prefix) || inspect.includes(".deft/core/")) {
        skillOk = false;
        skillDetail = `${rel} does not target ${RUNTIME_PACKAGE_PATH_PREFIX}`;
        break;
      }
    } catch {
      skillOk = false;
      skillDetail = `${rel} unreadable`;
      break;
    }
  }
  if (!sawSkill) {
    skillDetail = "no skill pointer / AGENTS managed section present";
  }

  return {
    hookCommandForm: {
      ok: hookOk || !sawHook,
      detail: hookOk ? (sawHook ? null : hookDetail) : hookDetail,
      ...(sawHook ? {} : { display: "not present" as const }),
    },
    skillPointers: {
      ok: skillOk || !sawSkill,
      detail: skillOk ? (sawSkill ? null : skillDetail) : skillDetail,
      ...(sawSkill ? {} : { display: "not present" as const }),
    },
  };
}

function defaultHookProbe(projectRoot: string): DoctorHookProbeResult {
  // Structural-only default: prove diagnostic env would be set; do not spawn in unit path.
  // Live smoke / probeAgentHooksLive exercises real commands under DEFT_DOCTOR_HOOK_DIAGNOSTIC.
  void projectRoot;
  return {
    ok: true,
    detail: `diagnostic env ${DEFT_DOCTOR_HOOK_DIAGNOSTIC}=1 (no live spawn in default probe)`,
    display: "not probed",
  };
}

function projectHasGitDir(projectRoot: string): boolean {
  return existsSync(join(projectRoot, ".git"));
}

type ProjectPmEvidence = "npm" | "pnpm";

/** Lockfile-based project PM evidence (mirrors setup detectPmFact; AC5.6 / AC14.47). */
function readProjectLockfilePm(projectRoot: string): ProjectPmEvidence | null {
  const hasPnpm = existsSync(join(projectRoot, "pnpm-lock.yaml"));
  const hasNpm = existsSync(join(projectRoot, "package-lock.json"));
  if (hasPnpm && !hasNpm) return "pnpm";
  if (hasNpm && !hasPnpm) return "npm";
  return null;
}

function readGenerationPackageManager(projectRoot: string): string | null {
  try {
    const raw = readFileSync(join(projectRoot, ".deft", "GENERATION.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const pm = (parsed as Record<string, unknown>).packageManager;
    return typeof pm === "string" && pm.trim() !== "" ? pm.trim() : null;
  } catch {
    return null;
  }
}

/**
 * AC14.47 — informational note when GENERATION.json PM ≠ project lockfile evidence.
 * GENERATION is never used to select PM (INIT-08 / AC5.6).
 */
export function detectGenerationPmDrift(projectRoot: string): string | null {
  const recorded = readGenerationPackageManager(projectRoot);
  if (recorded === null) return null;
  const recordedBase = recorded.split("@")[0]?.trim().toLowerCase() ?? "";
  if (recordedBase !== "npm" && recordedBase !== "pnpm") return null;
  const evidence = readProjectLockfilePm(projectRoot);
  if (evidence === null) return null;
  if (recordedBase === evidence) return null;
  const lockName = evidence === "pnpm" ? "pnpm-lock.yaml" : "package-lock.json";
  return (
    `GENERATION.json recorded setup with ${recordedBase}; ${lockName} is present ` +
    `(PM still chosen from project evidence)`
  );
}

/**
 * F-010 / C7: otherwise-healthy install with readiness withheld solely because
 * there is no `.git` (hooksPath cannot activate → wiring-ready not written).
 */
export function isNoGitReadinessGap(sync: FullInSyncResult, projectRoot: string): boolean {
  if (projectHasGitDir(projectRoot)) return false;
  if (sync.failClosed) return false;
  if (sync.predicates.readiness.ok) return false;
  const p = sync.predicates;
  return p.pin.ok && p.lockfile.ok && p.installed.ok && p.generation.ok && p.wiring.ok;
}

/**
 * #4960 / #5846: otherwise-healthy install with readiness withheld because
 * `core.hooksPath` points at another hooks folder. Returns that state, else null.
 * Read-only (reads Git config; never writes it).
 */
export function foreignHooksPathReadinessGap(
  sync: FullInSyncResult,
  projectRoot: string,
): HooksPathState | null {
  if (!projectHasGitDir(projectRoot)) return null;
  if (sync.failClosed) return null;
  if (sync.predicates.readiness.ok) return null;
  const p = sync.predicates;
  if (!(p.pin.ok && p.lockfile.ok && p.installed.ok && p.generation.ok && p.wiring.ok)) {
    return null;
  }
  const state = readHooksPathState(projectRoot);
  return state.kind === "foreign" ? state : null;
}

export function isForeignHooksPathReadinessGap(
  sync: FullInSyncResult,
  projectRoot: string,
): boolean {
  return foreignHooksPathReadinessGap(sync, projectRoot) !== null;
}

function chooseRemedy(
  sync: FullInSyncResult,
  dataStatus: DataStatusValue,
  projectRoot: string,
): { remedy: string | null; schemaRemedy: "directive upgrade" | null } {
  // F-010: incomplete no-git install — do not lead with AC9.7 global reinstall.
  if (isNoGitReadinessGap(sync, projectRoot)) {
    return { remedy: GIT_PRECONDITION_RECOVERY_GUIDANCE, schemaRemedy: null };
  }
  // #4960 / #5846: another hooks folder — repair shows the takeover and asks once.
  if (isForeignHooksPathReadinessGap(sync, projectRoot)) {
    const schemaBehind = dataStatus === "migration_needed" || dataStatus === "diagnosis_failed";
    return {
      remedy: FOREIGN_HOOKS_PATH_RECOVERY_GUIDANCE,
      schemaRemedy: schemaBehind ? "directive upgrade" : null,
    };
  }

  const p = sync.predicates;
  // AC9.7 (v261118): one next command per failure class; never global + repair,
  // and never repair and upgrade together for an install-class red (AC12.7).
  const schemaBehind = dataStatus === "migration_needed" || dataStatus === "diagnosis_failed";
  const install = projectInstallCommand(projectRoot);
  if (sync.failClosed) {
    // Installed runtime is not the pinned version → the project install.
    return {
      remedy: formatEntryGuardMessage("pin-mismatch", {
        install,
        pin: sync.version ?? undefined,
        installed: p.installed.version ?? undefined,
      }),
      schemaRemedy: null,
    };
  }
  if (!p.pin.ok) {
    // Range, tag or unreadable pin: the user rectifies package.json (D-042).
    const spec = readRuntimePin(projectRoot).rawSpec ?? "";
    return {
      remedy: formatEntryGuardMessage("pin-invalid", pinInvalidValues(projectRoot, spec)),
      schemaRemedy: null,
    };
  }
  if (!p.installed.ok) {
    // Runtime missing → the project install.
    return { remedy: formatEntryGuardMessage("runtime-missing", { install }), schemaRemedy: null };
  }
  const wiringBroken = !p.wiring.ok;
  // Lockfile disagrees (AC14.14), GENERATION or readiness missing (with .git):
  // wiring with the right runtime installed → repair.
  if (!p.lockfile.ok || !p.generation.ok || !p.readiness.ok) {
    return { remedy: WIRING_DAMAGED_RECOVERY_GUIDANCE, schemaRemedy: null };
  }

  // Wiring-only (good pin/install/readiness): failure-shaped map — Taskfile/probe, not npm i -g.
  if (wiringBroken) {
    return {
      remedy: WIRING_RECOVERY_GUIDANCE,
      // Distinct surfaces may list both (#5798 multi-surface); not the AC9.7+upgrade dual ban.
      schemaRemedy: schemaBehind ? "directive upgrade" : null,
    };
  }

  if (schemaBehind) {
    return { remedy: null, schemaRemedy: "directive upgrade" };
  }
  return { remedy: null, schemaRemedy: null };
}

/**
 * Full read-only diagnosis. Never creates/updates files or Git config.
 */
export function runDoctorDiagnosis(
  projectRoot: string,
  options: DoctorDiagnosisOptions = {},
): DoctorDiagnosis {
  const sync = checkFullInSync(projectRoot);
  const dataStatusResult = readProjectDataStatus(projectRoot);
  const dataStatus = dataStatusResult.dataStatus;
  const form = inspectHookAndSkillForm(projectRoot);

  let hookProbe: DoctorHookProbeResult | null = null;
  if (options.probeHooks !== false) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      [DEFT_DOCTOR_HOOK_DIAGNOSTIC]: "1",
    };
    const probe = options.hookProbe ?? ((input) => defaultHookProbe(input.projectRoot));
    hookProbe = probe({ projectRoot, env });
  }

  const hiddenFiles = (
    options.findHiddenFiles ?? ((root: string) => findHiddenDirectiveFiles(root))
  )(projectRoot);
  const gitPrecondition = isNoGitReadinessGap(sync, projectRoot);
  const { remedy, schemaRemedy } = chooseRemedy(sync, dataStatus, projectRoot);
  const healthy =
    sync.inSync && dataStatus === "current" && form.hookCommandForm.ok && form.skillPointers.ok;

  const foreignHooks = gitPrecondition ? null : foreignHooksPathReadinessGap(sync, projectRoot);
  const readinessSurface = gitPrecondition
    ? { ok: false, detail: GIT_PRECONDITION_READINESS_DETAIL }
    : foreignHooks !== null
      ? { ok: false, detail: formatForeignHooksPathReadinessDetail(foreignHooks) }
      : surfaceFromPred(sync.predicates.readiness);

  return {
    inSync: sync.inSync,
    version: sync.version,
    failClosed: sync.failClosed,
    dataStatus,
    remedy,
    schemaRemedy,
    incompleteInstall: gitPrecondition ? "git-precondition" : null,
    surfaces: {
      pin: surfaceFromPred(sync.predicates.pin),
      lockfile: surfaceFromPred(sync.predicates.lockfile),
      installed: surfaceFromPred(sync.predicates.installed),
      generation: surfaceFromPred(sync.predicates.generation),
      wiring: surfaceFromPred(sync.predicates.wiring),
      readiness: readinessSurface,
      hookCommandForm: form.hookCommandForm,
      skillPointers: form.skillPointers,
      schemaCurrency: schemaSurface(dataStatus),
    },
    hookProbe,
    hiddenFiles,
    hooksPathWarning: hooksPathOutsideWorktreeWarning(projectRoot),
    info: {
      launcherPresent: options.launcherPresent ?? null,
      newerReleaseAvailable: options.newerReleaseAvailable ?? null,
      nodeBestEffortNote: options.nodeBestEffortNote ?? null,
      generationPmDrift: detectGenerationPmDrift(projectRoot),
    },
    exitCode: healthy ? 0 : 1,
  };
}

function line(ok: boolean, name: string, detail: string | null, display?: string): string {
  const mark = display ?? (ok ? "ok" : "FAIL");
  return detail ? `  ${name}: ${mark} — ${detail}` : `  ${name}: ${mark}`;
}

/** True when the install-sync section names the project install as the next command. */
function needsProjectInstall(diag: DoctorDiagnosis): boolean {
  return diag.failClosed || (diag.surfaces.pin.ok && !diag.surfaces.installed.ok);
}

/** Final overall line after the install-sync and product sections (#5967 / #6003). */
export const DOCTOR_OVERALL_OK = "directive doctor: OK";
export const DOCTOR_OVERALL_PROBLEMS = "directive doctor: problems found (see above)";

/** Overall verdict from the worse of the install-sync and product exit codes. */
export function formatDoctorOverallLine(installSyncExit: number, productExit: number): string {
  return installSyncExit === 0 && productExit === 0 ? DOCTOR_OVERALL_OK : DOCTOR_OVERALL_PROBLEMS;
}

/** Machine form of the install-sync section for `doctor --json` (#6004). */
export function doctorDiagnosisJson(diag: DoctorDiagnosis): Record<string, unknown> {
  return {
    in_sync: diag.inSync,
    exit_code: diag.exitCode,
    version: diag.version,
    fail_closed: diag.failClosed,
    data_status: diag.dataStatus,
    remedy: diag.remedy,
    schema_remedy: diag.schemaRemedy,
    incomplete_install: diag.incompleteInstall,
    surfaces: diag.surfaces,
    hook_probe: diag.hookProbe,
    hidden_files: diag.hiddenFiles,
    warnings: [
      ...(diag.hiddenFiles ?? []).map(formatHiddenDirectiveFileWarning),
      ...(diag.hooksPathWarning !== null ? [diag.hooksPathWarning] : []),
    ],
    info: diag.info,
  };
}

/**
 * Human-readable install-sync section (AC12.3 / AC12.5 / F-010). The overall
 * verdict is a separate final line (formatDoctorOverallLine), so this header
 * never claims the whole doctor run is fine (#5967 / #6003).
 */
export function formatDoctorReport(diag: DoctorDiagnosis): string {
  const lines: string[] = [];
  if (diag.exitCode === 0) {
    lines.push("Install sync: in sync");
    lines.push("");
    lines.push("This project's Directive version and wiring look consistent.");
  } else if (diag.incompleteInstall === "git-precondition") {
    lines.push("Install sync: incomplete install (git precondition)");
    lines.push("");
    lines.push("This folder is not a git repository yet, so git hooks were not installed.");
    lines.push("");
    lines.push("Next:");
    lines.push("  git init");
    lines.push("  directive install --repair");
  } else {
    lines.push("Install sync: not in sync");
    lines.push("");
    if (needsProjectInstall(diag) && diag.remedy) {
      // The shared table row names the problem and the one project install.
      lines.push(`Next: ${diag.remedy}`);
      lines.push("");
    }
  }

  if (diag.version) lines.push(`  version: ${diag.version}`);
  lines.push(line(diag.surfaces.pin.ok, "pin", diag.surfaces.pin.detail));
  lines.push(line(diag.surfaces.lockfile.ok, "lockfile", diag.surfaces.lockfile.detail));
  lines.push(line(diag.surfaces.installed.ok, "installed", diag.surfaces.installed.detail));
  lines.push(line(diag.surfaces.generation.ok, "GENERATION.json", diag.surfaces.generation.detail));
  lines.push(line(diag.surfaces.wiring.ok, "wiring", diag.surfaces.wiring.detail));
  lines.push(line(diag.surfaces.readiness.ok, "readiness", diag.surfaces.readiness.detail));
  lines.push(
    line(
      diag.surfaces.hookCommandForm.ok,
      "hook command form",
      diag.surfaces.hookCommandForm.detail,
      diag.surfaces.hookCommandForm.display,
    ),
  );
  lines.push(
    line(
      diag.surfaces.skillPointers.ok,
      "skill pointers",
      diag.surfaces.skillPointers.detail,
      diag.surfaces.skillPointers.display,
    ),
  );
  lines.push(
    line(
      diag.surfaces.schemaCurrency.ok,
      "xbrief/schema currency",
      diag.surfaces.schemaCurrency.detail,
    ),
  );
  if (diag.hookProbe) {
    lines.push(
      line(diag.hookProbe.ok, "hook probe", diag.hookProbe.detail, diag.hookProbe.display),
    );
  }
  for (const hidden of diag.hiddenFiles ?? []) {
    lines.push(`  warning: ${formatHiddenDirectiveFileWarning(hidden)}`);
  }
  if (diag.hooksPathWarning !== null) {
    lines.push(`  warning: ${diag.hooksPathWarning}`);
  }
  if (diag.info.launcherPresent !== null) {
    lines.push(`  launcher present: ${diag.info.launcherPresent ? "yes" : "no"} (information)`);
  }
  if (diag.info.newerReleaseAvailable !== null) {
    lines.push(
      `  newer release available: ${diag.info.newerReleaseAvailable ? "yes" : "no"} (information)`,
    );
  }
  if (diag.info.nodeBestEffortNote) {
    lines.push(`  node: ${diag.info.nodeBestEffortNote} (information)`);
  }
  if (diag.info.generationPmDrift) {
    lines.push(`  PM drift: ${diag.info.generationPmDrift} (information)`);
  }
  if (diag.schemaRemedy) {
    lines.push(`Next: ${diag.schemaRemedy}`);
  }
  // The project-install Next: block above already names the remedy.
  if (diag.remedy && diag.incompleteInstall !== "git-precondition" && !needsProjectInstall(diag)) {
    lines.push(`Recovery: ${diag.remedy}`);
  }
  return `${lines.join("\n")}\n`;
}
