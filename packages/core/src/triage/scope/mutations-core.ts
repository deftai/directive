import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  PROJECT_DEFINITION_REL_PATH,
  SUBSCRIPTION_HISTORY_REL_PATH,
  SUBSCRIPTION_HISTORY_SCHEMA,
} from "./constants.js";
import { pyStrRepr } from "./python-repr.js";
import { utcIso } from "./time.js";

export class ProjectDefinitionIOError extends Error {
  override readonly name = "ProjectDefinitionIOError";
}

export function projectDefinitionPath(projectRoot: string): string {
  return join(projectRoot, PROJECT_DEFINITION_REL_PATH);
}

export function loadProjectDefinitionForMutation(
  projectRoot: string,
): [Record<string, unknown>, string] {
  const path = projectDefinitionPath(projectRoot);
  if (!existsSync(path)) {
    throw new ProjectDefinitionIOError(
      `PROJECT-DEFINITION not found at ${path}; run task triage:welcome / ` +
        "task triage:bootstrap to scaffold one first.",
    );
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new ProjectDefinitionIOError(
      `Could not read PROJECT-DEFINITION at ${path}: ${String(err)}`,
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new ProjectDefinitionIOError(
      `PROJECT-DEFINITION at ${path} is not valid JSON: ${String(err)}`,
    );
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new ProjectDefinitionIOError(
      `PROJECT-DEFINITION at ${path} top-level value is not a JSON object`,
    );
  }
  return [data as Record<string, unknown>, path];
}

export function atomicWriteProjectDefinition(path: string, data: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  const tmp = join(tmpdir(), `${randomUUID()}.tmp`);
  writeFileSync(tmp, payload, "utf8");
  renameSync(tmp, path);
}

function resolveActor(actor: string | null | undefined): string {
  if (typeof actor === "string" && actor.trim()) return actor;
  const envActor = process.env.DEFT_TRIAGE_ACTOR;
  if (typeof envActor === "string" && envActor.trim()) return envActor;
  try {
    const user = process.env.USER ?? process.env.USERNAME ?? "unknown";
    return `user:${user}`;
  } catch {
    return "user:unknown";
  }
}

export function recordSubscriptionChange(
  projectRoot: string,
  options: {
    op: string;
    label?: string | null;
    milestone?: string | null;
    issue?: number | null;
    author?: string | null;
    before?: unknown[];
    after?: unknown[];
    actor?: string | null;
    extra?: Record<string, unknown>;
  },
): void {
  const historyPath = join(projectRoot, SUBSCRIPTION_HISTORY_REL_PATH);
  const record: Record<string, unknown> = {
    schema: SUBSCRIPTION_HISTORY_SCHEMA,
    change_id: randomUUID(),
    timestamp: utcIso(),
    actor: resolveActor(options.actor),
    op: options.op,
    label: options.label ?? null,
    milestone: options.milestone ?? null,
    issue: options.issue ?? null,
    author: options.author ?? null,
    before: options.before ?? [],
    after: options.after ?? [],
  };
  if (options.extra) record.extra = options.extra;
  const line = JSON.stringify(record, Object.keys(record).sort());
  try {
    mkdirSync(dirname(historyPath), { recursive: true });
    appendFileSync(historyPath, `${line}\n`, "utf8");
  } catch {
    // observability only
  }
}

function snapshotRules(rules: unknown[]): unknown[] {
  return JSON.parse(JSON.stringify(rules)) as unknown[];
}

function applySubscribeLabel(rules: unknown[], label: string): [boolean, string] {
  for (const rule of rules) {
    if (
      typeof rule === "object" &&
      rule !== null &&
      !Array.isArray(rule) &&
      (rule as Record<string, unknown>).rule === "labels" &&
      Array.isArray((rule as Record<string, unknown>)["any-of"])
    ) {
      const rec = rule as Record<string, unknown>;
      const anyOf = rec["any-of"] as unknown[];
      if (anyOf.includes(label)) {
        return [false, `already-subscribed (labels.any-of contains ${pyStrRepr(label)})`];
      }
      anyOf.push(label);
      return [true, `added ${pyStrRepr(label)} to existing labels.any-of`];
    }
  }
  rules.push({ rule: "labels", "any-of": [label] });
  return [true, `created new labels.any-of rule for ${pyStrRepr(label)}`];
}

function applySubscribeMilestone(rules: unknown[], milestone: string): [boolean, string] {
  for (const rule of rules) {
    if (
      typeof rule === "object" &&
      rule !== null &&
      !Array.isArray(rule) &&
      (rule as Record<string, unknown>).rule === "milestone" &&
      (rule as Record<string, unknown>).name === milestone
    ) {
      return [false, `already-subscribed (milestone ${pyStrRepr(milestone)})`];
    }
  }
  rules.push({ rule: "milestone", name: milestone });
  return [true, `added milestone rule for ${pyStrRepr(milestone)}`];
}

export function subscribe(
  projectRoot: string,
  options: { label?: string; milestone?: string; actor?: string | null },
): [boolean, string] {
  const chosen = [
    options.label !== undefined ? "label" : null,
    options.milestone !== undefined ? "milestone" : null,
  ].filter(Boolean);
  if (chosen.length !== 1) {
    throw new Error(
      `subscribe() requires exactly one of --label / --milestone / --issue; got ${JSON.stringify(chosen)}`,
    );
  }

  const [data, path] = loadProjectDefinitionForMutation(projectRoot);
  const plan = data.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    throw new Error(`PROJECT-DEFINITION at ${path} has a non-object 'plan' key`);
  }
  const planRec = plan as Record<string, unknown>;
  if (planRec.policy === undefined) planRec.policy = {};
  const policy = planRec.policy;
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    throw new Error(`PROJECT-DEFINITION at ${path} has a non-object 'plan.policy' key`);
  }
  const policyRec = policy as Record<string, unknown>;
  if (policyRec.triageScope === undefined) policyRec.triageScope = [];
  const rules = policyRec.triageScope;
  if (!Array.isArray(rules)) {
    throw new Error(`PROJECT-DEFINITION at ${path} has a non-list 'plan.policy.triageScope'`);
  }

  const before = snapshotRules(rules);
  let changed: boolean;
  let message: string;
  if (options.label !== undefined) {
    [changed, message] = applySubscribeLabel(rules, options.label);
  } else if (options.milestone !== undefined) {
    [changed, message] = applySubscribeMilestone(rules, options.milestone);
  } else {
    throw new Error("subscribe() requires exactly one of label or milestone");
  }
  if (!changed) return [false, message];

  atomicWriteProjectDefinition(path, data);
  recordSubscriptionChange(projectRoot, {
    op: "subscribe",
    label: options.label ?? null,
    milestone: options.milestone ?? null,
    before,
    after: snapshotRules(rules),
    actor: options.actor,
  });
  return [true, message];
}

