import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrateLegacyPolicyKey, PLAN_POLICY_KEY } from "../../policy/plan-extensions.js";
import { withProjectDefinitionMutation } from "../../vbrief-build/project-definition-mutation.js";
import { resolveTriageCachePath } from "../cache-path.js";
import { SUBSCRIPTION_HISTORY_SCHEMA } from "./constants.js";
import { pyStrRepr } from "./python-repr.js";
import { utcIso } from "./time.js";

// One canonical PROJECT-DEFINITION identity (#3796). The resolver, loader,
// error type, and write sink are the shared implementations the mutation
// capability binds. Module-local duplicates used to resolve the layout path
// directly -- ignoring the `DEFT_PROJECT_PATH` override the lock honours -- and
// wrote through an uncontained temp sink, so a caller could lock one artifact
// and load or persist another.
export {
  atomicWriteProjectDefinition,
  loadProjectDefinitionForMutation,
  projectDefinitionPath,
} from "../../vbrief-build/project-definition-io.js";
export { ProjectDefinitionIOError } from "../../vbrief-build/types.js";

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
  const historyPath = resolveTriageCachePath(projectRoot, "subscription-history.jsonl");
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

  // Serialise the read-modify-write + subscription-history append under the
  // shared PROJECT-DEFINITION mutation lock so concurrent mutators cannot lose
  // an update or emit out-of-order audit rows (#1260).
  return withProjectDefinitionMutation(projectRoot, (mutation): [boolean, string] => {
    const data = mutation.load();
    const plan = data.plan;
    if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
      throw new Error(
        `PROJECT-DEFINITION at ${mutation.artifactLabel} has a non-object 'plan' key`,
      );
    }
    const planRec = plan as Record<string, unknown>;
    migrateLegacyPolicyKey(planRec);
    if (planRec[PLAN_POLICY_KEY] === undefined) planRec[PLAN_POLICY_KEY] = {};
    const policy = planRec[PLAN_POLICY_KEY];
    if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
      throw new Error(
        `PROJECT-DEFINITION at ${mutation.artifactLabel} has a non-object 'plan.policy' key`,
      );
    }
    const policyRec = policy as Record<string, unknown>;
    if (policyRec.triageScope === undefined) policyRec.triageScope = [];
    const rules = policyRec.triageScope;
    if (!Array.isArray(rules)) {
      throw new Error(
        `PROJECT-DEFINITION at ${mutation.artifactLabel} has a non-list 'plan.policy.triageScope'`,
      );
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

    mutation.persist(data);
    recordSubscriptionChange(projectRoot, {
      op: "subscribe",
      label: options.label ?? null,
      milestone: options.milestone ?? null,
      before,
      after: snapshotRules(rules),
      actor: options.actor,
    });
    return [true, message];
  });
}

export function addIgnore(projectRoot: string, label: string): [boolean, string] {
  if (!label.trim())
    throw new Error(`label must be a non-empty string; got ${JSON.stringify(label)}`);

  // Serialise the read-modify-write + subscription-history append under the
  // shared PROJECT-DEFINITION mutation lock (#1260).
  return withProjectDefinitionMutation(projectRoot, (mutation): [boolean, string] => {
    const data = mutation.load();
    const plan = data.plan;
    if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
      throw new Error(
        `PROJECT-DEFINITION at ${mutation.artifactLabel} has a non-object 'plan' key`,
      );
    }
    const planRec = plan as Record<string, unknown>;
    migrateLegacyPolicyKey(planRec);
    if (planRec[PLAN_POLICY_KEY] === undefined) planRec[PLAN_POLICY_KEY] = {};
    const policy = planRec[PLAN_POLICY_KEY];
    if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
      throw new Error(
        `PROJECT-DEFINITION at ${mutation.artifactLabel} has a non-object 'plan.policy' key`,
      );
    }
    const policyRec = policy as Record<string, unknown>;
    if (policyRec.triageScopeIgnores === undefined) policyRec.triageScopeIgnores = [];
    const raw = policyRec.triageScopeIgnores;
    if (!Array.isArray(raw)) {
      throw new Error(
        `PROJECT-DEFINITION at ${mutation.artifactLabel} has a non-list 'plan.policy.triageScopeIgnores'`,
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
    mutation.persist(data);
    const after = snapshotRules(raw);
    recordSubscriptionChange(projectRoot, {
      op: "ignore-label",
      label,
      before,
      after,
      actor: null,
    });
    return [true, `added ignore (label=${label})`];
  });
}
