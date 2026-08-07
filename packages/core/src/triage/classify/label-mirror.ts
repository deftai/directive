/**
 * Tier-1 deterministic SCM label mirror (#1423 Wave 1 + Wave 2 bootstrap + #3197 re-enrich).
 *
 * Classifies cached issues with the existing #1129 engine, then mirrors the
 * outcome as SCM labels (dry-run default, --apply to write). Never accepts into
 * the xBRIEF lifecycle and never writes proposed/ scopes.
 *
 * Wave 2 (#3125): open-only default, operator digest (totals + by state/rule/action
 * + samples), batched rate-limit-aware apply. Bootstrap mass-triage entrypoint is
 * `triage:classify -- --mirror` with these filters (not triage:accept).
 *
 * #3197 re-enrich: default keeps one-shot skip on idempotencyLabel; opt-in
 * `--re-enrich` re-classifies already-stamped issues and plans **additive**
 * label deltas only (v1; no removals / no full reconcile).
 *
 * Intentionally does NOT import from ./index.js (SLizard P1 cycle). The classify
 * engine is injected via LabelMirrorEngine / mirrorLabels() wrapper in index.ts.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { referenceTypeMatches } from "@deftai/directive-types";
import {
  hasArtifactSuffix,
  resolveLifecycleRoot,
  resolveProjectDefinitionPath,
} from "../../layout/resolve.js";
import { readPlanPolicy } from "../../policy/plan-extensions.js";
import { ScmLabelClient } from "../../vbrief-reconcile/labels.js";
import { isRepoMutationAllowed } from "../../vbrief-reconcile/repo-guard.js";
import type { LabelClient } from "../../vbrief-reconcile/types.js";
import { latestDecisions, readAuditLog } from "../actions/candidates-log.js";
import {
  type AuthorFilter,
  authorLoginFromRawIssue,
  matchesAuthorFilter,
} from "../author-filter.js";
import { resolveCandidatesLogPath } from "../cache-path.js";
import { iterCachedIssues } from "../summary/index.js";

export const DEFAULT_IDEMPOTENCY_LABEL = "triaged";
export const CACHE_DIR_NAME = ".deft-cache";
export const CACHE_SOURCE = "github-issue";

/** Default apply batch size for rate-limit awareness (#3125). */
export const DEFAULT_APPLY_BATCH_SIZE = 10;
/** Default delay between apply batches in ms (#3125). */
export const DEFAULT_APPLY_DELAY_MS = 1000;
/** Default sample count in human digest (#3125). */
export const DEFAULT_DIGEST_SAMPLE_LIMIT = 15;

const VALID_ACTIONS: ReadonlySet<string> = new Set(["defer", "archive", "escalate", "accept"]);

export type ClassifyAction = "defer" | "archive" | "escalate" | "accept";

/** Minimal issue shape used by the mirror (matches classify GitHubIssue). */
export interface MirrorGitHubIssue {
  readonly number?: number;
  readonly state?: string;
  readonly body?: string | null;
  readonly labels?: ReadonlyArray<{ name?: string } | string>;
  readonly updated_at?: string;
  readonly created_at?: string;
}

export interface MirrorClassificationResult {
  readonly action: string;
  readonly reason: string;
  readonly ruleIndex: number;
  readonly ruleSource: string;
  readonly ruleKind: string;
  readonly resumeOn: string | null;
}

/** Injected classify engine — avoids a runtime import cycle with classify/index.ts. */
export interface LabelMirrorEngine {
  readonly classifyIssue: (
    issue: MirrorGitHubIssue,
    options?: {
      rules?: readonly unknown[];
      holdMarkers?: string[] | null;
      vbriefReferenced?: ReadonlySet<number> | null;
      hasTriageDecision?: boolean;
      now?: Date;
    },
  ) => MirrorClassificationResult | null;
  readonly resolveClassifyRules: (options?: {
    projectRoot?: string;
    projectDefinition?: Record<string, unknown> | null;
  }) => readonly unknown[];
  readonly resolveHoldMarkers: (options?: {
    projectRoot?: string;
    projectDefinition?: Record<string, unknown> | null;
  }) => string[];
  /** Optional; label-mirror prefers repo-qualified keys and only needs numbers as fallback. */
  readonly extractReferencedIssues?: (projectRoot?: string) => Set<number>;
}

/**
 * Repo-qualified xBRIEF github-issue keys (`owner/name\\0number`).
 * Unlike number-only extractReferencedIssues, this never collides across repos.
 */
export function extractReferencedRepoIssueKeys(
  projectRoot?: string,
  lifecycleFolders: readonly string[] = ["pending", "active"],
): Set<string> {
  const referenced = new Set<string>();
  let root: string;
  try {
    root = resolveLifecycleRoot(projectRoot ?? process.cwd());
  } catch {
    return referenced;
  }
  for (const folder of lifecycleFolders) {
    const folderPath = join(root, folder);
    let entries: string[];
    try {
      entries = readdirSync(folderPath).filter((f) => hasArtifactSuffix(f));
    } catch {
      continue;
    }
    for (const name of entries) {
      try {
        const raw = readFileSync(join(folderPath, name), { encoding: "utf8" });
        const data: unknown = JSON.parse(raw);
        if (typeof data !== "object" || data === null || Array.isArray(data)) {
          continue;
        }
        const plan = (data as Record<string, unknown>).plan;
        if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
          continue;
        }
        const refs = (plan as Record<string, unknown>).references ?? [];
        if (!Array.isArray(refs)) {
          continue;
        }
        for (const ref of refs) {
          if (typeof ref !== "object" || ref === null || Array.isArray(ref)) {
            continue;
          }
          const r = ref as Record<string, unknown>;
          if (!referenceTypeMatches(String(r.type ?? ""), "github-issue")) {
            continue;
          }
          const uri = r.uri;
          if (typeof uri !== "string") {
            continue;
          }
          const cleaned = uri.trim().replace(/\/+$/, "");
          const parts =
            cleaned
              .split("://")
              .pop()
              ?.split("/")
              .filter((p) => p.length > 0) ?? [];
          if (
            parts.length >= 4 &&
            parts[parts.length - 2] === "issues" &&
            /^\d+$/.test(parts[parts.length - 1] ?? "")
          ) {
            const owner = parts[parts.length - 4] ?? "";
            const repoName = parts[parts.length - 3] ?? "";
            const n = Number.parseInt(parts[parts.length - 1] ?? "", 10);
            if (owner.length > 0 && repoName.length > 0 && Number.isFinite(n)) {
              referenced.add(`${owner}/${repoName}\0${n}`.toLowerCase());
            }
          }
        }
      } catch {
        // tolerate corrupt artifacts
      }
    }
  }
  return referenced;
}