export function addIgnore(projectRoot: string, label: string): [boolean, string] {
  if (!label.trim())
    throw new Error(`label must be a non-empty string; got ${JSON.stringify(label)}`);

  const [data, path] = loadProjectDefinitionForMutation(projectRoot);
  const plan = data.plan;
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    throw new Error(`PROJECT-DEFINITION at ${path} has a non-object 'plan' key`);
  }
  const planRec = plan as Record<string, unknown>;
  if (planRec.policy === undefined) planRec.policy = {};
  const policy = planRec.policy;
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    throw new Error(`PROJECT-DEFINITION at ${path} has a non-object 'plan.policy' key`);
  }
  const policyRec = policy as Record<string, unknown>;
  if (policyRec.triageScopeIgnores === undefined) policyRec.triageScopeIgnores = [];
  const raw = policyRec.triageScopeIgnores;
  if (!Array.isArray(raw)) {
    throw new Error(
      `PROJECT-DEFINITION at ${path} has a non-list 'plan.policy.triageScopeIgnores'`,
    );
  }

  const before = snapshotRules(raw);
  for (const entry of raw) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      !Array.isArray(entry) &&
      (entry as Record<string, unknown>).label === label
    ) {
      return [false, `already-ignored (label=${label})`];
    }
  }
  raw.push({ label });
  atomicWriteProjectDefinition(path, data);
  const after = snapshotRules(raw);
  recordSubscriptionChange(projectRoot, {
    op: "ignore-label",
    label,
    before,
    after,
    actor: null,
  });
  return [true, `added ignore (label=${label})`];
}
