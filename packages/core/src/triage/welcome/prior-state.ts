import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CACHE_DIR_NAME,
  CACHE_SOURCE,
  CANDIDATES_RELPATH,
  DEFAULT_WIP_CAP,
  SUBSCRIPTION_PRESETS,
  WIP_LIFECYCLE_DIRS,
} from "./constants.js";

export interface PriorState {
  readonly triageScopeSet: boolean;
  readonly triageScopeSummary: string;
  readonly cacheEmpty: boolean;
  readonly cacheEntryCount: number;
  readonly wipCapSet: boolean;
  readonly wipCap: number;
  readonly wipCount: number;
  readonly auditLogPresent: boolean;
  readonly pendingDecisions: number;
}

function loadProjectDefinition(projectRoot: string): Record<string, unknown> | null {
  const path = join(resolve(projectRoot), "vbrief", "PROJECT-DEFINITION.vbrief.json");
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function countCacheEntries(projectRoot: string): number {
  const base = join(resolve(projectRoot), CACHE_DIR_NAME, CACHE_SOURCE);
  if (!existsSync(base)) return 0;
  let count = 0;
  for (const ownerDir of readdirSync(base, { withFileTypes: true })) {
    if (!ownerDir.isDirectory()) continue;
    const ownerPath = join(base, ownerDir.name);
    for (const repoDir of readdirSync(ownerPath, { withFileTypes: true })) {
      if (!repoDir.isDirectory()) continue;
      const repoPath = join(ownerPath, repoDir.name);
      for (const entry of readdirSync(repoPath, { withFileTypes: true })) {
        if (entry.isDirectory() && /^\d+$/.test(entry.name)) count += 1;
      }
    }
  }
  return count;
}

export function candidatesLogPath(projectRoot: string): string {
  return join(resolve(projectRoot), ...CANDIDATES_RELPATH);
}

function countWip(projectRoot: string): number {
  let total = 0;
  const root = join(resolve(projectRoot), "vbrief");
  for (const sub of WIP_LIFECYCLE_DIRS) {
    const folder = join(root, sub);
    if (!existsSync(folder)) continue;
    for (const child of readdirSync(folder, { withFileTypes: true })) {
      if (child.isFile() && child.name.endsWith(".vbrief.json")) total += 1;
    }
  }
  return total;
}

function summarizeScope(rules: Array<Record<string, unknown>> | null): [boolean, string] {
  if (!rules || rules.length === 0) {
    return [false, "unset (default applied -- all-open)"];
  }
  const small = SUBSCRIPTION_PRESETS.small;
  if (JSON.stringify(rules) === JSON.stringify(small)) {
    return [true, "Small (all-open)"];
  }
  const mid = SUBSCRIPTION_PRESETS.mid;
  if (JSON.stringify(rules) === JSON.stringify(mid)) {
    return [true, "Mid (curated labels + opened-since 60d)"];
  }
  const megaBaseline = SUBSCRIPTION_PRESETS.mega?.map((r) => ({ ...r })) ?? [];
  if (rules.length === megaBaseline.length) {
    let match = true;
    for (let i = 0; i < rules.length; i += 1) {
      if (rules[i]?.rule !== megaBaseline[i]?.rule) {
        match = false;
        break;
      }
    }
    if (match) return [true, "Mega (explicit-watch + referenced-by-vbrief)"];
  }
  return [true, `custom (${rules.length} rule(s))`];
}

function countPendingDecisions(projectRoot: string): number {
  const logPath = join(resolve(projectRoot), "vbrief", ".audit", "pending-human-decisions.jsonl");
  if (!existsSync(logPath)) return 0;
  let text: string;
  try {
    text = readFileSync(logPath, "utf8");
  } catch {
    return 0;
  }
  const latest = new Map<string, Record<string, unknown>>();
  for (const raw of text.split("\n")) {
    const stripped = raw.trim();
    if (!stripped) continue;
    try {
      const event = JSON.parse(stripped) as Record<string, unknown>;
      const id = event.decision_id;
      if (typeof id === "string" && id) latest.set(id, event);
    } catch {}
  }
  let pending = 0;
  for (const event of latest.values()) {
    if (event.status === "pending") pending += 1;
  }
  return pending;
}

export function pendingDecisionsNudgeLine(count: number, threshold = 3): string {
  if (count <= threshold) return "";
  return (
    `[TIER-1] pending human-clearance backlog: ${count} decision(s) ` +
    `awaiting adjudication (> threshold ${threshold}). Tune wipCap to real ` +
    "review throughput or clear the backlog before dispatching more work."
  );
}

/** Read every Phase 1 probe in one pass. Pure — no writes. */
export function detectPriorState(projectRoot: string): PriorState {
  const data = loadProjectDefinition(projectRoot) ?? {};
  const plan = data.plan;
  const policy =
    typeof plan === "object" && plan !== null && !Array.isArray(plan)
      ? (plan as Record<string, unknown>).policy
      : null;
  const rawScope =
    typeof policy === "object" && policy !== null && !Array.isArray(policy)
      ? (policy as Record<string, unknown>).triageScope
      : null;
  const scopeRules = Array.isArray(rawScope)
    ? rawScope.filter(
        (r): r is Record<string, unknown> =>
          typeof r === "object" && r !== null && !Array.isArray(r),
      )
    : null;

  let wipCap = DEFAULT_WIP_CAP;
  let wipCapSet = false;
  if (typeof policy === "object" && policy !== null && !Array.isArray(policy)) {
    const rawCap = (policy as Record<string, unknown>).wipCap;
    if (typeof rawCap === "number" && Number.isInteger(rawCap) && rawCap >= 0) {
      wipCap = rawCap;
      wipCapSet = true;
    }
  }

  const [scopeSet, scopeLabel] = summarizeScope(scopeRules);
  const cacheCount = countCacheEntries(projectRoot);
  return {
    triageScopeSet: scopeSet,
    triageScopeSummary: scopeLabel,
    cacheEmpty: cacheCount === 0,
    cacheEntryCount: cacheCount,
    wipCapSet,
    wipCap,
    wipCount: countWip(projectRoot),
    auditLogPresent: existsSync(candidatesLogPath(projectRoot)),
    pendingDecisions: countPendingDecisions(projectRoot),
  };
}

export function classifyOnboarding(state: PriorState): [string, string[]] {
  const signals: Record<string, boolean> = {
    "candidates.jsonl": state.auditLogPresent,
    triageScope: state.triageScopeSet,
    wipCap: state.wipCapSet,
  };
  const present = Object.keys(signals).filter((k) => signals[k]);
  const missing = Object.keys(signals).filter((k) => !signals[k]);
  if (present.length === 0) return ["first-time", missing];
  if (missing.length === 0) return ["fully-set-up", []];
  return ["incomplete", missing];
}