export interface LabelMirrorPolicy {
  /** When false, mirror is a no-op (default true when policy object is used). */
  readonly enabled?: boolean;
  /** Idempotency marker; issues already carrying this label are skipped. Default: triaged. */
  readonly idempotencyLabel?: string;
  /** Labels always applied on a successful classification (default: [idempotencyLabel]). */
  readonly alwaysLabels?: readonly string[];
  /** Map classify action -> additional labels to apply. */
  readonly actionLabels?: Readonly<Partial<Record<ClassifyAction, readonly string[]>>>;
}

export interface ResolvedLabelMirrorPolicy {
  readonly enabled: boolean;
  readonly idempotencyLabel: string;
  readonly alwaysLabels: readonly string[];
  readonly actionLabels: Readonly<Partial<Record<ClassifyAction, readonly string[]>>>;
}

export type LabelMirrorStatus =
  | "planned"
  | "applied"
  | "unchanged"
  | "skipped_already_triaged"
  | "skipped_no_match"
  | "skipped_unreadable"
  | "skipped_closed"
  | "skipped_author"
  | "skipped_disabled"
  | "error";

export interface LabelMirrorItem {
  readonly repo: string;
  readonly issue_number: number;
  /** Issue state from cache (open/closed/unknown). */
  readonly state: string | null;
  readonly action: string | null;
  readonly reason: string | null;
  readonly ruleKind: string | null;
  readonly current: readonly string[];
  readonly desired: readonly string[];
  readonly add: readonly string[];
  readonly status: LabelMirrorStatus;
  readonly message?: string;
  /**
   * True when this row re-planned an issue that already carried the idempotency
   * label under opt-in re-enrich mode (#3197). Distinguishes first-time stamp
   * rows from re-enrich additive backfill in dry-run digests.
   */
  readonly re_enrich?: boolean;
}

/** Operator digest aggregates for bootstrap mass-triage (#3125 / #1423 Wave 2). */
export interface LabelMirrorDigest {
  readonly by_state: Readonly<Record<string, number>>;
  readonly by_rule: Readonly<Record<string, number>>;
  readonly by_action: Readonly<Record<string, number>>;
  readonly samples: readonly LabelMirrorItem[];
  readonly sample_limit: number;
  readonly sample_truncated: boolean;
}

export interface LabelMirrorFilters {
  /** When false (default), closed issues are skipped before classify. */
  readonly include_closed: boolean;
  readonly repo: string | null;
  /** Active author allow-list display (#3129); null when no author filter. */
  readonly author: string | null;
  /** Resolved author logins for machine consumers. */
  readonly author_logins: readonly string[] | null;
  /** Whether this run used opt-in re-enrich mode (#3197). */
  readonly re_enrich: boolean;
}

export interface LabelMirrorOutcome {
  readonly project_root: string;
  readonly dry_run: boolean;
  readonly scanned: number;
  readonly planned: number;
  readonly applied: number;
  readonly unchanged: number;
  readonly skipped_already_triaged: number;
  readonly skipped_no_match: number;
  readonly skipped_unreadable: number;
  /** Closed issues skipped by open-only default (#3125). */
  readonly skipped_closed: number;
  /** Issues skipped by --author filter (#3129). */
  readonly skipped_author: number;
  readonly errors: number;
  /**
   * Planned rows that re-enriched already-stamped issues (subset of planned; #3197).
   * Zero when re_enrich mode is off.
   */
  readonly re_enrich_planned: number;
  /**
   * Applied rows that re-enriched already-stamped issues (subset of applied; #3197).
   * Zero when re_enrich mode is off.
   */
  readonly re_enrich_applied: number;
  readonly filters: LabelMirrorFilters;
  readonly digest: LabelMirrorDigest;
  readonly items: readonly LabelMirrorItem[];
  readonly policy: ResolvedLabelMirrorPolicy;
  /** Apply path: successful writes in this run (same as applied). */
  readonly batch_size?: number;
  readonly delay_ms?: number;
}

export type LabelMirrorSleepFn = (ms: number) => void;

