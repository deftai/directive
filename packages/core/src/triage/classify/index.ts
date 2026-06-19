import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pyRepr } from "../../scm/py-format.js";

function pythonTypeName(value: unknown): string {
  if (value === null) {
    return "NoneType";
  }
  if (Array.isArray(value)) {
    return "list";
  }
  const t = typeof value;
  if (t === "object") {
    return "dict";
  }
  if (t === "string") {
    return "str";
  }
  if (t === "boolean") {
    return "bool";
  }
  if (t === "number") {
    return Number.isInteger(value) ? "int" : "float";
  }
  return t;
}

function pythonRepr(value: unknown): string {
  return pyRepr(value);
}

/** Filesystem-relative location of the PROJECT-DEFINITION vBRIEF. */
export const PROJECT_DEFINITION_REL_PATH = "vbrief/PROJECT-DEFINITION.vbrief.json";

/** Threshold in days for the "dormant" universal rule (Decision 1). */
export const DORMANT_AGE_DAYS = 90;

/** Threshold in characters for "thin body" used by the dormant rule. */
export const THIN_BODY_THRESHOLD_CHARS = 50;

/** Default hold-marker phrases (Decision 1 + Decision 3). */
export const DEFAULT_HOLD_MARKERS: readonly string[] = [
  "do not implement",
  "BLOCKED",
  "HOLDING",
  "Holding / capture only",
];

export const VALID_ACTIONS: ReadonlySet<string> = new Set([
  "defer",
  "archive",
  "escalate",
  "accept",
]);

export const VALID_STATES: ReadonlySet<string> = new Set(["open", "closed"]);

export interface ClassifyRule {
  readonly rule?: string;
  readonly action?: string;
  readonly reason?: string;
  readonly match?: Record<string, unknown>;
  readonly "resume-on"?: string;
}

export interface ClassificationResult {
  readonly action: string;
  readonly reason: string;
  readonly ruleIndex: number;
  readonly ruleSource: string;
  readonly ruleKind: string;
  readonly resumeOn: string | null;
}

export interface GitHubIssue {
  readonly number?: number;
  readonly state?: string;
  readonly body?: string | null;
  readonly labels?: ReadonlyArray<{ name?: string } | string>;
  readonly updated_at?: string;
  readonly created_at?: string;
}

/** The four framework universal rules (Decision 1). */
export const UNIVERSAL_RULES: readonly ClassifyRule[] = [
  {
    rule: "universal:hold-marker",
    action: "defer",
    reason: "hold marker in body",
  },
  {
    rule: "universal:closed-never-triaged",
    action: "archive",
    reason: "closed upstream and never triaged",
  },
  {
    rule: "universal:dormant-thin-body",
    action: "defer",
    reason: "dormant; needs AC refresh",
  },
  {
    rule: "universal:vbrief-referenced",
    action: "accept",
    reason: "already referenced from a scope vBRIEF",
  },
];

function utcNow(): Date {
  return new Date();
}

function parseIso(stamp: string): Date {
  let text = stamp.trim();
  if (text.endsWith("Z")) {
    text = `${text.slice(0, -1)}+00:00`;
  }
  return new Date(text);
}

function tsToDt(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  try {
    const dt = parseIso(value);
    if (Number.isNaN(dt.getTime())) {
      return null;
    }
    return dt;
  } catch {
    return null;
  }
}

