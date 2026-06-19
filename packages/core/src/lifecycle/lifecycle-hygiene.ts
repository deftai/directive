import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { computeReport } from "../capacity/show.js";
import { resolveCapacityAllocation } from "../policy/capacity.js";
import { loadProjectDefinition } from "../policy/resolve.js";

/** Default dormancy (days) past which a partially-completed epic is stranded. */
export const EPIC_STRANDED_DAYS_DEFAULT = 30;

/** Default dormancy (days) past which an undecomposed epic is stale. */
export const EPIC_STALENESS_DAYS_DEFAULT = 14;

/** vBRIEF plan.metadata.kind values treated as epic-like parents. */
export const PARENT_KINDS = new Set(["epic", "phase"]);

/** Lifecycle folders scanned for epics + children (filesystem-truth view). */
export const LIFECYCLE_FOLDERS = [
  "proposed",
  "pending",
  "active",
  "completed",
  "cancelled",
] as const;

/** plan.status values that make an epic terminal. */
export const TERMINAL_STATUSES = new Set(["completed", "cancelled", "failed"]);

/** Child reference type that marks an epic as decomposed. */
export const CHILD_REF_TYPE = "x-vbrief/plan";

/** Durable tech-debt acceptance ledger relative path segments. */
export const TECH_DEBT_LEDGER_RELPATH = [
  "vbrief",
  ".audit",
  "epic-tech-debt-accepted.jsonl",
] as const;

/** Session-start nudge tiers (rate-of-harm ranking). */
export const TIER_STRANDED = 1;
export const TIER_STALE_EPIC = 2;
export const TIER_CAPACITY_COLDSTART = 3;

/** Stable nudge id for the singleton capacity cold-start nudge. */
export const CAPACITY_COLDSTART_NUDGE_ID = "capacity-coldstart";

/** Default actor recorded in the tech-debt ledger. */
export const DEFAULT_ACTOR = "lifecycle-hygiene";

export interface EpicThresholds {
  readonly strandedDays: number;
  readonly stalenessDays: number;
}

export interface LifecycleNudge {
  readonly nudgeId: string;
  readonly kind: string;
  readonly tier: number;
  readonly title: string;
  readonly epicRelPath: string;
  readonly dormantDays: number;
  readonly completedChildren: number;
  readonly totalChildren: number;
  readonly magnitude: number;
  readonly message: string;
}

interface VbriefOnDisk {
  readonly name: string;
  readonly folder: string;
  readonly relPath: string;
  readonly plan: Record<string, unknown>;
  readonly updated: Date | null;
}

function positiveInt(value: unknown, defaultValue: number): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  return defaultValue;
}

/** Resolve epicStrandedDays / epicStalenessDays from PROJECT-DEFINITION. */
export function resolveEpicThresholds(projectRoot: string): EpicThresholds {
  const [data] = loadProjectDefinition(projectRoot);
  let raw: Record<string, unknown> = {};
  if (data !== null && typeof data === "object") {
    const plan = data.plan;
    if (typeof plan === "object" && plan !== null && !Array.isArray(plan)) {
      const pol = (plan as Record<string, unknown>).policy;
      if (typeof pol === "object" && pol !== null && !Array.isArray(pol)) {
        const cap = (pol as Record<string, unknown>).capacityAllocation;
        if (typeof cap === "object" && cap !== null && !Array.isArray(cap)) {
          raw = cap as Record<string, unknown>;
        }
      }
    }
  }
  return {
    strandedDays: positiveInt(raw.epicStrandedDays, EPIC_STRANDED_DAYS_DEFAULT),
    stalenessDays: positiveInt(raw.epicStalenessDays, EPIC_STALENESS_DAYS_DEFAULT),
  };
}

function parseIso(value: unknown): Date | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  let text = value.trim();
  if (text.endsWith("Z")) {
    text = `${text.slice(0, -1)}+00:00`;
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function updatedAt(plan: Record<string, unknown>, path: string): Date | null {
  const stamp = parseIso(plan.updated);
  if (stamp !== null) {
    return stamp;
  }
  try {
    return new Date(statSync(path).mtimeMs);
  } catch {
    return null;
  }
}

function kind(plan: Record<string, unknown>): string {
  const metadata = plan.metadata;
  if (typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)) {
    const raw = (metadata as Record<string, unknown>).kind;
    if (typeof raw === "string" && raw.length > 0) {
      return raw;
    }
  }
  return "story";
}

function status(record: VbriefOnDisk): string {
  const raw = record.plan.status;
  if (typeof raw === "string" && raw.length > 0) {
    return raw;
  }
  if (record.folder === "completed") {
    return "completed";
  }
  if (record.folder === "cancelled") {
    return "cancelled";
  }
  return "";
}

function isCompleted(record: VbriefOnDisk): boolean {
  return status(record) === "completed" || record.folder === "completed";
}