export interface LabelMirrorOptions {
  readonly dryRun?: boolean;
  readonly repo?: string | null;
  readonly cacheRoot?: string;
  readonly client?: LabelClient;
  readonly allowCrossRepo?: boolean;
  readonly repoAllowlist?: readonly string[];
  /** Prefer live SCM labels when true (default: !dryRun). Cache labels used for dry-run. */
  readonly useLiveLabels?: boolean;
  readonly now?: Date;
  /**
   * Include closed issues in classify+mirror. Default false (open-only) for safe
   * bootstrap mass-triage (#3125). Opt in with CLI `--include-closed`.
   */
  readonly includeClosed?: boolean;
  /**
   * Resolved author filter applied before plan/apply walk (#3129).
   * Composes with open-only (AND). CLI resolves `@me` before passing this.
   */
  readonly authorFilter?: AuthorFilter | null;
  /** Max planned/applied samples in human digest (default 15). */
  readonly sampleLimit?: number;
  /** SCM writes per batch before delay (default 10; apply path only). */
  readonly batchSize?: number;
  /** Delay in ms between apply batches (default 1000; apply path only). */
  readonly delayMs?: number;
  /** Injectable sleep for tests (receives ms). Default busy-wait when delayMs > 0. */
  readonly sleepMs?: LabelMirrorSleepFn;
  /**
   * Opt-in re-enrich mode (#3197): re-classify issues that already carry the
   * idempotency label and plan **additive** label deltas only (no removals).
   * Default false preserves one-shot `skipped_already_triaged` behavior.
   * Still dry-run by default; pair with dryRun:false / CLI `--apply` to write.
   * Never triage:accept / never xBRIEF writes.
   */
  readonly reEnrich?: boolean;
  /** Required: classify engine (provided by classify/index mirrorLabels wrapper). */
  readonly engine: LabelMirrorEngine;
}

function asStringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) {
      return null;
    }
    out.push(item);
  }
  return out;
}

function sanitizeReportFragment(value: string): string {
  return value.replace(/\r?\n/g, " ");
}

/** Validate plan.policy.triageLabelMirror payload. */
export function validateLabelMirrorPolicy(raw: unknown): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (raw === undefined || raw === null) {
    return { errors, warnings };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    errors.push("plan.policy.triageLabelMirror must be an object");
    return { errors, warnings };
  }
  const obj = raw as Record<string, unknown>;
  if ("enabled" in obj && typeof obj.enabled !== "boolean") {
    errors.push("plan.policy.triageLabelMirror.enabled must be a boolean when set");
  }
  if ("idempotencyLabel" in obj) {
    if (typeof obj.idempotencyLabel !== "string" || obj.idempotencyLabel.trim().length === 0) {
      errors.push("plan.policy.triageLabelMirror.idempotencyLabel must be a non-empty string");
    }
  }
  if ("alwaysLabels" in obj) {
    const list = asStringList(obj.alwaysLabels);
    if (list === null) {
      errors.push("plan.policy.triageLabelMirror.alwaysLabels must be a list of non-empty strings");
    }
  }
  if ("actionLabels" in obj) {
    const al = obj.actionLabels;
    if (typeof al !== "object" || al === null || Array.isArray(al)) {
      errors.push("plan.policy.triageLabelMirror.actionLabels must be an object");
    } else {
      for (const [key, value] of Object.entries(al as Record<string, unknown>)) {
        if (!VALID_ACTIONS.has(key)) {
          errors.push(
            `plan.policy.triageLabelMirror.actionLabels.${key}: action must be one of ${[...VALID_ACTIONS].sort().join(", ")}`,
          );
          continue;
        }
        const list = asStringList(value);
        if (list === null) {
          errors.push(
            `plan.policy.triageLabelMirror.actionLabels.${key} must be a list of non-empty strings`,
          );
        }
      }
    }
  }
  const known = new Set(["enabled", "idempotencyLabel", "alwaysLabels", "actionLabels"]);
  const extra = Object.keys(obj)
    .filter((k) => !known.has(k))
    .sort();
  if (extra.length > 0) {
    warnings.push(
      `plan.policy.triageLabelMirror: ignoring unrecognised key(s) ${extra.join(", ")}`,
    );
  }
  return { errors, warnings };
}

/** Default resolved policy when triageLabelMirror is absent. */
export function defaultLabelMirrorPolicy(): ResolvedLabelMirrorPolicy {
  return {
    enabled: true,
    idempotencyLabel: DEFAULT_IDEMPOTENCY_LABEL,
    alwaysLabels: [DEFAULT_IDEMPOTENCY_LABEL],
    actionLabels: {},
  };
}

function loadProjectDefinition(projectRoot: string): Record<string, unknown> | null {
  let path: string;
  try {
    path = resolveProjectDefinitionPath(projectRoot);
  } catch {
    path = join(projectRoot, "xbrief", "PROJECT-DEFINITION.xbrief.json");
  }
  try {
    const raw = readFileSync(path, { encoding: "utf8" });
    const data: unknown = JSON.parse(raw);
    return typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Resolve effective label-mirror policy from PROJECT-DEFINITION or inline object. */
export function resolveLabelMirrorPolicy(options?: {
  projectRoot?: string;
  projectDefinition?: Record<string, unknown> | null;
  override?: LabelMirrorPolicy | null;
}): ResolvedLabelMirrorPolicy {
  if (options?.override !== undefined && options.override !== null) {
    return materializePolicy(options.override);
  }
  const data =
    options?.projectDefinition !== undefined
      ? options.projectDefinition
      : loadProjectDefinition(options?.projectRoot ?? process.cwd());
  if (data === null) {
    return defaultLabelMirrorPolicy();
  }
  const plan = data.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return defaultLabelMirrorPolicy();
  }
  const policy = readPlanPolicy(plan);
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    return defaultLabelMirrorPolicy();
  }
  const raw = (policy as Record<string, unknown>).triageLabelMirror;
  if (raw === undefined || raw === null) {
    return defaultLabelMirrorPolicy();
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return defaultLabelMirrorPolicy();
  }
  return materializePolicy(raw as LabelMirrorPolicy);
}