function validateConsumerRule(
  rule: Record<string, unknown>,
  prefix: string,
  errors: string[],
  warnings: string[],
): void {
  const kind = rule.rule;
  if (typeof kind === "string" && kind.startsWith("universal:")) {
    errors.push(
      `${prefix}.rule ${pythonRepr(kind)} is reserved for framework universal ` +
        "rules (#1129 Decision 1); consumer rules MUST omit the " +
        "'rule' field or use a non-'universal:' discriminator",
    );
    return;
  }

  const action = rule.action;
  if (typeof action !== "string" || !VALID_ACTIONS.has(action)) {
    errors.push(
      `${prefix}.action must be one of ${pythonRepr([...VALID_ACTIONS].sort())}; got ${pythonRepr(action)}`,
    );
  }

  const reason = rule.reason;
  if (typeof reason !== "string" || reason.trim().length === 0) {
    errors.push(`${prefix}.reason must be a non-empty string`);
  }

  if ("resume-on" in rule) {
    const ro = rule["resume-on"];
    if (typeof ro !== "string" || ro.trim().length === 0) {
      errors.push(`${prefix}.resume-on must be a non-empty string when set`);
    }
  }

  const match = rule.match;
  if (typeof match !== "object" || match === null || Array.isArray(match)) {
    errors.push(`${prefix}.match must be an object`);
    return;
  }

  const recognisedPredicates = new Set(["labels", "body-text", "state", "age-days"]);
  const matchKeys = Object.keys(match);
  const extra = matchKeys.filter((k) => !recognisedPredicates.has(k)).sort();
  if (extra.length > 0) {
    warnings.push(
      `${prefix}.match: ignoring unrecognised predicate(s) ${pythonRepr(extra)}; ` +
        `expected one or more of ${pythonRepr([...recognisedPredicates].sort())}`,
    );
  }
  const usedPredicates = matchKeys.filter((k) => recognisedPredicates.has(k)).sort();
  if (usedPredicates.length === 0) {
    errors.push(
      `${prefix}.match requires at least one of ${pythonRepr([...recognisedPredicates].sort())}`,
    );
    return;
  }

  if ("labels" in match) {
    validateLabelsPredicate(match.labels, `${prefix}.match.labels`, errors);
  }
  if ("body-text" in match) {
    validateBodyTextPredicate(match["body-text"], `${prefix}.match.body-text`, errors);
  }
  if ("state" in match) {
    const state = match.state;
    if (typeof state !== "string" || !VALID_STATES.has(state)) {
      errors.push(
        `${prefix}.match.state must be one of ${pythonRepr([...VALID_STATES].sort())}; got ${pythonRepr(state)}`,
      );
    }
  }
  if ("age-days" in match) {
    validateAgeDaysPredicate(match["age-days"], `${prefix}.match.age-days`, errors);
  }
}

function validateLabelsPredicate(value: unknown, prefix: string, errors: string[]): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  const obj = value as Record<string, unknown>;
  const anyOf = obj["any-of"];
  const allOf = obj["all-of"];
  if (anyOf === undefined && allOf === undefined) {
    errors.push(`${prefix} requires 'any-of' or 'all-of'`);
    return;
  }
  if (anyOf !== undefined && allOf !== undefined) {
    errors.push(`${prefix}: 'any-of' and 'all-of' are mutually exclusive`);
    return;
  }
  const target = anyOf !== undefined ? anyOf : allOf;
  const which = anyOf !== undefined ? "any-of" : "all-of";
  if (!Array.isArray(target) || target.length === 0) {
    errors.push(`${prefix}.${which} must be a non-empty list of strings`);
    return;
  }
  for (let j = 0; j < target.length; j += 1) {
    const label = target[j];
    if (typeof label !== "string" || label.length === 0) {
      errors.push(`${prefix}.${which}[${j}] must be a non-empty string`);
    }
  }
}

function validateBodyTextPredicate(value: unknown, prefix: string, errors: string[]): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  const anyOf = (value as Record<string, unknown>)["any-of"];
  if (!Array.isArray(anyOf) || anyOf.length === 0) {
    errors.push(`${prefix}.any-of must be a non-empty list of strings`);
    return;
  }
  for (let j = 0; j < anyOf.length; j += 1) {
    const needle = anyOf[j];
    if (typeof needle !== "string" || needle.length === 0) {
      errors.push(`${prefix}.any-of[${j}] must be a non-empty string`);
    }
  }
}

