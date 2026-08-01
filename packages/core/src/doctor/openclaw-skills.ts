/**
 * OpenClaw always-pin skill detect + doctor --fix wire (#3001 / #3008).
 *
 * When OpenClaw signals are present, doctor checks the main workspace skills
 * root for the four always-pin skills (#2508). Missing pins emit a warning with
 * remediation `deft doctor --fix`. Under fixMode, pins are **copied** into the
 * workspace skills root (not symlinked into the npm content package).
 *
 * OpenClaw 2026.7.x rejects workspace skills that resolve outside the configured
 * skills root (`reason=symlink-escape`). A pin that is only a symlink into
 * `@deftai/directive-content` therefore looks "present" on disk while the host
 * never loads it (#3008). Prefer real directory copies; treat escaping
 * symlinks as divergent so `--fix` can replace them.
 *
 * Multi-seat (`workspace-*`) targets only when `--openclaw-all-agents` is set.
 */

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { contentRoot } from "../content-root.js";
import type { OutputSink } from "./output.js";
import type { DoctorSeams, Finding } from "./types.js";

/** Stable doctor check id for JSON findings. */
export const OPENCLAW_SKILL_PINS_CHECK = "openclaw-skill-pins";

/** Always-pin skill directory names (#2508 / cold-start). */
export const OPENCLAW_ALWAYS_PIN_SKILLS = [
  "deft-directive-build",
  "deft-directive-pre-pr",
  "deft-directive-review-cycle",
  "deft-directive-swarm",
] as const;

export type OpenClawAlwaysPinSkill = (typeof OPENCLAW_ALWAYS_PIN_SKILLS)[number];

/** Env keys that count as strong OpenClaw signals (#3001). */
export const OPENCLAW_ENV_SIGNAL_KEYS = [
  "OPENCLAW",
  "DEFT_PROBE_OPENCLAW",
  "DEFT_AGENT_RUNTIME",
  "OPENCLAW_STATE_DIR",
] as const;

const DOC_OPENCLAW_HOST = "docs/openclaw-agent-host.md";
const DOC_HOST_LIFECYCLE = "contracts/host-lifecycle-duties.md";
const DOC_SKILL_PINS = "docs/skill-pin-policy.md";
const REMEDIATION_FIX = "deft doctor --fix";
const REMEDIATION_ALL_AGENTS = "deft doctor --fix --openclaw-all-agents";

export interface OpenClawSkillPinsSeams {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: () => string;
  readonly isDir?: (path: string) => boolean;
  readonly isFile?: (path: string) => boolean;
  readonly pathExists?: (path: string) => boolean;
  readonly readDir?: (path: string) => string[];
  readonly lstatKind?: (path: string) => "file" | "dir" | "symlink" | "other" | "missing";
  readonly mkdirp?: (path: string) => void;
  readonly symlinkDir?: (target: string, path: string) => void;
  readonly copyDir?: (src: string, dst: string) => void;
  readonly removePath?: (path: string) => void;
  readonly renamePath?: (from: string, to: string) => void;
  readonly contentRootFor?: (frameworkRoot: string) => string;
  readonly isTty?: () => boolean;
  readonly readYn?: (prompt: string, defaultYes: boolean) => boolean;
}

export interface OpenClawPinAssessment {
  readonly skillsDir: string;
  readonly present: readonly OpenClawAlwaysPinSkill[];
  readonly missing: readonly OpenClawAlwaysPinSkill[];
  readonly divergent: readonly OpenClawAlwaysPinSkill[];
}

export interface OpenClawDetectResult {
  readonly detected: boolean;
  readonly reasons: readonly string[];
  readonly stateDir: string;
  readonly mainSkillsDir: string;
}

export type PinInstallMethod = "symlink" | "copy" | "skipped" | "already-present";

export interface PinInstallResult {
  readonly skillId: OpenClawAlwaysPinSkill;
  readonly method: PinInstallMethod;
  readonly target: string;
  readonly source: string;
  readonly detail?: string;
}

function defaultIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function defaultIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function defaultPathExists(path: string): boolean {
  return existsSync(path);
}