function materializePolicy(raw: LabelMirrorPolicy): ResolvedLabelMirrorPolicy {
  const idempotencyLabel =
    typeof raw.idempotencyLabel === "string" && raw.idempotencyLabel.trim().length > 0
      ? raw.idempotencyLabel.trim()
      : DEFAULT_IDEMPOTENCY_LABEL;
  const alwaysFromPolicy = asStringList(raw.alwaysLabels ?? null);
  const alwaysLabels =
    alwaysFromPolicy !== null ? alwaysFromPolicy : [idempotencyLabel].filter((x) => x.length > 0);
  const actionLabels: Partial<Record<ClassifyAction, readonly string[]>> = {};
  const al = raw.actionLabels;
  if (typeof al === "object" && al !== null && !Array.isArray(al)) {
    for (const action of VALID_ACTIONS) {
      const list = asStringList((al as Record<string, unknown>)[action]);
      if (list !== null && list.length > 0) {
        actionLabels[action as ClassifyAction] = list;
      }
    }
  }
  return {
    enabled: raw.enabled !== false,
    idempotencyLabel,
    alwaysLabels,
    actionLabels,
  };
}

/** Labels to apply for a classified action (always + action-mapped). */
export function desiredLabelsForClassification(
  action: string,
  policy: ResolvedLabelMirrorPolicy,
): string[] {
  const desired = new Set<string>(policy.alwaysLabels);
  const mapped = policy.actionLabels[action as ClassifyAction];
  if (mapped !== undefined) {
    for (const label of mapped) {
      desired.add(label);
    }
  }
  // Always include the idempotency marker even if alwaysLabels was customized empty.
  if (policy.idempotencyLabel.length > 0) {
    desired.add(policy.idempotencyLabel);
  }
  return [...desired].sort();
}

function issueLabelNames(issue: MirrorGitHubIssue): string[] {
  const raw = issue.labels ?? [];
  const names: string[] = [];
  if (!Array.isArray(raw)) {
    return names;
  }
  for (const item of raw) {
    if (typeof item === "object" && item !== null && "name" in item) {
      const name = item.name;
      if (typeof name === "string" && name.length > 0) {
        names.push(name);
      }
    } else if (typeof item === "string" && item.length > 0) {
      names.push(item);
    }
  }
  return names;
}

function readCachedRawIssue(
  cacheRoot: string,
  repo: string,
  issueNumber: number,
): MirrorGitHubIssue | null {
  const [owner, name] = repo.split("/", 2);
  const rawPath = join(
    cacheRoot,
    CACHE_SOURCE,
    owner ?? "",
    name ?? "",
    String(issueNumber),
    "raw.json",
  );
  if (!existsSync(rawPath)) {
    return null;
  }
  try {
    const data: unknown = JSON.parse(readFileSync(rawPath, { encoding: "utf8" }));
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return null;
    }
    return data as MirrorGitHubIssue;
  } catch {
    return null;
  }
}

/** Load latest decisions as Map keyed by `repo\0number` for hasTriageDecision. */
function loadLatestDecisionMap(projectRoot: string): ReadonlyMap<string, string> {
  try {
    const path = resolveCandidatesLogPath(projectRoot);
    return latestDecisions(readAuditLog(path));
  } catch {
    return new Map();
  }
}

function decisionMapHas(
  map: ReadonlyMap<string, string>,
  repo: string,
  issueNumber: number,
): boolean {
  return map.has(`${repo}\0${issueNumber}`);
}

function defaultSleepMs(ms: number): void {
  if (ms <= 0) {
    return;
  }
  // Sync sleep: LabelClient.apply is sync; keep mirrorLabels non-async (#3125).
  const sab = new SharedArrayBuffer(4);
  const ia = new Int32Array(sab);
  Atomics.wait(ia, 0, 0, ms);
}

function normalizeIssueState(raw: string | undefined): string | null {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return null;
  }
  return raw.trim().toLowerCase();
}

function isClosedState(state: string | null): boolean {
  return state === "closed";
}

/** Build digest aggregates + samples from mirror items (#3125). */
export function buildLabelMirrorDigest(
  items: readonly LabelMirrorItem[],
  sampleLimit: number = DEFAULT_DIGEST_SAMPLE_LIMIT,
): LabelMirrorDigest {
  const limit =
    Number.isFinite(sampleLimit) && sampleLimit >= 0
      ? Math.floor(sampleLimit)
      : DEFAULT_DIGEST_SAMPLE_LIMIT;
  const byState: Record<string, number> = {};
  const byRule: Record<string, number> = {};
  const byAction: Record<string, number> = {};
  const writeItems = items.filter((i) => i.status === "planned" || i.status === "applied");
  for (const item of writeItems) {
    const st = item.state ?? "unknown";
    byState[st] = (byState[st] ?? 0) + 1;
    const rule = item.ruleKind ?? "(none)";
    byRule[rule] = (byRule[rule] ?? 0) + 1;
    const action = item.action ?? "(none)";
    byAction[action] = (byAction[action] ?? 0) + 1;
  }
  const samples = writeItems.slice(0, limit);
  return {
    by_state: byState,
    by_rule: byRule,
    by_action: byAction,
    samples,
    sample_limit: limit,
    sample_truncated: writeItems.length > limit,
  };
}

function formatMissingLabelHint(message: string, labels: readonly string[]): string {
  const lower = message.toLowerCase();
  const looksMissing =
    lower.includes("not found") ||
    lower.includes("could not add label") ||
    lower.includes("invalid label") ||
    lower.includes("unknown label") ||
    (lower.includes("label") && (lower.includes("404") || lower.includes("does not exist")));
  if (!looksMissing) {
    return message;
  }
  const want = labels.length > 0 ? labels.join(", ") : "triaged";
  return (
    `${message} — ensure label(s) exist on the repo before --apply ` +
    `(create missing labels e.g. \`gh label create "${want.split(",")[0]?.trim() ?? "triaged"}"\`; ` +
    `idempotency + actionLabels must exist or apply fails closed per issue).`
  );
}