function validateAgeDaysPredicate(value: unknown, prefix: string, errors: string[]): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  const obj = value as Record<string, unknown>;
  if (!("gt" in obj)) {
    errors.push(`${prefix} requires a 'gt' integer threshold`);
    return;
  }
  const gt = obj.gt;
  if (typeof gt !== "number" || !Number.isInteger(gt) || gt < 0) {
    errors.push(`${prefix}.gt must be a non-negative integer; got ${pythonRepr(gt)}`);
  }
}

/** Validate a ``plan.policy.triageAutoClassify`` payload. */
export function validateClassifyRules(rules: unknown): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (rules === undefined || rules === null) {
    return { errors, warnings };
  }

  if (!Array.isArray(rules)) {
    errors.push(
      `plan.policy.triageAutoClassify must be a list of rule objects; got ${pythonTypeName(rules)}`,
    );
    return { errors, warnings };
  }

  for (let i = 0; i < rules.length; i += 1) {
    const rule = rules[i];
    const prefix = `plan.policy.triageAutoClassify[${i}]`;
    if (typeof rule !== "object" || rule === null || Array.isArray(rule)) {
      errors.push(`${prefix} must be an object, got ${pythonTypeName(rule)}`);
      continue;
    }
    validateConsumerRule(rule as Record<string, unknown>, prefix, errors, warnings);
  }

  return { errors, warnings };
}

/** Validate a ``plan.policy.triageHoldMarkers`` payload. */
export function validateHoldMarkers(markers: unknown): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (markers === undefined || markers === null) {
    return { errors, warnings };
  }
  if (!Array.isArray(markers)) {
    errors.push(
      `plan.policy.triageHoldMarkers must be a list of strings; got ${pythonTypeName(markers)}`,
    );
    return { errors, warnings };
  }
  for (let i = 0; i < markers.length; i += 1) {
    const marker = markers[i];
    if (typeof marker !== "string" || marker.trim().length === 0) {
      errors.push(`plan.policy.triageHoldMarkers[${i}] must be a non-empty string`);
    }
  }
  return { errors, warnings };
}

export function projectDefinitionPath(projectRoot?: string): string {
  const root = projectRoot ?? process.cwd();
  return join(root, PROJECT_DEFINITION_REL_PATH);
}

function loadProjectDefinition(projectRoot?: string): Record<string, unknown> | null {
  const path = projectDefinitionPath(projectRoot);
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

function consumerRulesFromProject(data: Record<string, unknown> | null): ClassifyRule[] {
  if (data === null) {
    return [];
  }
  const plan = data.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return [];
  }
  const policy = (plan as Record<string, unknown>).policy;
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    return [];
  }
  const raw = (policy as Record<string, unknown>).triageAutoClassify;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(
    (r): r is ClassifyRule => typeof r === "object" && r !== null && !Array.isArray(r),
  );
}

function holdMarkersFromProject(data: Record<string, unknown> | null): string[] | null {
  if (data === null) {
    return null;
  }
  const plan = data.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return null;
  }
  const policy = (plan as Record<string, unknown>).policy;
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    return null;
  }
  const raw = (policy as Record<string, unknown>).triageHoldMarkers;
  if (!Array.isArray(raw)) {
    return null;
  }
  return raw.filter((m): m is string => typeof m === "string" && m.trim().length > 0);
}

/** Return UNIVERSAL_RULES followed by consumer rules. */
export function resolveClassifyRules(options?: {
  projectRoot?: string;
  projectDefinition?: Record<string, unknown> | null;
}): ClassifyRule[] {
  const data =
    options?.projectDefinition !== undefined
      ? options.projectDefinition
      : loadProjectDefinition(options?.projectRoot);
  const consumer = consumerRulesFromProject(data);
  return [...UNIVERSAL_RULES.map((r) => ({ ...r })), ...consumer.map((r) => ({ ...r }))];
}

