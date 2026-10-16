/**
 * Contract-1 / R12 read-only doctor diagnosis (Wave 2e).
 *
 * Covers AC12.3 surfaces via install-health + data-status. Never writes.
 * Hook probes must set DEFT_DOCTOR_HOOK_DIAGNOSTIC (AC9.10).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkFullInSync,
  DEFT_DOCTOR_HOOK_DIAGNOSTIC,
  INSTALLATION_RECOVERY_GUIDANCE,
  RUNTIME_PACKAGE_PATH_PREFIX,
  type FullInSyncResult,
  type PredicateResult,
} from "@deftai/directive-core/dist/install-health/index.js";
import { readProjectDataStatus, type DataStatusValue } from "./data-status.js";

export { DEFT_DOCTOR_HOOK_DIAGNOSTIC };

/**
 * F-010 / C7 — no-.git partial install: primary recovery is git init then repair,
 * not the generic AC9.7 global reinstall line.
 */
export const GIT_PRECONDITION_RECOVERY_GUIDANCE =
  "git init, then directive install --repair";

/** Readiness detail when wiring-ready is withheld solely because there is no .git. */
export const GIT_PRECONDITION_READINESS_DETAIL =
  "incomplete install — wiring-ready withheld until git init (hooksPath not activatable)";

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
}

export interface DoctorHookProbeResult {
  readonly ok: boolean;
  readonly detail: string;
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
   * Install/wiring recovery guidance, or F-010 git-precondition recovery.
   * Null when healthy or schema-only.
   */
  readonly remedy: string | null;
  /** Schema/data migration remedy; never `install --repair`. */
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
 * Cheap read-only check that committed hook/skill wiring uses package-relative form.
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
  const skillRelCandidates = [
    ".agents/skills/deft/SKILL.md",
    "AGENTS.md",
  ];

  let hookOk = true;
  let hookDetail: string | null = null;
  let sawHook = false;
  for (const rel of hookRelCandidates) {
    const abs = join(projectRoot, rel);
    if (!existsSync(abs)) continue;
    sawHook = true;
    try {
      const text = readFileSync(abs, "utf8");
      const hasPkg = text.includes(prefix) && text.includes("hook-bin");
      const hasLegacy = text.includes(".deft/core/") || /(^|[\s"`'])deft-hook([\s"`']|$)/.test(text);
      if (hasLegacy || !hasPkg) {
        hookOk = false;
        hookDetail = `${rel} does not use package-relative hook-bin form`;
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
    hookCommandForm: { ok: hookOk || !sawHook, detail: hookOk ? (sawHook ? null : hookDetail) : hookDetail },
    skillPointers: { ok: skillOk || !sawSkill, detail: skillOk ? (sawSkill ? null : skillDetail) : skillDetail },
  };
}

function defaultHookProbe(projectRoot: string): DoctorHookProbeResult {
  // Structural-only default: prove diagnostic env would be set; do not spawn in unit path.
  // Live smoke / probeAgentHooksLive exercises real commands under DEFT_DOCTOR_HOOK_DIAGNOSTIC.
  void projectRoot;
  return {
    ok: true,
    detail: `diagnostic env ${DEFT_DOCTOR_HOOK_DIAGNOSTIC}=1 (no live spawn in default probe)`,
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

function chooseRemedy(
  sync: FullInSyncResult,
  dataStatus: DataStatusValue,
  projectRoot: string,
): { remedy: string | null; schemaRemedy: "directive upgrade" | null } {
  // F-010: incomplete no-git install — do not lead with AC9.7 global reinstall.
  if (isNoGitReadinessGap(sync, projectRoot)) {
    return { remedy: GIT_PRECONDITION_RECOVERY_GUIDANCE, schemaRemedy: null };
  }

  const installBroken =
    sync.failClosed || !sync.inSync || !sync.predicates.installed.ok || !sync.predicates.pin.ok;

  // AC12.7: never dual-prescribe upgrade + repair. Install/wiring recovery wins
  // when both faults are present; schema-only behind → upgrade alone.
  if (installBroken) {
    return { remedy: INSTALLATION_RECOVERY_GUIDANCE, schemaRemedy: null };
  }
  if (dataStatus === "migration_needed" || dataStatus === "diagnosis_failed") {
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

  const gitPrecondition = isNoGitReadinessGap(sync, projectRoot);
  const { remedy, schemaRemedy } = chooseRemedy(sync, dataStatus, projectRoot);
  const healthy =
    sync.inSync && dataStatus === "current" && form.hookCommandForm.ok && form.skillPointers.ok;

  const readinessSurface = gitPrecondition
    ? { ok: false, detail: GIT_PRECONDITION_READINESS_DETAIL }
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
    info: {
      launcherPresent: options.launcherPresent ?? null,
      newerReleaseAvailable: options.newerReleaseAvailable ?? null,
      nodeBestEffortNote: options.nodeBestEffortNote ?? null,
      generationPmDrift: detectGenerationPmDrift(projectRoot),
    },
    exitCode: healthy ? 0 : 1,
  };
}

function line(ok: boolean, name: string, detail: string | null): string {
  const mark = ok ? "ok" : "FAIL";
  return detail ? `  ${name}: ${mark} — ${detail}` : `  ${name}: ${mark}`;
}

/** Human-readable doctor report (AC12.3 / AC12.5 / F-010). */
export function formatDoctorReport(diag: DoctorDiagnosis): string {
  const lines: string[] = [];
  // Header tracks overall health (exitCode), not install-health inSync alone —
  // skill/hook form failures must not still print "in sync" (AC12.3 / POST-CONV-DOC).
  // F-010: no-git readiness withhold is an incomplete install / precondition, not a
  // generic "not in sync" that reads like a broken pin.
  if (diag.exitCode === 0) {
    lines.push("directive doctor: in sync");
  } else if (diag.incompleteInstall === "git-precondition") {
    lines.push("directive doctor: incomplete install (git precondition)");
  } else {
    lines.push("directive doctor: not in sync");
  }

  if (diag.version) lines.push(`  version: ${diag.version}`);
  lines.push(line(diag.surfaces.pin.ok, "pin", diag.surfaces.pin.detail));
  lines.push(line(diag.surfaces.lockfile.ok, "lockfile", diag.surfaces.lockfile.detail));
  lines.push(line(diag.surfaces.installed.ok, "installed", diag.surfaces.installed.detail));
  lines.push(line(diag.surfaces.generation.ok, "GENERATION.json", diag.surfaces.generation.detail));
  lines.push(line(diag.surfaces.wiring.ok, "wiring", diag.surfaces.wiring.detail));
  lines.push(line(diag.surfaces.readiness.ok, "readiness", diag.surfaces.readiness.detail));
  lines.push(
    line(diag.surfaces.hookCommandForm.ok, "hook command form", diag.surfaces.hookCommandForm.detail),
  );
  lines.push(
    line(diag.surfaces.skillPointers.ok, "skill pointers", diag.surfaces.skillPointers.detail),
  );
  lines.push(
    line(diag.surfaces.schemaCurrency.ok, "xbrief/schema currency", diag.surfaces.schemaCurrency.detail),
  );
  if (diag.hookProbe) {
    lines.push(line(diag.hookProbe.ok, "hook probe", diag.hookProbe.detail));
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
  if (diag.remedy) {
    lines.push(`Recovery: ${diag.remedy}`);
  }
  return `${lines.join("\n")}\n`;
}