/**
 * Run Tier-1 label mirror over the github-issue cache (bootstrap mass-triage surface).
 * Dry-run by default (no SCM writes). Pass dryRun: false to apply.
 * Default state filter is open-only (#3125); pass includeClosed: true for archive stamps.
 * Requires options.engine (classify/index wrapper injects it).
 * Never calls triage:accept / never writes proposed/ xBRIEFs.
 */
export function mirrorLabels(
  projectRoot: string,
  options: LabelMirrorOptions,
): [number, LabelMirrorOutcome] {
  const root = resolve(projectRoot);
  const dryRun = options.dryRun ?? true;
  const policy = resolveLabelMirrorPolicy({ projectRoot: root });
  const cacheRoot = options.cacheRoot ?? join(root, CACHE_DIR_NAME);
  const useLiveLabels = options.useLiveLabels ?? !dryRun;
  const client = options.client ?? (useLiveLabels || !dryRun ? new ScmLabelClient() : undefined);
  const engine = options.engine;
  const includeClosed = options.includeClosed === true;
  const authorFilter =
    options.authorFilter !== undefined && options.authorFilter !== null
      ? options.authorFilter
      : null;
  const sampleLimit = options.sampleLimit ?? DEFAULT_DIGEST_SAMPLE_LIMIT;
  const reEnrich = options.reEnrich === true;
  const batchSize =
    options.batchSize !== undefined
      ? Math.max(1, Math.floor(options.batchSize))
      : DEFAULT_APPLY_BATCH_SIZE;
  const delayMs =
    options.delayMs !== undefined && options.delayMs >= 0
      ? Math.floor(options.delayMs)
      : dryRun
        ? 0
        : DEFAULT_APPLY_DELAY_MS;
  const sleepMs = options.sleepMs ?? defaultSleepMs;
  const repoFilter =
    options.repo !== undefined && options.repo !== null && options.repo.trim().length > 0
      ? options.repo.trim()
      : null;

  const filters: LabelMirrorFilters = {
    include_closed: includeClosed,
    repo: repoFilter,
    author: authorFilter !== null ? authorFilter.display : null,
    author_logins: authorFilter !== null ? authorFilter.allowLogins : null,
    re_enrich: reEnrich,
  };

  const items: LabelMirrorItem[] = [];
  const outcomeBase = {
    project_root: root,
    dry_run: dryRun,
    policy,
    filters,
    batch_size: dryRun ? undefined : batchSize,
    delay_ms: dryRun ? undefined : delayMs,
  };

  const emptyDigest = buildLabelMirrorDigest([], sampleLimit);

  if (!policy.enabled) {
    return [
      0,
      {
        ...outcomeBase,
        scanned: 0,
        planned: 0,
        applied: 0,
        unchanged: 0,
        skipped_already_triaged: 0,
        skipped_no_match: 0,
        skipped_unreadable: 0,
        skipped_closed: 0,
        skipped_author: 0,
        re_enrich_planned: 0,
        re_enrich_applied: 0,
        errors: 0,
        digest: emptyDigest,
        items: [
          {
            repo: "",
            issue_number: 0,
            state: null,
            action: null,
            reason: null,
            ruleKind: null,
            current: [],
            desired: [],
            add: [],
            status: "skipped_disabled",
            message: "plan.policy.triageLabelMirror.enabled is false",
          },
        ],
      },
    ];
  }

  const rules = engine.resolveClassifyRules({ projectRoot: root });
  const holdMarkers = engine.resolveHoldMarkers({ projectRoot: root });
  // Repo-qualified xBRIEF keys avoid number-only collisions across multi-repo
  // caches and do not require project identity (#1423 Greptile P1 class).
  const referencedKeys = extractReferencedRepoIssueKeys(root);
  const decisions = loadLatestDecisionMap(root);
  const now = options.now ?? new Date();

  let pairs = iterCachedIssues(cacheRoot);
  if (repoFilter !== null) {
    const want = repoFilter.toLowerCase();
    pairs = pairs.filter(([repo]) => repo.toLowerCase() === want);
  }

  let planned = 0;
  let applied = 0;
  let unchanged = 0;
  let skippedAlready = 0;
  let skippedNoMatch = 0;
  let skippedUnreadable = 0;
  let skippedClosed = 0;
  let skippedAuthor = 0;
  let reEnrichPlanned = 0;
  let reEnrichApplied = 0;
  let errors = 0;
  let applyWritesSinceSleep = 0;

  for (const [repo, issueNumber] of pairs) {
    const issue = readCachedRawIssue(cacheRoot, repo, issueNumber);
    if (issue === null) {
      skippedUnreadable += 1;
      items.push({
        repo,
        issue_number: issueNumber,
        state: null,
        action: null,
        reason: null,
        ruleKind: null,
        current: [],
        desired: [],
        add: [],
        status: "skipped_unreadable",
        message: "missing or unreadable raw.json",
      });
      continue;
    }

    const state = normalizeIssueState(issue.state);

    // Open-only default: skip closed before classify (avoids mass-stamping archive).
    if (!includeClosed && isClosedState(state)) {
      skippedClosed += 1;
      items.push({
        repo,
        issue_number: issueNumber,
        state,
        action: null,
        reason: null,
        ruleKind: null,
        current: issueLabelNames(issue).sort(),
        desired: [],
        add: [],
        status: "skipped_closed",
        message: "open-only default; pass includeClosed / --include-closed to mirror closed issues",
      });
      continue;
    }

    // Author filter (#3129): AND with open-only / other filters; missing author = non-match.
    if (authorFilter !== null) {
      const login = authorLoginFromRawIssue(issue as Record<string, unknown>);
      if (!matchesAuthorFilter(login, authorFilter)) {
        skippedAuthor += 1;
        items.push({
          repo,
          issue_number: issueNumber,
          state,
          action: null,
          reason: null,
          ruleKind: null,
          current: issueLabelNames(issue).sort(),
          desired: [],
          add: [],
          status: "skipped_author",
          message:
            login === null
              ? `author filter ${authorFilter.display}: missing author on cache row (unknown — excluded)`
              : `author filter ${authorFilter.display}: author.login=${login} does not match`,
        });
        continue;
      }
    }

    let current: string[];
    if (useLiveLabels && client !== undefined) {
      try {
        current = client.fetchLabels(repo, issueNumber);
      } catch (exc) {
        current = issueLabelNames(issue);
        if (!dryRun) {
          errors += 1;
          items.push({
            repo,
            issue_number: issueNumber,
            state,
            action: null,
            reason: null,
            ruleKind: null,
            current,
            desired: [],
            add: [],
            status: "error",
            message: `fetchLabels failed: ${exc instanceof Error ? exc.message : String(exc)}`,
          });
          continue;
        }
      }
    } else {
      current = issueLabelNames(issue);
    }

    // Default one-shot: already stamped → skip. Opt-in --re-enrich continues past
    // the stamp and plans additive deltas only (#3197; never removals in v1).
    const alreadyStamped =
      policy.idempotencyLabel.length > 0 && current.includes(policy.idempotencyLabel);
    if (alreadyStamped && !reEnrich) {
      skippedAlready += 1;
      items.push({
        repo,
        issue_number: issueNumber,
        state,
        action: null,
        reason: null,
        ruleKind: null,
        current: [...current].sort(),
        desired: [...current].sort(),
        add: [],
        status: "skipped_already_triaged",
        message: `already has ${policy.idempotencyLabel}`,
      });
      continue;
    }
    const isReEnrichRow = alreadyStamped && reEnrich;

    // Pass number set only when this exact repo+number is referenced from xBRIEF.
    const key = `${repo.toLowerCase()}\0${issueNumber}`;
    const vbriefReferenced = referencedKeys.has(key)
      ? new Set<number>([issueNumber])
      : new Set<number>();

    const classification = engine.classifyIssue(issue, {
      rules: rules as never,
      holdMarkers,
      vbriefReferenced,
      hasTriageDecision: decisionMapHas(decisions, repo, issueNumber),
      now,
    });

    if (classification === null) {
      // Re-enrich of a stamped issue with no current rule match: leave labels as-is
      // (additive-only v1 never strips triaged / action chips). Count as unchanged.
      if (isReEnrichRow) {
        unchanged += 1;
        items.push({
          repo,
          issue_number: issueNumber,
          state,
          action: null,
          reason: null,
          ruleKind: null,
          current: [...current].sort(),
          desired: [...current].sort(),
          add: [],
          status: "unchanged",
          re_enrich: true,
          message: `re-enrich: no classify match; left existing labels (incl. ${policy.idempotencyLabel})`,
        });
        continue;
      }
      skippedNoMatch += 1;
      items.push({
        repo,
        issue_number: issueNumber,
        state,
        action: null,
        reason: null,
        ruleKind: null,
        current: [...current].sort(),
        desired: [],
        add: [],
        status: "skipped_no_match",
      });
      continue;
    }

    const desired = desiredLabelsForClassification(classification.action, policy);
    const currentSet = new Set(current);
    // Additive-only: never plan removals even under re-enrich (#3197 v1).
    const add = desired.filter((label) => !currentSet.has(label)).sort();
    const reEnrichFlag = isReEnrichRow ? ({ re_enrich: true } as const) : {};

    if (add.length === 0) {
      unchanged += 1;
      items.push({
        repo,
        issue_number: issueNumber,
        state,
        action: classification.action,
        reason: classification.reason,
        ruleKind: classification.ruleKind,
        current: [...current].sort(),
        desired,
        add: [],
        status: "unchanged",
        ...reEnrichFlag,
      });
      continue;
    }

    if (dryRun) {
      planned += 1;
      if (isReEnrichRow) {
        reEnrichPlanned += 1;
      }
      items.push({
        repo,
        issue_number: issueNumber,
        state,
        action: classification.action,
        reason: classification.reason,
        ruleKind: classification.ruleKind,
        current: [...current].sort(),
        desired,
        add,
        status: "planned",
        ...reEnrichFlag,
      });
      continue;
    }

    // --apply path: SCM boundary + write (batched + delay for rate-limit awareness)
    const mutateGate = isRepoMutationAllowed(repo, root, {
      allowCrossRepo: options.allowCrossRepo,
      allowlist: options.repoAllowlist,
      explicitRepo: options.repo ?? null,
    });
    if (!mutateGate.allowed) {
      errors += 1;
      items.push({
        repo,
        issue_number: issueNumber,
        state,
        action: classification.action,
        reason: classification.reason,
        ruleKind: classification.ruleKind,
        current: [...current].sort(),
        desired,
        add,
        status: "error",
        message: mutateGate.reason ?? `refusing cross-repo mutation on ${repo}`,
        ...reEnrichFlag,
      });
      continue;
    }

    if (client === undefined) {
      errors += 1;
      items.push({
        repo,
        issue_number: issueNumber,
        state,
        action: classification.action,
        reason: classification.reason,
        ruleKind: classification.ruleKind,
        current: [...current].sort(),
        desired,
        add,
        status: "error",
        message: "no LabelClient available for apply",
        ...reEnrichFlag,
      });
      continue;
    }

    try {
      // Count every SCM write *attempt* toward the batch (including failures) so
      // rate-limit delay still applies under partial failure storms (#3125 Greptile P1).
      if (applyWritesSinceSleep > 0 && applyWritesSinceSleep % batchSize === 0 && delayMs > 0) {
        sleepMs(delayMs);
      }
      applyWritesSinceSleep += 1;
      // Additive-only: remove list is always empty (never strip labels; #3197).
      client.apply(repo, issueNumber, add, []);
      applied += 1;
      if (isReEnrichRow) {
        reEnrichApplied += 1;
      }
      items.push({
        repo,
        issue_number: issueNumber,
        state,
        action: classification.action,
        reason: classification.reason,
        ruleKind: classification.ruleKind,
        current: [...current].sort(),
        desired,
        add,
        status: "applied",
        ...reEnrichFlag,
      });
    } catch (exc) {
      errors += 1;
      const rawMsg = exc instanceof Error ? exc.message : String(exc);
      items.push({
        repo,
        issue_number: issueNumber,
        state,
        action: classification.action,
        reason: classification.reason,
        ruleKind: classification.ruleKind,
        current: [...current].sort(),
        desired,
        add,
        status: "error",
        message: formatMissingLabelHint(rawMsg, add),
        ...reEnrichFlag,
      });
      // Partial failure: continue remaining issues (idempotent re-run skips applied).
    }
  }

  const digest = buildLabelMirrorDigest(items, sampleLimit);
  const outcome: LabelMirrorOutcome = {
    ...outcomeBase,
    scanned: pairs.length,
    planned,
    applied,
    unchanged,
    skipped_already_triaged: skippedAlready,
    skipped_no_match: skippedNoMatch,
    skipped_unreadable: skippedUnreadable,
    skipped_closed: skippedClosed,
    skipped_author: skippedAuthor,
    re_enrich_planned: reEnrichPlanned,
    re_enrich_applied: reEnrichApplied,
    errors,
    digest,
    items,
  };
  return [errors > 0 ? 1 : 0, outcome];
}