/** Return the effective hold-marker list (defaults + consumer override). */
export function resolveHoldMarkers(options?: {
  projectRoot?: string;
  projectDefinition?: Record<string, unknown> | null;
}): string[] {
  const data =
    options?.projectDefinition !== undefined
      ? options.projectDefinition
      : loadProjectDefinition(options?.projectRoot);
  const raw = holdMarkersFromProject(data);
  if (raw === null) {
    return [...DEFAULT_HOLD_MARKERS];
  }
  return [...raw];
}

function issueNumber(issue: GitHubIssue): number {
  const n = issue.number;
  return typeof n === "number" && Number.isInteger(n) ? n : 0;
}

function issueState(issue: GitHubIssue): string {
  const state = issue.state;
  return typeof state === "string" ? state : "open";
}

function issueBody(issue: GitHubIssue): string {
  const body = issue.body;
  return typeof body === "string" ? body : "";
}

function issueLabelNames(issue: GitHubIssue): Set<string> {
  const raw = issue.labels ?? [];
  const names = new Set<string>();
  if (!Array.isArray(raw)) {
    return names;
  }
  for (const item of raw) {
    if (typeof item === "object" && item !== null && "name" in item) {
      const name = item.name;
      if (typeof name === "string") {
        names.add(name);
      }
    } else if (typeof item === "string") {
      names.add(item);
    }
  }
  return names;
}

function issueUpdatedAt(issue: GitHubIssue): Date | null {
  return tsToDt(issue.updated_at);
}

function issueCreatedAt(issue: GitHubIssue): Date | null {
  return tsToDt(issue.created_at);
}

function msPerDay(): number {
  return 86_400_000;
}

function matchesHoldMarker(issue: GitHubIssue, holdMarkers: readonly string[]): boolean {
  const body = issueBody(issue);
  if (body.length === 0) {
    return false;
  }
  const haystack = body.toLowerCase();
  for (const marker of holdMarkers) {
    if (marker.length === 0) {
      continue;
    }
    if (haystack.includes(marker.toLowerCase())) {
      return true;
    }
  }
  return false;
}

function matchesClosedNeverTriaged(issue: GitHubIssue, hasTriageDecision: boolean): boolean {
  return issueState(issue) === "closed" && !hasTriageDecision;
}

function matchesDormantThinBody(
  issue: GitHubIssue,
  now: Date,
  ageDays: number = DORMANT_AGE_DAYS,
): boolean {
  if (issueState(issue) !== "open") {
    return false;
  }
  const updated = issueUpdatedAt(issue) ?? issueCreatedAt(issue);
  if (updated === null) {
    return false;
  }
  if (now.getTime() - updated.getTime() <= ageDays * msPerDay()) {
    return false;
  }
  const body = issueBody(issue).trim();
  return body.length < THIN_BODY_THRESHOLD_CHARS;
}

function matchesVbriefReferenced(
  issue: GitHubIssue,
  vbriefReferenced: ReadonlySet<number> | null | undefined,
): boolean {
  if (vbriefReferenced === undefined || vbriefReferenced === null || vbriefReferenced.size === 0) {
    return false;
  }
  return vbriefReferenced.has(issueNumber(issue));
}