function childRefNames(plan: Record<string, unknown>): string[] {
  const refs = plan.references;
  if (!Array.isArray(refs)) {
    return [];
  }
  const names: string[] = [];
  for (const ref of refs) {
    if (typeof ref !== "object" || ref === null || Array.isArray(ref)) {
      continue;
    }
    const rec = ref as Record<string, unknown>;
    if (rec.type !== CHILD_REF_TYPE) {
      continue;
    }
    const uri = rec.uri;
    if (typeof uri === "string" && uri.trim().length > 0) {
      names.push(basename(uri.trim()));
    }
  }
  return names;
}

function iterVbriefs(projectRoot: string): VbriefOnDisk[] {
  const out: VbriefOnDisk[] = [];
  const vroot = join(resolve(projectRoot), "vbrief");
  for (const folder of LIFECYCLE_FOLDERS) {
    const fdir = join(vroot, folder);
    if (!existsSync(fdir)) {
      continue;
    }
    const children = readdirSync(fdir)
      .filter((name) => name.endsWith(".vbrief.json"))
      .sort();
    for (const name of children) {
      const child = join(fdir, name);
      try {
        const raw = readFileSync(child, "utf8");
        const data = JSON.parse(raw) as unknown;
        const plan =
          typeof data === "object" && data !== null && !Array.isArray(data)
            ? (data as Record<string, unknown>).plan
            : null;
        if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
          continue;
        }
        out.push({
          name,
          folder,
          relPath: `${folder}/${name}`,
          plan: plan as Record<string, unknown>,
          updated: updatedAt(plan as Record<string, unknown>, child),
        });
      } catch {}
    }
  }
  return out;
}

function dormancyDays(stamps: readonly (Date | null)[], now: Date): number | null {
  const known = stamps.filter((s): s is Date => s !== null);
  if (known.length === 0) {
    return null;
  }
  const mostRecent = new Date(Math.max(...known.map((s) => s.getTime())));
  const deltaMs = now.getTime() - mostRecent.getTime();
  return Math.max(0, Math.floor(deltaMs / 86_400_000));
}

/** Absolute path to vbrief/.audit/epic-tech-debt-accepted.jsonl. */
export function techDebtLedgerPath(projectRoot: string): string {
  return join(resolve(projectRoot), ...TECH_DEBT_LEDGER_RELPATH);
}

function utcIso(dt: Date | null = null): string {
  const value = dt ?? new Date();
  const iso = value.toISOString();
  return `${iso.slice(0, 19)}Z`;
}

/** Append a tech-debt acceptance record and stop re-nudging the epic. */
export function recordTechDebtAcceptance(
  projectRoot: string,
  epic: string,
  options: { followUpRef: string; actor?: string; now?: Date },
): string {
  const epicKey = basename(epic.trim());
  if (epicKey.length === 0) {
    throw new Error("epic must be a non-empty basename or path");
  }
  const followUpRef = options.followUpRef;
  if (typeof followUpRef !== "string" || followUpRef.trim().length === 0) {
    throw new Error("follow_up_ref must be a non-empty reference string");
  }
  const path = techDebtLedgerPath(projectRoot);
  mkdirSync(resolve(path, ".."), { recursive: true });
  const record = {
    accepted_at: utcIso(options.now ?? null),
    actor: options.actor ?? DEFAULT_ACTOR,
    epic: epicKey,
    follow_up_ref: followUpRef.trim(),
  };
  appendFileSync(path, `${JSON.stringify(sortKeys(record))}\n`, "utf8");
  return path;
}

/** Return the set of epic basenames already accepted as tech-debt. */
export function loadAcceptedDebtKeys(projectRoot: string): Set<string> {
  const path = techDebtLedgerPath(projectRoot);
  if (!existsSync(path)) {
    return new Set();
  }
  const keys = new Set<string>();
  try {
    const text = readFileSync(path, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const stripped = line.trim();
      if (stripped.length === 0) {
        continue;
      }
      try {
        const obj = JSON.parse(stripped) as unknown;
        if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
          const epic = (obj as Record<string, unknown>).epic;
          if (typeof epic === "string" && epic.length > 0) {
            keys.add(epic);
          }
        }
      } catch {}
    }
  } catch {
    return keys;
  }
  return keys;
}

function renderStranded(
  title: string,
  dormant: number,
  threshold: number,
  completed: number,
  total: number,
): string {
  return (
    `[TIER-1] stranded slice: epic "${title}" dormant ${dormant}d ` +
    `(> epicStrandedDays ${threshold}) with ${completed}/${total} children ` +
    "completed -- finish | cancel-and-remove | accept-as-tech-debt " +
    "(see `task capacity:show`)"
  );
}

function renderStaleEpic(title: string, dormant: number, threshold: number): string {
  return (
    `[TIER-2] stale epic: undecomposed epic "${title}" dormant ${dormant}d ` +
    `(> epicStalenessDays ${threshold}) -- needs estimation/decomposition`
  );
}