function formatCountMap(map: Readonly<Record<string, number>>): string[] {
  const keys = Object.keys(map).sort();
  if (keys.length === 0) {
    return ["  (none)"];
  }
  return keys.map((k) => `  ${k}: ${map[k]}`);
}

/** Human-readable digest for dry-run / apply reports (bootstrap mass-triage UX). */
export function renderLabelMirrorReport(outcome: LabelMirrorOutcome): string {
  const lines: string[] = [];
  const mode = outcome.dry_run ? "dry-run" : "apply";
  const reEnrichOn = outcome.filters.re_enrich === true;
  lines.push(
    reEnrichOn
      ? `triage:classify --mirror --re-enrich (${mode}) — additive re-enrich (#3197 / #1423)`
      : `triage:classify --mirror (${mode}) — bootstrap mass-triage (#1423 Wave 2)`,
  );
  const stateFilter = outcome.filters.include_closed ? "all (include-closed)" : "open-only";
  const repoPart = outcome.filters.repo ?? "*";
  const authorPart = outcome.filters.author ?? "*";
  const reEnrichPart = reEnrichOn ? "on (additive-only)" : "off";
  lines.push(
    `filters: state=${stateFilter} repo=${repoPart} author=${authorPart} re_enrich=${reEnrichPart}`,
  );
  const firstTimePlanned = Math.max(0, outcome.planned - outcome.re_enrich_planned);
  const firstTimeApplied = Math.max(0, outcome.applied - outcome.re_enrich_applied);
  lines.push(
    `scanned=${outcome.scanned} planned=${outcome.planned} applied=${outcome.applied} ` +
      `unchanged=${outcome.unchanged} already_triaged=${outcome.skipped_already_triaged} ` +
      `no_match=${outcome.skipped_no_match} closed_skipped=${outcome.skipped_closed} ` +
      `author_skipped=${outcome.skipped_author} ` +
      `unreadable=${outcome.skipped_unreadable} errors=${outcome.errors}`,
  );
  // Distinguish first-time stamp rows vs re-enrich additive backfill (#3197 / #3124 re-run vs re-enrich).
  lines.push(
    `planned_kind: first_time=${firstTimePlanned} re_enrich=${outcome.re_enrich_planned}` +
      (outcome.dry_run
        ? ""
        : ` | applied_kind: first_time=${firstTimeApplied} re_enrich=${outcome.re_enrich_applied}`),
  );
  lines.push(
    `idempotencyLabel=${outcome.policy.idempotencyLabel} alwaysLabels=${JSON.stringify(outcome.policy.alwaysLabels)}`,
  );
  if (!outcome.dry_run) {
    lines.push(
      `apply: batch_size=${outcome.batch_size ?? DEFAULT_APPLY_BATCH_SIZE} delay_ms=${outcome.delay_ms ?? DEFAULT_APPLY_DELAY_MS}`,
    );
  }
  lines.push("");

  lines.push("By state (planned/applied):");
  lines.push(...formatCountMap(outcome.digest.by_state));
  lines.push("By rule (planned/applied):");
  lines.push(...formatCountMap(outcome.digest.by_rule));
  lines.push("By action (planned/applied):");
  lines.push(...formatCountMap(outcome.digest.by_action));
  lines.push("");

  const writeTotal = outcome.planned + outcome.applied;
  lines.push(
    outcome.dry_run
      ? `Samples (up to ${outcome.digest.sample_limit} of ${writeTotal} planned):`
      : `Samples (up to ${outcome.digest.sample_limit} of ${writeTotal} applied/planned):`,
  );
  if (outcome.digest.samples.length === 0) {
    lines.push("- none");
  } else {
    for (const item of outcome.digest.samples) {
      const actionPart = item.action !== null ? ` action=${item.action}` : "";
      const rulePart = item.ruleKind !== null ? ` rule=${item.ruleKind}` : "";
      const statePart = item.state !== null ? ` state=${item.state}` : "";
      const kindPart = item.re_enrich === true ? " kind=re-enrich" : " kind=first-time";
      const addPart = sanitizeReportFragment(item.add.join(", +"));
      lines.push(
        `- ${item.repo}#${item.issue_number}:${statePart}${actionPart}${rulePart}${kindPart} +${addPart}`,
      );
    }
    if (outcome.digest.sample_truncated) {
      const remaining = writeTotal - outcome.digest.samples.length;
      lines.push(`… and ${remaining} more (use --json for full items list)`);
    }
  }

  if (outcome.skipped_closed > 0) {
    lines.push("");
    lines.push(
      `Skipped closed (open-only default): ${outcome.skipped_closed} — re-run with --include-closed to include archive`,
    );
  }

  if (outcome.skipped_author > 0) {
    lines.push("");
    lines.push(
      `Skipped (author filter ${outcome.filters.author ?? "?"}): ${outcome.skipped_author}`,
    );
  }

  const already = outcome.items.filter((i) => i.status === "skipped_already_triaged");
  if (already.length > 0) {
    lines.push("");
    lines.push(`Skipped (already ${outcome.policy.idempotencyLabel}): ${already.length}`);
    if (!reEnrichOn) {
      lines.push(
        "  Tip: after actionLabels / rule changes, use --mirror --re-enrich (dry-run) to plan additive chips on already-stamped issues (#3197; re-run vs re-enrich #3124).",
      );
    }
  }

  const noMatch = outcome.items.filter((i) => i.status === "skipped_no_match");
  if (noMatch.length > 0) {
    lines.push(`Skipped (no classify match): ${noMatch.length}`);
  }

  const errs = outcome.items.filter((i) => i.status === "error");
  if (errs.length > 0) {
    lines.push("");
    lines.push(`Errors (partial failure report; ${errs.length} of ${outcome.scanned}):`);
    for (const item of errs) {
      const msg = sanitizeReportFragment(item.message ?? "unknown error");
      lines.push(`- ${item.repo}#${item.issue_number}: ${msg}`);
    }
  }

  if (outcome.dry_run && writeTotal > 0) {
    lines.push("");
    lines.push(
      reEnrichOn
        ? "Dry-run — re-run with --mirror --re-enrich --apply to write additive labels via SCM (batched; never triage:accept; never removals)."
        : "Dry-run — re-run with --mirror --apply to write these labels via SCM (batched; never triage:accept).",
    );
  }

  return `${lines.join("\n")}\n`;
}

