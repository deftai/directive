import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CLEAN_WINDOW_HOURS, DIRTY_WINDOW_HOURS, ENV_STATE_PATH } from "./constants.js";
import type { DoctorState, ThrottleDecision } from "./types.js";

const STATE_PARENT = join("vbrief", ".eval");
const STATE_FILENAME = "doctor-state.json";

export function statePath(projectRoot: string): string {
  const override = process.env[ENV_STATE_PATH]?.trim();
  if (override) {
    return override.startsWith("~")
      ? join(process.env.HOME ?? projectRoot, override.slice(1))
      : override;
  }
  return join(projectRoot, STATE_PARENT, STATE_FILENAME);
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
  const path = statePath(projectRoot);
  try {
    const raw = readFile(path);
    const data = JSON.parse(raw) as Record<string, unknown>;
    const lastRunAt = parseIso(data.last_run_at);
    if (!lastRunAt) {
      return null;
    }
    return {
      lastRunAt,
      lastExitCode: Number(data.last_exit_code ?? 0),
      lastFindingCount: Number(data.last_finding_count ?? 0),
      lastErrorCount: Number(data.last_error_count ?? 0),
    };
  } catch {
    return null;
  }
}

function defaultReadFile(path: string): string {
  return readFileSync(path, "utf8");
}

export function writeState(
  projectRoot: string,
  payload: {
    exitCode: number;
    findingCount: number;
    errorCount: number;
    now?: Date;
  },
): string | null {
  const when = payload.now ?? new Date();
  const body = {
    last_run_at: formatUtcIso(when),
    last_exit_code: payload.exitCode,
    last_finding_count: payload.findingCount,
    last_error_count: payload.errorCount,
  };
  const path = statePath(projectRoot);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
    return path;
  } catch {
    return null;
  }
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

export function renderDoctorStatusLine(decision: ThrottleDecision, now = new Date()): string {
  const ageH = Math.max(Math.floor(decision.ageHours), 0);
  if (decision.dirty) {
    const errs = decision.lastErrorCount;
    const warns = Math.max(decision.lastFindingCount - decision.lastErrorCount, 0);
    const errPhrase = `${errs} error${errs !== 1 ? "s" : ""}`;
    const warnPhrase = `${warns} warning${warns !== 1 ? "s" : ""}`;
    return `[doctor] ran ${ageH}h ago, ${errPhrase} / ${warnPhrase} -- UNRESOLVED; run \`deft doctor --full\` to re-probe or address findings.`;
  }
  const remainingMs = (decision.nextEligibleAt?.getTime() ?? now.getTime()) - now.getTime();
  const remainingH = Math.max(Math.floor(remainingMs / 3_600_000), 0);
  return `[doctor] ran ${ageH}h ago, clean; next eligible in ${remainingH}h; --full forces.`;
}