function renderCapacityColdstart(
  unclassified: number,
  classified: number,
  minimum: number,
): string {
  return (
    `[TIER-3] capacity cold-start: ${unclassified} completed vBRIEF(s) ` +
    `unclassified (classified ${classified}/${minimum} in window) -- run ` +
    "`task capacity:backfill --apply` to classify history and activate " +
    "capacity accounting (#1606)"
  );
}

function title(record: VbriefOnDisk): string {
  const raw = record.plan.title;
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim();
  }
  return record.name;
}

function strandedNudge(
  epic: VbriefOnDisk,
  childNames: readonly string[],
  resolved: readonly VbriefOnDisk[],
  thresholds: EpicThresholds,
  now: Date,
): LifecycleNudge | null {
  const completed = resolved.filter((c) => isCompleted(c));
  const total = childNames.length;
  if (completed.length === 0 || completed.length >= total) {
    return null;
  }
  const stamps = [epic.updated, ...resolved.map((c) => c.updated)];
  const dormant = dormancyDays(stamps, now);
  if (dormant === null || dormant <= thresholds.strandedDays) {
    return null;
  }
  const epicTitle = title(epic);
  return {
    nudgeId: epic.name,
    kind: "stranded",
    tier: TIER_STRANDED,
    title: epicTitle,
    epicRelPath: epic.relPath,
    dormantDays: dormant,
    completedChildren: completed.length,
    totalChildren: total,
    magnitude: dormant,
    message: renderStranded(epicTitle, dormant, thresholds.strandedDays, completed.length, total),
  };
}

function staleEpicNudge(
  epic: VbriefOnDisk,
  thresholds: EpicThresholds,
  now: Date,
): LifecycleNudge | null {
  const dormant = dormancyDays([epic.updated], now);
  if (dormant === null || dormant <= thresholds.stalenessDays) {
    return null;
  }
  const epicTitle = title(epic);
  return {
    nudgeId: epic.name,
    kind: "stale-epic",
    tier: TIER_STALE_EPIC,
    title: epicTitle,
    epicRelPath: epic.relPath,
    dormantDays: dormant,
    completedChildren: 0,
    totalChildren: 0,
    magnitude: dormant,
    message: renderStaleEpic(epicTitle, dormant, thresholds.stalenessDays),
  };
}

/** Detect stranded-slice (Tier 1) + stale-epic (Tier 2) nudges. */
export function detectLifecycleNudges(
  projectRoot: string,
  options: { now?: Date } = {},
): LifecycleNudge[] {
  const nowDt = options.now ?? new Date();
  const thresholds = resolveEpicThresholds(projectRoot);
  const accepted = loadAcceptedDebtKeys(projectRoot);
  const records = iterVbriefs(projectRoot);
  const index = new Map(records.map((r) => [r.name, r]));
  const nudges: LifecycleNudge[] = [];

  for (const record of records) {
    if (!PARENT_KINDS.has(kind(record.plan))) {
      continue;
    }
    if (TERMINAL_STATUSES.has(status(record))) {
      continue;
    }
    if (accepted.has(record.name)) {
      continue;
    }
    const childNames = childRefNames(record.plan);
    const resolved = childNames
      .map((name) => index.get(name))
      .filter((r): r is VbriefOnDisk => r !== undefined);
    const nudge =
      resolved.length > 0
        ? strandedNudge(record, childNames, resolved, thresholds, nowDt)
        : staleEpicNudge(record, thresholds, nowDt);
    if (nudge !== null) {
      nudges.push(nudge);
    }
  }

  const capacityNudge = detectCapacityColdstartNudge(projectRoot, { now: nowDt });
  if (capacityNudge !== null) {
    nudges.push(capacityNudge);
  }

  nudges.sort((a, b) => {
    if (a.tier !== b.tier) {
      return a.tier - b.tier;
    }
    if (a.magnitude !== b.magnitude) {
      return b.magnitude - a.magnitude;
    }
    return a.nudgeId.localeCompare(b.nudgeId);
  });
  return nudges;
}

/** Capacity classification cold-start (Tier 3) nudge (#1606). */
export function detectCapacityColdstartNudge(
  projectRoot: string,
  options: { now?: Date } = {},
): LifecycleNudge | null {
  const allocation = resolveCapacityAllocation(projectRoot);
  if (!allocation.configured) {
    return null;
  }

  const report = computeReport(projectRoot, { now: options.now, allocation });
  if (report.classified_completions >= report.min_sample_size) {
    return null;
  }
  if (report.unclassified_completions <= 0) {
    return null;
  }

  const message = renderCapacityColdstart(
    report.unclassified_completions,
    report.classified_completions,
    report.min_sample_size,
  );
  return {
    nudgeId: CAPACITY_COLDSTART_NUDGE_ID,
    kind: "capacity-coldstart",
    tier: TIER_CAPACITY_COLDSTART,
    title: "capacity cold-start",
    epicRelPath: "",
    dormantDays: 0,
    completedChildren: 0,
    totalChildren: 0,
    magnitude: report.unclassified_completions,
    message,
  };
}

function sortKeys(value: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = value[key];
  }
  return sorted;
}