/** JSON-serializable outcome including Wave 2 digest aggregates. */
export function labelMirrorOutcomeToJson(outcome: LabelMirrorOutcome): Record<string, unknown> {
  return {
    project_root: outcome.project_root,
    dry_run: outcome.dry_run,
    scanned: outcome.scanned,
    planned: outcome.planned,
    applied: outcome.applied,
    unchanged: outcome.unchanged,
    skipped_already_triaged: outcome.skipped_already_triaged,
    skipped_no_match: outcome.skipped_no_match,
    skipped_unreadable: outcome.skipped_unreadable,
    skipped_closed: outcome.skipped_closed,
    skipped_author: outcome.skipped_author,
    re_enrich_planned: outcome.re_enrich_planned,
    re_enrich_applied: outcome.re_enrich_applied,
    errors: outcome.errors,
    filters: {
      include_closed: outcome.filters.include_closed,
      repo: outcome.filters.repo,
      author: outcome.filters.author,
      author_logins: outcome.filters.author_logins,
      re_enrich: outcome.filters.re_enrich,
    },
    digest: {
      by_state: { ...outcome.digest.by_state },
      by_rule: { ...outcome.digest.by_rule },
      by_action: { ...outcome.digest.by_action },
      sample_limit: outcome.digest.sample_limit,
      sample_truncated: outcome.digest.sample_truncated,
      samples: outcome.digest.samples.map((i) => itemToJson(i)),
    },
    ...(outcome.batch_size !== undefined ? { batch_size: outcome.batch_size } : {}),
    ...(outcome.delay_ms !== undefined ? { delay_ms: outcome.delay_ms } : {}),
    policy: {
      enabled: outcome.policy.enabled,
      idempotencyLabel: outcome.policy.idempotencyLabel,
      alwaysLabels: [...outcome.policy.alwaysLabels],
      actionLabels: Object.fromEntries(
        Object.entries(outcome.policy.actionLabels).map(([k, v]) => [k, [...(v ?? [])]]),
      ),
    },
    items: outcome.items.map((i) => itemToJson(i)),
  };
}

function itemToJson(i: LabelMirrorItem): Record<string, unknown> {
  return {
    repo: i.repo,
    issue_number: i.issue_number,
    state: i.state,
    action: i.action,
    reason: i.reason,
    ruleKind: i.ruleKind,
    current: [...i.current],
    desired: [...i.desired],
    add: [...i.add],
    status: i.status,
    ...(i.message !== undefined ? { message: i.message } : {}),
    ...(i.re_enrich === true ? { re_enrich: true } : {}),
  };
}

/** Validate triageLabelMirror on a plan object (vbrief_validate hook). */
export function validateTriageLabelMirrorOnPlan(plan: unknown, filepath: string): string[] {
  const out: string[] = [];
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return out;
  }
  const policy = readPlanPolicy(plan);
  const raw =
    typeof policy === "object" && policy !== null && !Array.isArray(policy)
      ? (policy as Record<string, unknown>).triageLabelMirror
      : undefined;
  if (raw === undefined || raw === null) {
    return out;
  }
  const { errors } = validateLabelMirrorPolicy(raw);
  for (const err of errors) {
    out.push(`${filepath}: ${err} (#1423)`);
  }
  return out;
}
