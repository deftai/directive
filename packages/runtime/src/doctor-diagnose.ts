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

/** Patterns that must never appear as doctor remedies (AC12.5–12.7 / AC9.11). */
export const FORBIDDEN_DOCTOR_REMEDY_PATTERNS: readonly RegExp[] = [
  /\balign-pin\b/i,
  /\binstall-global\b/i,
  /accept-engine-jump/i,
  /DEFT_ACCEPT_ENGINE_SKEW/i,
  /engine ladder/i,
  /skew window/i,
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
}

export interface DoctorDiagnosis {
  readonly inSync: boolean;
  readonly version: string | null;
  readonly failClosed: boolean;
  readonly dataStatus: DataStatusValue;
  /** AC9.7 when install/wiring recovery is needed; null when healthy or schema-only. */
  readonly remedy: string | null;
  /** Schema/data migration remedy; never `install --repair`. */
  readonly schemaRemedy: "directive upgrade" | null;
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
      if (rel === "AGENTS.md" && !text.includes("deft:managed-section")) {
        continue;
      }
      if (!text.includes(prefix) || text.includes(".deft/core/")) {
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

function chooseRemedy(
  sync: FullInSyncResult,
  dataStatus: DataStatusValue,
): { remedy: string | null; schemaRemedy: "directive upgrade" | null } {
  if (dataStatus === "migration_needed") {
    // Schema behind is never repair (AC12.2 / AC12.7).
    const schemaRemedy = "directive upgrade" as const;
    if (sync.failClosed || !sync.predicates.installed.ok || !sync.predicates.pin.ok) {
      return { remedy: INSTALLATION_RECOVERY_GUIDANCE, schemaRemedy };
    }
    if (!sync.inSync) {
      return { remedy: INSTALLATION_RECOVERY_GUIDANCE, schemaRemedy };
    }
    return { remedy: null, schemaRemedy };
  }
  if (sync.inSync && dataStatus === "current") {
    return { remedy: null, schemaRemedy: null };
  }
  if (dataStatus === "diagnosis_failed") {
    return { remedy: null, schemaRemedy: "directive upgrade" };
  }
  // Install/wiring faults → AC9.7 (never "upgrade" for repair — AC12.7).
  return { remedy: INSTALLATION_RECOVERY_GUIDANCE, schemaRemedy: null };
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

  const { remedy, schemaRemedy } = chooseRemedy(sync, dataStatus);
  const healthy =
    sync.inSync && dataStatus === "current" && form.hookCommandForm.ok && form.skillPointers.ok;

  return {
    inSync: sync.inSync,
    version: sync.version,
    failClosed: sync.failClosed,
    dataStatus,
    remedy,
    schemaRemedy,
    surfaces: {
      pin: surfaceFromPred(sync.predicates.pin),
      lockfile: surfaceFromPred(sync.predicates.lockfile),
      installed: surfaceFromPred(sync.predicates.installed),
      generation: surfaceFromPred(sync.predicates.generation),
      wiring: surfaceFromPred(sync.predicates.wiring),
      readiness: surfaceFromPred(sync.predicates.readiness),
      hookCommandForm: form.hookCommandForm,
      skillPointers: form.skillPointers,
      schemaCurrency: schemaSurface(dataStatus),
    },
    hookProbe,
    info: {
      launcherPresent: options.launcherPresent ?? null,
      newerReleaseAvailable: options.newerReleaseAvailable ?? null,
      nodeBestEffortNote: options.nodeBestEffortNote ?? null,
    },
    exitCode: healthy ? 0 : 1,
  };
}

function line(ok: boolean, name: string, detail: string | null): string {
  const mark = ok ? "ok" : "FAIL";
  return detail ? `  ${name}: ${mark} — ${detail}` : `  ${name}: ${mark}`;
}

/** Human-readable doctor report (AC12.3 / AC12.5). */
export function formatDoctorReport(diag: DoctorDiagnosis): string {
  const lines: string[] = [];
  lines.push(
    diag.inSync && diag.dataStatus === "current"
      ? "directive doctor: in sync"
      : "directive doctor: not in sync",
  );
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
  if (diag.schemaRemedy) {
    lines.push(`Next: ${diag.schemaRemedy}`);
  }
  if (diag.remedy) {
    lines.push(`Recovery: ${diag.remedy}`);
  }
  return `${lines.join("\n")}\n`;
}