function defaultLstatKind(path: string): "file" | "dir" | "symlink" | "other" | "missing" {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) return "symlink";
    if (st.isDirectory()) return "dir";
    if (st.isFile()) return "file";
    return "other";
  } catch {
    return "missing";
  }
}

function defaultReadDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function envTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  if (v === "" || v === "0" || v === "false" || v === "no" || v === "off") return false;
  return true;
}

/**
 * Resolve OpenClaw state directory: OPENCLAW_STATE_DIR or ~/.openclaw.
 */
export function resolveOpenClawStateDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const fromEnv = env.OPENCLAW_STATE_DIR?.trim();
  if (fromEnv) return resolve(fromEnv);
  return resolve(home, ".openclaw");
}

/**
 * Main agent workspace skills root under the state dir.
 */
export function resolveMainSkillsDir(stateDir: string): string {
  return join(stateDir, "workspace", "skills");
}

/**
 * Detect OpenClaw from env signals and/or presence of the state directory.
 */
export function detectOpenClaw(
  env: NodeJS.ProcessEnv = process.env,
  options: { homeDir?: string; isDir?: (path: string) => boolean } = {},
): OpenClawDetectResult {
  const home = options.homeDir ?? homedir();
  const isDir = options.isDir ?? defaultIsDir;
  const stateDir = resolveOpenClawStateDir(env, home);
  const reasons: string[] = [];

  if (envTruthy(env.OPENCLAW)) reasons.push("env:OPENCLAW");
  if (envTruthy(env.DEFT_PROBE_OPENCLAW)) reasons.push("env:DEFT_PROBE_OPENCLAW");
  if ((env.DEFT_AGENT_RUNTIME ?? "").trim().toLowerCase() === "openclaw") {
    reasons.push("env:DEFT_AGENT_RUNTIME=openclaw");
  }
  if (env.OPENCLAW_STATE_DIR?.trim()) reasons.push("env:OPENCLAW_STATE_DIR");
  if (isDir(stateDir)) reasons.push(`dir:${stateDir}`);

  return {
    detected: reasons.length > 0,
    reasons,
    stateDir,
    mainSkillsDir: resolveMainSkillsDir(stateDir),
  };
}

/**
 * List in-scope skills directories. Default: main only.
 * With allAgents: main + every workspace- star /skills under the state dir.
 */
export function listInScopeSkillsDirs(
  stateDir: string,
  allAgents: boolean,
  seams: Pick<OpenClawSkillPinsSeams, "isDir" | "readDir"> = {},
): string[] {
  const isDir = seams.isDir ?? defaultIsDir;
  const readDir = seams.readDir ?? defaultReadDir;
  const main = resolveMainSkillsDir(stateDir);
  const dirs = [main];
  if (!allAgents) return dirs;

  for (const name of readDir(stateDir)) {
    if (!name.startsWith("workspace-")) continue;
    const workspaceDir = join(stateDir, name);
    if (!isDir(workspaceDir)) continue;
    const skillsDir = join(workspaceDir, "skills");
    if (!dirs.includes(skillsDir)) dirs.push(skillsDir);
  }
  return dirs;
}

/**
 * Resolve content package skills/<id> for a pin.
 */
export function resolvePinSourceDir(contentBase: string, skillId: string): string {
  return join(contentBase, "skills", skillId);
}

function skillHasBody(
  skillDir: string,
  isFile: (path: string) => boolean,
  isDir: (path: string) => boolean,
): boolean {
  if (!isDir(skillDir) && !existsSync(skillDir)) return false;
  // Accept dir or symlink-to-dir that contains SKILL.md
  return isFile(join(skillDir, "SKILL.md"));
}

/**
 * True when both dirs have SKILL.md with identical bytes (pin still current
 * after package upgrade). False / unreadable → treat as stale (#3008 P1).
 */
function skillBodyMatchesPackage(
  sourceDir: string,
  targetDir: string,
  isFile: (path: string) => boolean,
): boolean {
  const src = join(sourceDir, "SKILL.md");
  const dst = join(targetDir, "SKILL.md");
  if (!isFile(src) || !isFile(dst)) return false;
  try {
    return readFileSync(src, "utf8") === readFileSync(dst, "utf8");
  } catch {
    return false;
  }
}