function consumerRuleMatches(rule: ClassifyRule, issue: GitHubIssue, now: Date): boolean {
  const match = rule.match;
  if (typeof match !== "object" || match === null || Array.isArray(match)) {
    return false;
  }

  if ("state" in match) {
    const wanted = match.state;
    if (issueState(issue) !== wanted) {
      return false;
    }
  }

  if ("labels" in match) {
    const labelsPred = match.labels;
    const names = issueLabelNames(issue);
    if (typeof labelsPred !== "object" || labelsPred === null || Array.isArray(labelsPred)) {
      return false;
    }
    const lp = labelsPred as Record<string, unknown>;
    const anyOf = lp["any-of"];
    const allOf = lp["all-of"];
    if (anyOf !== undefined) {
      if (
        !Array.isArray(anyOf) ||
        !anyOf.some((label) => typeof label === "string" && names.has(label))
      ) {
        return false;
      }
    } else if (allOf !== undefined) {
      if (
        !Array.isArray(allOf) ||
        !allOf.every((label) => typeof label === "string" && names.has(label))
      ) {
        return false;
      }
    } else {
      return false;
    }
  }

  if ("body-text" in match) {
    const bodyPred = match["body-text"];
    const anyOf =
      typeof bodyPred === "object" && bodyPred !== null && !Array.isArray(bodyPred)
        ? (bodyPred as Record<string, unknown>)["any-of"]
        : undefined;
    if (!Array.isArray(anyOf) || anyOf.length === 0) {
      return false;
    }
    const body = issueBody(issue).toLowerCase();
    if (
      !anyOf.some((n) => typeof n === "string" && n.length > 0 && body.includes(n.toLowerCase()))
    ) {
      return false;
    }
  }

  if ("age-days" in match) {
    const pred = match["age-days"];
    const gt =
      typeof pred === "object" && pred !== null && !Array.isArray(pred)
        ? (pred as Record<string, unknown>).gt
        : undefined;
    if (typeof gt !== "number" || !Number.isInteger(gt)) {
      return false;
    }
    const updated = issueUpdatedAt(issue) ?? issueCreatedAt(issue);
    if (updated === null) {
      return false;
    }
    if (now.getTime() - updated.getTime() <= gt * msPerDay()) {
      return false;
    }
  }

  return true;
}

export interface ClassifyIssueOptions {
  rules?: ClassifyRule[];
  holdMarkers?: string[] | null;
  vbriefReferenced?: ReadonlySet<number> | null;
  hasTriageDecision?: boolean;
  now?: Date;
}

/** Classify a single issue against the effective rule set. */
export function classifyIssue(
  issue: GitHubIssue,
  options: ClassifyIssueOptions = {},
): ClassificationResult | null {
  const rules = options.rules ?? UNIVERSAL_RULES.map((r) => ({ ...r }));
  const effectiveMarkers =
    options.holdMarkers === undefined || options.holdMarkers === null
      ? [...DEFAULT_HOLD_MARKERS]
      : [...options.holdMarkers];
  const nowDt = options.now ?? utcNow();
  const hasTriageDecision = options.hasTriageDecision ?? false;
  const vbriefReferenced = options.vbriefReferenced;

  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    if (rule === undefined) {
      continue;
    }
    const kind = rule.rule;
    let matched = false;

    if (kind === "universal:hold-marker") {
      matched = matchesHoldMarker(issue, effectiveMarkers);
    } else if (kind === "universal:closed-never-triaged") {
      matched = matchesClosedNeverTriaged(issue, hasTriageDecision);
    } else if (kind === "universal:dormant-thin-body") {
      matched = matchesDormantThinBody(issue, nowDt);
    } else if (kind === "universal:vbrief-referenced") {
      matched = matchesVbriefReferenced(issue, vbriefReferenced);
    } else {
      matched = consumerRuleMatches(rule, issue, nowDt);
    }

    if (!matched) {
      continue;
    }

    const source =
      typeof kind === "string" && kind.startsWith("universal:") ? "framework" : "consumer";
    const resumeOnRaw = rule["resume-on"];
    return {
      action: String(rule.action ?? ""),
      reason: String(rule.reason ?? ""),
      ruleIndex: index,
      ruleSource: source,
      ruleKind: typeof kind === "string" ? kind : `consumer[${index}]`,
      resumeOn: typeof resumeOnRaw === "string" && resumeOnRaw.length > 0 ? resumeOnRaw : null,
    };
  }

  return null;
}

