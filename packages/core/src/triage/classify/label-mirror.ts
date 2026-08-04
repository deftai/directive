/**
 * Tier-1 deterministic SCM label mirror (#1423 Wave 1).
 *
 * Classifies cached issues with the existing #1129 engine, then mirrors the
 * outcome as SCM labels (dry-run default, --apply to write). Never accepts into
 * the xBRIEF lifecycle and never writes proposed/ scopes.
 *
 * Intentionally does NOT import from ./index.js (SLizard P1 cycle). The classify
 * engine is injected via LabelMirrorEngine / mirrorLabels() wrapper in index.ts.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveProjectDefinitionPath } from "../../layout/resolve.js";
import { readPlanPolicy } from "../../policy/plan-extensions.js";
import { ScmLabelClient } from "../../vbrief-reconcile/labels.js";
import { isRepoMutationAllowed } from "../../vbrief-reconcile/repo-guard.js";
import type { LabelClient } from "../../vbrief-reconcile/types.js";
import { latestDecisions, readAuditLog } from "../actions/candidates-log.js";
import { resolveCandidatesLogPath } from "../cache-path.js";
import { resolveRepo } from "../queue/repo.js";
import { iterCachedIssues } from "../summary/index.js";

export const DEFAULT_IDEMPOTENCY_LABEL = "triaged";
export const CACHE_DIR_NAME = ".deft-cache";
export const CACHE_SOURCE = "github-issue";

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
  readonly extractReferencedIssues: (projectRoot?: string) => Set<number>;
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
  | "skipped_disabled"
  | "error";

export interface LabelMirrorItem {
  readonly repo: string;
  readonly issue_number: number;
  readonly action: string | null;
  readonly reason: string | null;
  readonly ruleKind: string | null;
  readonly current: readonly string[];
  readonly desired: readonly string[];
  readonly add: readonly string[];
  readonly status: LabelMirrorStatus;
  readonly message?: string;
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
  readonly errors: number;
  readonly items: readonly LabelMirrorItem[];
  readonly policy: ResolvedLabelMirrorPolicy;
}

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

/**
 * Run Tier-1 label mirror over the github-issue cache.
 * Dry-run by default (no SCM writes). Pass dryRun: false to apply.
 * Requires options.engine (classify/index wrapper injects it).
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

  const items: LabelMirrorItem[] = [];
  const outcomeBase = {
    project_root: root,
    dry_run: dryRun,
    policy,
  };

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
        errors: 0,
        items: [
          {
            repo: "",
            issue_number: 0,
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
  // Number-only xBRIEF refs are project-repo scoped (#1423 Greptile P1). Soft-fail
  // when no xbrief layout yet (empty cache bootstrap / sparse fixtures).
  let projectVbriefReferenced: Set<number>;
  try {
    projectVbriefReferenced = engine.extractReferencedIssues(root);
  } catch {
    projectVbriefReferenced = new Set();
  }
  // Project identity for xBRIEF ref scoping must NOT use --repo (that flag is a
  // scan filter only). resolveRepo(null, root) uses git remote / PROJECT-DEFINITION.
  const projectRepo = resolveRepo(null, root);
  const decisions = loadLatestDecisionMap(root);
  const now = options.now ?? new Date();

  let pairs = iterCachedIssues(cacheRoot);
  if (options.repo !== undefined && options.repo !== null && options.repo.trim().length > 0) {
    const want = options.repo.trim().toLowerCase();
    pairs = pairs.filter(([repo]) => repo.toLowerCase() === want);
  }

  // Repos allowed to use number-only xBRIEF refs:
  // - when project repo is known: only that slug
  // - when unknown and the scan set is a single repo: that repo (legitimate bootstrap)
  // - when unknown multi-repo: none (fail closed on number collisions)
  const reposAllowedVbriefRefs = new Set<string>();
  if (projectRepo !== null && projectRepo.trim().length > 0) {
    reposAllowedVbriefRefs.add(projectRepo.trim().toLowerCase());
  } else {
    const uniqueRepos = new Set(pairs.map(([repo]) => repo.toLowerCase()));
    if (uniqueRepos.size === 1) {
      for (const r of uniqueRepos) {
        reposAllowedVbriefRefs.add(r);
      }
    }
  }

  let planned = 0;
  let applied = 0;
  let unchanged = 0;
  let skippedAlready = 0;
  let skippedNoMatch = 0;
  let skippedUnreadable = 0;
  let errors = 0;

  for (const [repo, issueNumber] of pairs) {
    const issue = readCachedRawIssue(cacheRoot, repo, issueNumber);
    if (issue === null) {
      skippedUnreadable += 1;
      items.push({
        repo,
        issue_number: issueNumber,
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

    if (current.includes(policy.idempotencyLabel)) {
      skippedAlready += 1;
      items.push({
        repo,
        issue_number: issueNumber,
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

    // Only apply number-only xBRIEF refs for allowed repos (see reposAllowedVbriefRefs).
    // Cross-repo same-number collisions must not inherit project references (#1423 P1).
    const vbriefReferenced = reposAllowedVbriefRefs.has(repo.toLowerCase())
      ? projectVbriefReferenced
      : null;

    const classification = engine.classifyIssue(issue, {
      rules: rules as never,
      holdMarkers,
      vbriefReferenced,
      hasTriageDecision: decisionMapHas(decisions, repo, issueNumber),
      now,
    });

    if (classification === null) {
      skippedNoMatch += 1;
      items.push({
        repo,
        issue_number: issueNumber,
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
    const add = desired.filter((label) => !currentSet.has(label)).sort();

    if (add.length === 0) {
      unchanged += 1;
      items.push({
        repo,
        issue_number: issueNumber,
        action: classification.action,
        reason: classification.reason,
        ruleKind: classification.ruleKind,
        current: [...current].sort(),
        desired,
        add: [],
        status: "unchanged",
      });
      continue;
    }

    if (dryRun) {
      planned += 1;
      items.push({
        repo,
        issue_number: issueNumber,
        action: classification.action,
        reason: classification.reason,
        ruleKind: classification.ruleKind,
        current: [...current].sort(),
        desired,
        add,
        status: "planned",
      });
      continue;
    }

    // --apply path: SCM boundary + write
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
        action: classification.action,
        reason: classification.reason,
        ruleKind: classification.ruleKind,
        current: [...current].sort(),
        desired,
        add,
        status: "error",
        message: mutateGate.reason ?? `refusing cross-repo mutation on ${repo}`,
      });
      continue;
    }

    if (client === undefined) {
      errors += 1;
      items.push({
        repo,
        issue_number: issueNumber,
        action: classification.action,
        reason: classification.reason,
        ruleKind: classification.ruleKind,
        current: [...current].sort(),
        desired,
        add,
        status: "error",
        message: "no LabelClient available for apply",
      });
      continue;
    }

    try {
      client.apply(repo, issueNumber, add, []);
      applied += 1;
      items.push({
        repo,
        issue_number: issueNumber,
        action: classification.action,
        reason: classification.reason,
        ruleKind: classification.ruleKind,
        current: [...current].sort(),
        desired,
        add,
        status: "applied",
      });
    } catch (exc) {
      errors += 1;
      items.push({
        repo,
        issue_number: issueNumber,
        action: classification.action,
        reason: classification.reason,
        ruleKind: classification.ruleKind,
        current: [...current].sort(),
        desired,
        add,
        status: "error",
        message: exc instanceof Error ? exc.message : String(exc),
      });
    }
  }

  const outcome: LabelMirrorOutcome = {
    ...outcomeBase,
    scanned: pairs.length,
    planned,
    applied,
    unchanged,
    skipped_already_triaged: skippedAlready,
    skipped_no_match: skippedNoMatch,
    skipped_unreadable: skippedUnreadable,
    errors,
    items,
  };
  return [errors > 0 ? 1 : 0, outcome];
}

/** Human-readable digest for dry-run / apply reports. */
export function renderLabelMirrorReport(outcome: LabelMirrorOutcome): string {
  const lines: string[] = [];
  const mode = outcome.dry_run ? "dry-run" : "apply";
  lines.push(`triage:classify --mirror (${mode})`);
  lines.push(
    `scanned=${outcome.scanned} planned=${outcome.planned} applied=${outcome.applied} ` +
      `unchanged=${outcome.unchanged} already_triaged=${outcome.skipped_already_triaged} ` +
      `no_match=${outcome.skipped_no_match} unreadable=${outcome.skipped_unreadable} ` +
      `errors=${outcome.errors}`,
  );
  lines.push(
    `idempotencyLabel=${outcome.policy.idempotencyLabel} alwaysLabels=${JSON.stringify(outcome.policy.alwaysLabels)}`,
  );
  lines.push("");

  const plannedOrApplied = outcome.items.filter(
    (i) => i.status === "planned" || i.status === "applied",
  );
  lines.push(outcome.dry_run ? "Would add labels:" : "Added labels:");
  if (plannedOrApplied.length === 0) {
    lines.push("- none");
  } else {
    for (const item of plannedOrApplied) {
      const actionPart = item.action !== null ? ` action=${item.action}` : "";
      const rulePart = item.ruleKind !== null ? ` rule=${item.ruleKind}` : "";
      const addPart = sanitizeReportFragment(item.add.join(", +"));
      lines.push(`- ${item.repo}#${item.issue_number}:${actionPart}${rulePart} +${addPart}`);
    }
  }

  const already = outcome.items.filter((i) => i.status === "skipped_already_triaged");
  if (already.length > 0) {
    lines.push("");
    lines.push(`Skipped (already ${outcome.policy.idempotencyLabel}): ${already.length}`);
  }

  const noMatch = outcome.items.filter((i) => i.status === "skipped_no_match");
  if (noMatch.length > 0) {
    lines.push(`Skipped (no classify match): ${noMatch.length}`);
  }

  const errs = outcome.items.filter((i) => i.status === "error");
  if (errs.length > 0) {
    lines.push("");
    lines.push("Errors:");
    for (const item of errs) {
      const msg = sanitizeReportFragment(item.message ?? "unknown error");
      lines.push(`- ${item.repo}#${item.issue_number}: ${msg}`);
    }
  }

  if (outcome.dry_run && plannedOrApplied.length > 0) {
    lines.push("");
    lines.push("Dry-run -- re-run with --mirror --apply to write these labels via SCM.");
  }

  return `${lines.join("\n")}\n`;
}

/** JSON-serializable outcome (stable key order not required). */
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
    errors: outcome.errors,
    policy: {
      enabled: outcome.policy.enabled,
      idempotencyLabel: outcome.policy.idempotencyLabel,
      alwaysLabels: [...outcome.policy.alwaysLabels],
      actionLabels: Object.fromEntries(
        Object.entries(outcome.policy.actionLabels).map(([k, v]) => [k, [...(v ?? [])]]),
      ),
    },
    items: outcome.items.map((i) => ({
      repo: i.repo,
      issue_number: i.issue_number,
      action: i.action,
      reason: i.reason,
      ruleKind: i.ruleKind,
      current: [...i.current],
      desired: [...i.desired],
      add: [...i.add],
      status: i.status,
      ...(i.message !== undefined ? { message: i.message } : {}),
    })),
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