/**
 * True when `path` is a symlink whose resolved real path is outside `skillsDir`
 * (OpenClaw `symlink-escape` / #3008).
 */
export function isEscapingSkillSymlink(
  skillsDir: string,
  path: string,
  seams: Pick<OpenClawSkillPinsSeams, "lstatKind"> = {},
): boolean {
  const lstatKind = seams.lstatKind ?? defaultLstatKind;
  if (lstatKind(path) !== "symlink") return false;
  try {
    const skillsReal = realpathSync(skillsDir);
    const pathReal = realpathSync(path);
    const rel = relative(skillsReal, pathReal);
    // Outside root, or walks up with ".."
    return rel === "" || rel.startsWith(`..${sep}`) || rel.startsWith("..") || rel === "..";
  } catch {
    // Broken symlink / unreadable realpath — treat as escape / unusable.
    return true;
  }
}

/**
 * Assess which always-pins are present / missing / divergent in a skills root.
 *
 * - present: real directory (or non-escaping symlink) with SKILL.md matching
 *   the content package when `contentBase` is supplied
 * - missing: path does not exist
 * - divergent: path exists but is not a usable OpenClaw pin (file, empty dir,
 *   broken link, **escaping symlink**, or **stale SKILL.md** vs package — #3008)
 */
export function assessOpenClawPins(
  skillsDir: string,
  seams: Pick<OpenClawSkillPinsSeams, "isDir" | "isFile" | "pathExists" | "lstatKind"> = {},
  options: { contentBase?: string } = {},
): OpenClawPinAssessment {
  const isDir = seams.isDir ?? defaultIsDir;
  const isFile = seams.isFile ?? defaultIsFile;
  const pathExists = seams.pathExists ?? defaultPathExists;
  const lstatKind = seams.lstatKind ?? defaultLstatKind;
  const contentBase = options.contentBase;

  const present: OpenClawAlwaysPinSkill[] = [];
  const missing: OpenClawAlwaysPinSkill[] = [];
  const divergent: OpenClawAlwaysPinSkill[] = [];

  for (const skillId of OPENCLAW_ALWAYS_PIN_SKILLS) {
    const target = join(skillsDir, skillId);
    const kind = lstatKind(target);
    if (kind === "missing") {
      missing.push(skillId);
      continue;
    }
    // Escaping symlink: SKILL.md may resolve, but OpenClaw skips load (#3008).
    if (kind === "symlink" && isEscapingSkillSymlink(skillsDir, target, { lstatKind })) {
      divergent.push(skillId);
      continue;
    }
    if (skillHasBody(target, isFile, isDir)) {
      if (contentBase) {
        const sourceDir = resolvePinSourceDir(contentBase, skillId);
        if (!skillBodyMatchesPackage(sourceDir, target, isFile)) {
          // Stale copy after package upgrade — surface as divergent so doctor
          // does not report "present" and skip repair (#3008 Greptile P1).
          divergent.push(skillId);
          continue;
        }
      }
      present.push(skillId);
      continue;
    }
    // Path exists but is not a usable pin body (file, empty dir, broken link).
    if (kind === "file" || kind === "other" || kind === "dir" || kind === "symlink") {
      divergent.push(skillId);
      continue;
    }
    if (!pathExists(target)) {
      missing.push(skillId);
      continue;
    }
    divergent.push(skillId);
  }

  return { skillsDir, present, missing, divergent };
}

function trySymlinkDir(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, "dir");
    return true;
  } catch {
    // Windows: junctions do not require elevated privileges for directories.
    try {
      symlinkSync(target, path, "junction");
      return true;
    } catch {
      return false;
    }
  }
}

function defaultCopyDir(src: string, dst: string): void {
  cpSync(src, dst, { recursive: true });
}

/**
 * Install one pin into a skills root.
 *
 * Default: **copy** into the workspace skills root (#3008). OpenClaw rejects
 * skills that resolve outside the workspace skills root via symlink-escape, so
 * symlinking into the npm content package leaves pins unloaded while doctor
 * reports "present". Opt into legacy symlink-first with `preferSymlink: true`
 * (still falls back to copy). Never deletes unrelated user skills. Divergent
 * targets (including escaping symlinks) require force or TTY confirm.
 *
 * Stale copies (SKILL.md differs from package) are not "already-present" —
 * doctor --fix refreshes them so upgrades land without manual delete (#3008 P1).
 * Forced replace stages into a sibling temp dir first so a failed copy does not
 * leave the pin permanently deleted (#3008 P1).
 */