/** Return issue numbers referenced by pending/ or active/ scope vBRIEFs. */
export function extractReferencedIssues(
  projectRoot?: string,
  lifecycleFolders: readonly string[] = ["pending", "active"],
): Set<number> {
  const root = join(projectRoot ?? process.cwd(), "vbrief");
  const referenced = new Set<number>();
  for (const folder of lifecycleFolders) {
    const folderPath = join(root, folder);
    let entries: string[];
    try {
      entries = readdirSync(folderPath).filter((f) => f.endsWith(".vbrief.json"));
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
          if (r.type !== "x-vbrief/github-issue") {
            continue;
          }
          const uri = r.uri;
          if (typeof uri !== "string") {
            continue;
          }
          const tail = uri.replace(/\/+$/, "").split("/").pop() ?? "";
          if (/^\d+$/.test(tail)) {
            referenced.add(Number.parseInt(tail, 10));
          }
        }
      } catch {}
    }
  }
  return referenced;
}

function renderRule(idx: number, rule: ClassifyRule): string[] {
  const kind = rule.rule;
  const action = rule.action ?? "?";
  const reason = rule.reason ?? "";
  if (typeof kind === "string" && kind.startsWith("universal:")) {
    return [`  ${idx}. ${kind.padEnd(32)} -> ${String(action).padEnd(8)} (${reason})`];
  }
  const match = rule.match ?? {};
  const parts: string[] = [];
  if (typeof match === "object" && match !== null && !Array.isArray(match)) {
    if ("labels" in match) {
      const labels = match.labels;
      if (typeof labels === "object" && labels !== null && !Array.isArray(labels)) {
        const l = labels as Record<string, unknown>;
        if ("any-of" in l && Array.isArray(l["any-of"])) {
          const sorted = (l["any-of"] as unknown[])
            .filter((x): x is string => typeof x === "string")
            .sort();
          parts.push(`labels.any-of=${pyRepr(sorted)}`);
        } else if ("all-of" in l && Array.isArray(l["all-of"])) {
          const sorted = (l["all-of"] as unknown[])
            .filter((x): x is string => typeof x === "string")
            .sort();
          parts.push(`labels.all-of=${pyRepr(sorted)}`);
        }
      }
    }
    if ("body-text" in match) {
      const body = match["body-text"];
      if (
        typeof body === "object" &&
        body !== null &&
        !Array.isArray(body) &&
        "any-of" in body &&
        Array.isArray((body as Record<string, unknown>)["any-of"])
      ) {
        const sorted = ((body as Record<string, unknown>)["any-of"] as unknown[])
          .filter((x): x is string => typeof x === "string")
          .sort();
        parts.push(`body-text.any-of=${pyRepr(sorted)}`);
      }
    }
    if ("state" in match) {
      parts.push(`state=${pyRepr(match.state)}`);
    }
    if ("age-days" in match) {
      const age = match["age-days"];
      if (typeof age === "object" && age !== null && !Array.isArray(age) && "gt" in age) {
        parts.push(`age-days.gt=${String((age as Record<string, unknown>).gt)}`);
      }
    }
  }
  let head = `  ${idx}. consumer rule -> ${String(action).padEnd(8)} (${reason})`;
  if (parts.length > 0) {
    head = `${head} :: ${parts.join(", ")}`;
  }
  const resumeOn = rule["resume-on"];
  if (typeof resumeOn === "string" && resumeOn.length > 0) {
    head = `${head} [resume-on: ${resumeOn}]`;
  }
  return [head];
}

/** Return a human-readable recap of the effective rule + marker set. */
export function renderList(
  rules: readonly ClassifyRule[],
  options?: { holdMarkers?: readonly string[] | null },
): string {
  const ruleList = [...rules];
  const markerList =
    options?.holdMarkers === undefined || options?.holdMarkers === null
      ? [...DEFAULT_HOLD_MARKERS]
      : [...options.holdMarkers];
  const lines: string[] = [
    `triage:classify effective rules (${ruleList.length}) (framework universal first, then consumer):`,
  ];
  for (let i = 0; i < ruleList.length; i += 1) {
    const rule = ruleList[i];
    if (rule !== undefined) {
      lines.push(...renderRule(i + 1, rule));
    }
  }
  lines.push(`hold markers (${markerList.length}): ${pyRepr(markerList)}`);
  return lines.join("\n");
}

