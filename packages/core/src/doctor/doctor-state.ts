import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveTriageCachePath } from "../triage/cache-path.js";
import { CLEAN_WINDOW_HOURS, DIRTY_WINDOW_HOURS, ENV_STATE_PATH } from "./constants.js";
import type { DoctorState, ThrottleDecision } from "./types.js";

/**
 * Legacy doctor throttle file (#1315). Doctor no longer writes it (AC12.1,
 * #6617); session start reads it once for compatibility when its own record
 * in `.deft/orientation-state.json` has no doctor entry yet.
 */
const STATE_FILENAME = "doctor-state.json";

export function statePath(projectRoot: string): string {
  const override = process.env[ENV_STATE_PATH]?.trim();
  if (override) {
    return override.startsWith("~")
      ? join(homedir(), override.slice(1).replace(/^[\\/]/, ""))
      : override;
  }
  return resolveTriageCachePath(projectRoot, STATE_FILENAME);
}

function parseIso(ts: unknown): Date | null {
  if (typeof ts !== "string" || !ts) {
    return null;
  }
  let candidate = ts.trim();
  if (candidate.endsWith("Z")) {
    candidate = `${candidate.slice(0, -1)}+00:00`;
  }
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function readState(projectRoot: string, readFile = defaultReadFile): DoctorState | null {
  try {
    // Inside the try: resolving the path can throw for a missing project
    // directory (for example `/tmp` on Windows); an unreadable record is null.
    const raw = readFile(statePath(projectRoot));
    const data = JSON.parse(raw) as Record<string, unknown>;
    const lastRunAt = parseIso(data.last_run_at);
    if (!lastRunAt) {
      return null;
    }
    const rememberedDeposit = data.last_has_deft_core;
    return {
      lastRunAt,
      lastExitCode: Number(data.last_exit_code ?? 0),
      lastFindingCount: Number(data.last_finding_count ?? 0),
      lastErrorCount: Number(data.last_error_count ?? 0),
      ...(typeof rememberedDeposit === "boolean" ? { lastHasDeftCore: rememberedDeposit } : {}),
    };
  } catch {
    return null;
  }
}

function defaultReadFile(path: string): string {
  return readFileSync(path, "utf8");
}

export function decideThrottle(state: DoctorState | null, now = new Date()): ThrottleDecision {
  if (!state) {
    return {
      skip: false,
      dirty: false,
      lastRunAt: null,
      lastExitCode: 0,
      lastFindingCount: 0,
      lastErrorCount: 0,
      nextEligibleAt: null,
      ageHours: 0,
    };
  }
  const isDirty = state.lastErrorCount > 0;
  const windowHours = isDirty ? DIRTY_WINDOW_HOURS : CLEAN_WINDOW_HOURS;
  const eligibleAt = new Date(state.lastRunAt.getTime() + windowHours * 3600_000);
  const ageHours = (now.getTime() - state.lastRunAt.getTime()) / 3_600_000;
  return {
    skip: now < eligibleAt,
    dirty: isDirty,
    lastRunAt: state.lastRunAt,
    lastExitCode: state.lastExitCode,
    lastFindingCount: state.lastFindingCount,
    lastErrorCount: state.lastErrorCount,
    nextEligibleAt: eligibleAt,
    ageHours,
  };
}

export function formatUtcIso(when: Date): string {
  return when.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function formatIsoZ(when: Date | null): string {
  if (!when) {
    return "";
  }
  return formatUtcIso(when);
}

/** Dirty doctor / ritual copy: --full re-probes only; do not prescribe a write (#3379). */
export const DOCTOR_HARD_ERROR_NOTE =
  "these are hard errors (advisory warnings do not block writes)";
export const DOCTOR_DIRTY_REPROBE_HINT = "run `deft doctor --full` to re-probe only";

export function dirtyDoctorHint(): string {
  return `${DOCTOR_HARD_ERROR_NOTE}; ${DOCTOR_DIRTY_REPROBE_HINT}`;
}

export function renderDoctorStatusLine(decision: ThrottleDecision, now = new Date()): string {
  const ageH = Math.max(Math.floor(decision.ageHours), 0);
  if (decision.dirty) {
    const errs = decision.lastErrorCount;
    const warns = Math.max(decision.lastFindingCount - decision.lastErrorCount, 0);
    const errPhrase = `${errs} error${errs !== 1 ? "s" : ""}`;
    const warnPhrase = `${warns} warning${warns !== 1 ? "s" : ""}`;
    return `[doctor] ran ${ageH}h ago, ${errPhrase} / ${warnPhrase} -- UNRESOLVED; ${DOCTOR_HARD_ERROR_NOTE}. ${DOCTOR_DIRTY_REPROBE_HINT}.`;
  }
  const remainingMs = (decision.nextEligibleAt?.getTime() ?? now.getTime()) - now.getTime();
  const remainingH = Math.max(Math.floor(remainingMs / 3_600_000), 0);
  // Warning-only last run stays a 24h skip (#3379) but must not print clean (#4673).
  if (decision.lastFindingCount >= 1) {
    const warns = Math.max(decision.lastFindingCount - decision.lastErrorCount, 0);
    const warnPhrase = `${warns} warning${warns !== 1 ? "s" : ""}`;
    return `[doctor] ran ${ageH}h ago, ${warnPhrase} (advisory; throttle-skipped); next eligible in ${remainingH}h; --full forces.`;
  }
  return `[doctor] ran ${ageH}h ago, clean; next eligible in ${remainingH}h; --full forces.`;
}