export function installOpenClawPin(
  skillId: OpenClawAlwaysPinSkill,
  sourceDir: string,
  skillsDir: string,
  options: {
    force?: boolean;
    allowOverwrite?: boolean;
    /** When true, try symlink first (legacy #3001). Default false — copy (#3008). */
    preferSymlink?: boolean;
    /**
     * When true, refresh copied pins whose SKILL.md no longer matches the
     * package (package upgrade path). Doctor --fix sets this.
     */
    refreshStale?: boolean;
  } = {},
  seams: OpenClawSkillPinsSeams = {},
): PinInstallResult {
  const isFile = seams.isFile ?? defaultIsFile;
  const isDir = seams.isDir ?? defaultIsDir;
  const lstatKind = seams.lstatKind ?? defaultLstatKind;
  const mkdirp = seams.mkdirp ?? ((p: string) => mkdirSync(p, { recursive: true }));
  const symlinkDir =
    seams.symlinkDir ??
    ((target: string, path: string) => {
      if (!trySymlinkDir(target, path)) {
        throw new Error(`symlink failed for ${path}`);
      }
    });
  const copyDir = seams.copyDir ?? defaultCopyDir;
  const removePath =
    seams.removePath ?? ((p: string) => rmSync(p, { recursive: true, force: true }));
  const renamePath = seams.renamePath ?? ((from: string, to: string) => renameSync(from, to));

  const target = join(skillsDir, skillId);
  const force = options.force === true || options.allowOverwrite === true;
  const preferSymlink = options.preferSymlink === true;
  const refreshStale = options.refreshStale === true;

  if (!isDir(sourceDir) || !isFile(join(sourceDir, "SKILL.md"))) {
    return {
      skillId,
      method: "skipped",
      target,
      source: sourceDir,
      detail: `source pin missing or incomplete: ${sourceDir}`,
    };
  }

  mkdirp(skillsDir);

  const kind = lstatKind(target);
  if (kind !== "missing") {
    const escaping = kind === "symlink" && isEscapingSkillSymlink(skillsDir, target, { lstatKind });
    if (!escaping && skillHasBody(target, isFile, isDir)) {
      const matches = skillBodyMatchesPackage(sourceDir, target, isFile);
      if (matches) {
        return {
          skillId,
          method: "already-present",
          target,
          source: sourceDir,
        };
      }
      // Stale copy after package upgrade — refresh under --fix / force.
      if (!force && !refreshStale) {
        return {
          skillId,
          method: "skipped",
          target,
          source: sourceDir,
          detail:
            "stale pin (SKILL.md differs from content package); re-run with --force or doctor --fix to refresh",
        };
      }
      // fall through to safe replace
    } else if (!force) {
      return {
        skillId,
        method: "skipped",
        target,
        source: sourceDir,
        detail: escaping
          ? "escaping symlink (OpenClaw symlink-escape); re-run with --force to replace with a real copy (#3008)"
          : "divergent target exists; re-run with --force or confirm on TTY to replace",
      };
    }
  }

  if (preferSymlink && kind === "missing") {
    try {
      symlinkDir(sourceDir, target);
      return { skillId, method: "symlink", target, source: sourceDir };
    } catch {
      // fall through to copy
    }
  }

  // Exclusive lock dir serializes concurrent doctor --fix on the same pin
  // (non-recursive mkdir fails with EEXIST — atomic on win32 + posix). Without
  // it, two processes can interleave renames and leave the older staged copy
  // as the final target (#3008 P1). Stale locks (crash before release) older
  // than 5 minutes are reclaimed so future doctor --fix is not blocked forever.
  const lockDir = `${target}.deft-lock`;
  const STALE_LOCK_MS = 5 * 60 * 1000;
  const tryAcquireLock = (): boolean => {
    try {
      mkdirSync(lockDir);
      return true;
    } catch {
      try {
        const ageMs = Date.now() - statSync(lockDir).mtimeMs;
        if (ageMs >= STALE_LOCK_MS) {
          rmSync(lockDir, { recursive: true, force: true });
          mkdirSync(lockDir);
          return true;
        }
      } catch {
        // lock vanished between races — retry once below
        try {
          mkdirSync(lockDir);
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }
  };
  if (!tryAcquireLock()) {
    return {
      skillId,
      method: "skipped",
      target,
      source: sourceDir,
      detail: "another doctor process is installing this pin; re-run after it finishes",
    };
  }

  const releaseLock = (): void => {
    try {
      removePath(lockDir);
    } catch {
      // ignore
    }
  };

  // Stage copy first so a failed install never deletes the prior target without
  // a replacement ready (#3008 Greptile P1: failed copies lose replaced targets).
  // Unique suffix avoids leftover collision if a prior crash left staging files.
  const swapId = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const staging = `${target}.deft-installing-${swapId}`;
  try {
    removePath(staging);
  } catch {
    // ignore missing staging
  }
  try {
    copyDir(sourceDir, staging);
  } catch (err) {
    try {
      removePath(staging);
    } catch {
      // ignore cleanup
    }
    releaseLock();
    return {
      skillId,
      method: "skipped",
      target,
      source: sourceDir,
      detail: `install failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Re-check under the lock: another process may have already refreshed to a
  // matching real copy. Escaping symlinks still match SKILL.md bytes through
  // the link — never short-circuit those; they must become real copies.
  const kindUnderLock = lstatKind(target);
  const escapingUnderLock =
    kindUnderLock === "symlink" && isEscapingSkillSymlink(skillsDir, target, { lstatKind });
  if (
    kindUnderLock !== "missing" &&
    !escapingUnderLock &&
    skillHasBody(target, isFile, isDir) &&
    skillBodyMatchesPackage(sourceDir, target, isFile)
  ) {
    try {
      removePath(staging);
    } catch {
      // ignore
    }
    releaseLock();
    return {
      skillId,
      method: "already-present",
      target,
      source: sourceDir,
    };
  }

  const backup = kindUnderLock !== "missing" ? `${target}.deft-backup-${swapId}` : null;
  try {
    if (backup !== null) {
      try {
        removePath(backup);
      } catch {
        // ignore
      }
      renamePath(target, backup);
    }
    renamePath(staging, target);
    if (backup !== null) {
      try {
        removePath(backup);
      } catch {
        // leftover backup is harmless
      }
    }
    releaseLock();
    return { skillId, method: "copy", target, source: sourceDir };
  } catch (err) {
    // Restore backup if we moved it away and the swap failed.
    try {
      removePath(staging);
    } catch {
      // ignore
    }
    if (backup !== null && lstatKind(target) === "missing" && lstatKind(backup) !== "missing") {
      try {
        renamePath(backup, target);
      } catch {
        // best-effort restore
      }
    }
    releaseLock();
    return {
      skillId,
      method: "skipped",
      target,
      source: sourceDir,
      detail: `install failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export interface RunOpenClawSkillPinsOptions {
  readonly frameworkRoot: string;
  readonly fixMode: boolean;
  readonly jsonMode: boolean;
  readonly force: boolean;
  readonly allAgents: boolean;
  readonly seams?: DoctorSeams & OpenClawSkillPinsSeams;
}

/**
 * Doctor check: detect OpenClaw + missing always-pins; optionally fix.
 * No-ops when OpenClaw signals are absent.
 */
export function runOpenClawSkillPinsCheck(
  sink: OutputSink,
  addFinding: (finding: Finding) => void,
  options: RunOpenClawSkillPinsOptions,
): void {
  const seams = options.seams ?? {};
  const env = seams.env ?? process.env;
  const homeDir = seams.homeDir ?? (() => homedir());
  const isDir = seams.isDir ?? defaultIsDir;
  const isFile = seams.isFile ?? defaultIsFile;
  const detect = detectOpenClaw(env, { homeDir: homeDir(), isDir });

  if (!detect.detected) {
    sink.info(`${OPENCLAW_SKILL_PINS_CHECK}: skip -- OpenClaw not detected`);
    addFinding({
      severity: "skip",
      message: "OpenClaw not detected",
      check: OPENCLAW_SKILL_PINS_CHECK,
      status: "skip",
      reason: "openclaw-not-detected",
    });
    return;
  }

  const contentBase = (seams.contentRootFor ?? contentRoot)(options.frameworkRoot);
  const skillsDirs = listInScopeSkillsDirs(detect.stateDir, options.allAgents, {
    isDir,
    readDir: seams.readDir,
  });

  const missingByDir: Array<{ skillsDir: string; missing: OpenClawAlwaysPinSkill[] }> = [];
  const divergentByDir: Array<{ skillsDir: string; divergent: OpenClawAlwaysPinSkill[] }> = [];
  let allPresent = true;

  for (const skillsDir of skillsDirs) {
    const assessment = assessOpenClawPins(
      skillsDir,
      { isDir, isFile, lstatKind: seams.lstatKind },
      { contentBase },
    );
    if (assessment.missing.length > 0) {
      allPresent = false;
      missingByDir.push({ skillsDir, missing: [...assessment.missing] });
    }
    if (assessment.divergent.length > 0) {
      allPresent = false;
      divergentByDir.push({ skillsDir, divergent: [...assessment.divergent] });
    }
  }

  if (allPresent) {
    const scope = options.allAgents ? "main + workspace-* seats" : "main workspace";
    const message =
      `${OPENCLAW_SKILL_PINS_CHECK}: OpenClaw host always-pins present ` +
      `(${OPENCLAW_ALWAYS_PIN_SKILLS.join(", ")}) in ${scope}`;
    sink.success(message);
    addFinding({
      severity: "skip",
      message,
      check: OPENCLAW_SKILL_PINS_CHECK,
      status: "present",
      skills_dirs: skillsDirs,
      pins: [...OPENCLAW_ALWAYS_PIN_SKILLS],
      detect_reasons: detect.reasons,
    });
    return;
  }

  // Optional fix path
  const installResults: PinInstallResult[] = [];
  if (options.fixMode) {
    const isTty = seams.isTty ?? (() => process.stdin.isTTY === true);
    const readYn = seams.readYn ?? (() => false);
    let allowFix = true;
    if (!options.jsonMode && isTty()) {
      allowFix = readYn(
        `Wire missing OpenClaw always-pin skills into ${skillsDirs.join(", ")} now?`,
        true,
      );
      if (!allowFix) {
        sink.info("Skipped OpenClaw pin wire -- re-run `deft doctor --fix` when ready.");
      }
    }
    // Non-interactive --fix applies additive installs (safe); divergent needs --force.
    if (allowFix) {
      for (const skillsDir of skillsDirs) {
        const assessment = assessOpenClawPins(
          skillsDir,
          {
            isDir,
            isFile,
            lstatKind: seams.lstatKind,
          },
          { contentBase },
        );
        const toInstall = new Set<OpenClawAlwaysPinSkill>([
          ...assessment.missing,
          ...(options.force ? assessment.divergent : []),
        ]);
        // Stale pins (SKILL.md ≠ package) are classified divergent; under --fix
        // refresh them without TTY confirm (safe overwrite of our own pins).
        if (!options.force) {
          for (const skillId of assessment.divergent) {
            const sourceDir = resolvePinSourceDir(contentBase, skillId);
            const target = join(skillsDir, skillId);
            if (
              skillHasBody(target, isFile, isDir) &&
              !skillBodyMatchesPackage(sourceDir, target, isFile)
            ) {
              toInstall.add(skillId);
              continue;
            }
            if (isTty() && !options.jsonMode) {
              if (
                readYn(
                  `Replace divergent OpenClaw skill dir ${join(skillsDir, skillId)} with pin from content package?`,
                  false,
                )
              ) {
                toInstall.add(skillId);
              }
            }
          }
        }
        for (const skillId of toInstall) {
          const sourceDir = resolvePinSourceDir(contentBase, skillId);
          const result = installOpenClawPin(
            skillId,
            sourceDir,
            skillsDir,
            {
              force: options.force || assessment.divergent.includes(skillId),
              refreshStale: true,
            },
            seams,
          );
          installResults.push(result);
          if (result.method === "symlink" || result.method === "copy") {
            sink.success(
              `OpenClaw pin ${skillId}: ${result.method} → ${result.target}${
                result.method === "symlink" ? ` (from ${result.source})` : ""
              }`,
            );
          } else if (result.method === "already-present") {
            sink.info(`OpenClaw pin ${skillId}: already present at ${result.target}`);
          } else {
            sink.warn(
              `OpenClaw pin ${skillId}: skipped${result.detail ? ` -- ${result.detail}` : ""}`,
            );
          }
        }
      }
    }

    // Re-assess after fix
    let stillMissing = false;
    const postMissing: string[] = [];
    for (const skillsDir of skillsDirs) {
      const post = assessOpenClawPins(
        skillsDir,
        { isDir, isFile, lstatKind: seams.lstatKind },
        { contentBase },
      );
      if (post.missing.length > 0 || post.divergent.length > 0) {
        stillMissing = true;
        postMissing.push(
          ...post.missing.map((id) => `${skillsDir}/${id}`),
          ...post.divergent.map((id) => `${skillsDir}/${id} (divergent)`),
        );
      }
    }
    if (!stillMissing) {
      const message =
        `${OPENCLAW_SKILL_PINS_CHECK}: wired OpenClaw always-pins; ` +
        "restart the OpenClaw gateway or start a new session so available_skills refreshes";
      sink.success(message);
      addFinding({
        severity: "skip",
        message,
        check: OPENCLAW_SKILL_PINS_CHECK,
        status: "fixed",
        skills_dirs: skillsDirs,
        installs: installResults,
        detect_reasons: detect.reasons,
      });
      return;
    }
    // Fall through to warning with remaining gaps
    missingByDir.length = 0;
    divergentByDir.length = 0;
    for (const skillsDir of skillsDirs) {
      const post = assessOpenClawPins(skillsDir, { isDir, isFile, lstatKind: seams.lstatKind });
      if (post.missing.length > 0) missingByDir.push({ skillsDir, missing: [...post.missing] });
      if (post.divergent.length > 0)
        divergentByDir.push({ skillsDir, divergent: [...post.divergent] });
    }
  }

  const missingIds = [...new Set(missingByDir.flatMap((m) => m.missing))];
  const divergentIds = [...new Set(divergentByDir.flatMap((d) => d.divergent))];
  const targetSummary = skillsDirs.join(", ");
  const sourceHint = join(contentBase, "skills", "<pin-id>");
  const multiHint = options.allAgents ? "" : ` Multi-seat workspaces: ${REMEDIATION_ALL_AGENTS}.`;
  const message =
    `${OPENCLAW_SKILL_PINS_CHECK}: missing OpenClaw always-pin skill(s) ` +
    `[${missingIds.join(", ") || "(none)"}]` +
    (divergentIds.length > 0 ? `; divergent: [${divergentIds.join(", ")}]` : "") +
    ` under ${targetSummary}. ` +
    `Source: ${sourceHint}. ` +
    `Remediation: ${REMEDIATION_FIX}. ` +
    `See ${DOC_OPENCLAW_HOST}, ${DOC_HOST_LIFECYCLE}, ${DOC_SKILL_PINS}.` +
    multiHint;

  sink.warn(message);
  if (!options.jsonMode) {
    sink.info(
      "After wiring pins, restart the OpenClaw gateway or open a new session so host available_skills refreshes.",
    );
  }
  addFinding({
    severity: "warning",
    message,
    check: OPENCLAW_SKILL_PINS_CHECK,
    status: "missing",
    missing: missingIds,
    divergent: divergentIds,
    skills_dirs: skillsDirs,
    main_skills_dir: detect.mainSkillsDir,
    source_content_root: contentBase,
    suggestion: REMEDIATION_FIX,
    docs: [DOC_OPENCLAW_HOST, DOC_HOST_LIFECYCLE, DOC_SKILL_PINS],
    detect_reasons: detect.reasons,
    ...(installResults.length > 0 ? { installs: installResults } : {}),
  });
}