/** vbrief_validate hook for ``plan.policy.triageAutoClassify`` (#1129). */
export function validateTriageAutoClassifyOnPlan(plan: unknown, filepath: string): string[] {
  const out: string[] = [];
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return out;
  }
  const policy = (plan as Record<string, unknown>).policy;
  const raw =
    typeof policy === "object" && policy !== null && !Array.isArray(policy)
      ? (policy as Record<string, unknown>).triageAutoClassify
      : undefined;
  if (raw === undefined || raw === null) {
    return out;
  }
  const { errors } = validateClassifyRules(raw);
  for (const err of errors) {
    out.push(`${filepath}: ${err} (#1129)`);
  }
  return out;
}

/** vbrief_validate hook for ``plan.policy.triageHoldMarkers`` (#1129). */
export function validateTriageHoldMarkersOnPlan(plan: unknown, filepath: string): string[] {
  const out: string[] = [];
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return out;
  }
  const policy = (plan as Record<string, unknown>).policy;
  const raw =
    typeof policy === "object" && policy !== null && !Array.isArray(policy)
      ? (policy as Record<string, unknown>).triageHoldMarkers
      : undefined;
  if (raw === undefined || raw === null) {
    return out;
  }
  const { errors } = validateHoldMarkers(raw);
  for (const err of errors) {
    out.push(`${filepath}: ${err} (#1129)`);
  }
  return out;
}

/** Load PROJECT-DEFINITION for CLI validation (mirrors Python ``_load_project_definition``). */
export function loadProjectDefinitionForCli(projectRoot: string): Record<string, unknown> | null {
  return loadProjectDefinition(projectRoot);
}

/** Validate PROJECT-DEFINITION triage classify config; returns exit code contract. */
export function validateProject(projectRoot: string): {
  code: 0 | 1 | 2;
  stdout: string;
  stderr: string;
} {
  const root = resolve(projectRoot);
  const data = loadProjectDefinition(root);
  if (data === null) {
    return {
      code: 0,
      stdout:
        "OK: no PROJECT-DEFINITION at " +
        `${join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json")} -- ` +
        "framework defaults apply with no consumer overrides.\n",
      stderr: "",
    };
  }
  const plan = data.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return {
      code: 1,
      stdout: "",
      stderr: "FAIL: PROJECT-DEFINITION.plan is not an object\n",
    };
  }
  const rel = join(root, "vbrief", "PROJECT-DEFINITION.vbrief.json");
  const classifyErrs = validateTriageAutoClassifyOnPlan(plan, rel);
  const holderErrs = validateTriageHoldMarkersOnPlan(plan, rel);
  const errors = [...classifyErrs, ...holderErrs];
  if (errors.length > 0) {
    const lines = errors.map((err) => `FAIL: ${err}`);
    lines.push("");
    lines.push(`${errors.length} error(s) found`);
    return { code: 1, stdout: "", stderr: `${lines.join("\n")}\n` };
  }
  const rules = resolveClassifyRules({ projectRoot: root });
  const markers = resolveHoldMarkers({ projectRoot: root });
  return {
    code: 0,
    stdout:
      "OK: triageAutoClassify[] + triageHoldMarkers[] valid " +
      `(${rules.length} rules, ${markers.length} hold markers).\n`,
    stderr: "",
  };
}

/** Render --list output for a project root. */
export function listProject(projectRoot: string): string {
  const root = resolve(projectRoot);
  const rules = resolveClassifyRules({ projectRoot: root });
  const markers = resolveHoldMarkers({ projectRoot: root });
  return `${renderList(rules, { holdMarkers: markers })}\n`;
}
