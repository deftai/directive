import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { migrateLegacyPolicyKey, PLAN_POLICY_KEY } from "../../policy/plan-extensions.js";
import { withProjectDefinitionMutation } from "../../vbrief-build/project-definition-mutation.js";
import { resolveTriageCachePath } from "../cache-path.js";

export const SUBSCRIPTION_HISTORY_REL_PATH = "xbrief/.triage-cache/subscription-history.jsonl";
export const SUBSCRIPTION_HISTORY_SCHEMA = "deft.triage.subscription-change.v1";
export const PROJECT_DEFINITION_REL_PATH = "xbrief/PROJECT-DEFINITION.xbrief.json";

/** Python ``!r``-style quoting for parity with triage_subscribe.py messages. */
export function pyRepr(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

// One canonical PROJECT-DEFINITION identity (#3796) -- see the same note in
// `triage/scope/mutations-core.ts`. These were module-local duplicates that
// resolved the layout path directly instead of honouring the override the lock
// uses, and wrote through their own temp sink.
export {
  atomicWriteProjectDefinition,
  loadProjectDefinitionForMutation,
  projectDefinitionPath,
} from "../../vbrief-build/project-definition-io.js";
export { ProjectDefinitionIOError } from "../../vbrief-build/types.js";

type TriageRule = Record<string, unknown>;

function snapshotRules(rules: TriageRule[]): TriageRule[] {
  return JSON.parse(JSON.stringify(rules)) as TriageRule[];
}

function utcIso(dt?: Date): string {
  const d = dt ?? new Date();
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function resolveActor(actor?: string | null): string {
  if (typeof actor === "string" && actor.trim().length > 0) {
    return actor;
  }
  const envActor = process.env.DEFT_TRIAGE_ACTOR;
  if (typeof envActor === "string" && envActor.trim().length > 0) {
    return envActor;
  }
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
    before?: TriageRule[] | null;
    after?: TriageRule[] | null;
    actor?: string | null;
    extra?: Record<string, unknown> | null;
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
  if (options.extra !== null && options.extra !== undefined) {
    record.extra = options.extra;
  }
  const sortedRecord = Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((k) => [k, record[k]]),
  );
  const line = JSON.stringify(sortedRecord);
  try {
    mkdirSync(join(historyPath, ".."), { recursive: true });
    appendFileSync(historyPath, `${line}\n`, { encoding: "utf8" });
  } catch {
    // observability only
  }
}

function applySubscribe(
  rules: TriageRule[],
  label: string | null | undefined,
  milestone: string | null | undefined,
  issue: number | null | undefined,
  issueNote: string,
): [boolean, string] {
  if (label !== null && label !== undefined) {
    for (const rule of rules) {
      if (
        typeof rule === "object" &&
        rule !== null &&
        rule.rule === "labels" &&
        Array.isArray(rule["any-of"])
      ) {
        const anyOf = rule["any-of"] as unknown[];
        if (anyOf.includes(label)) {
          return [false, `already-subscribed (labels.any-of contains ${pyRepr(label)})`];
        }
        anyOf.push(label);
        return [true, `added ${pyRepr(label)} to existing labels.any-of`];
      }
    }
    rules.push({ rule: "labels", "any-of": [label] });
    return [true, `created new labels.any-of rule for ${pyRepr(label)}`];
  }

  if (milestone !== null && milestone !== undefined) {
    for (const rule of rules) {
      if (
        typeof rule === "object" &&
        rule !== null &&
        rule.rule === "milestone" &&
        rule.name === milestone
      ) {
        return [false, `already-subscribed (milestone ${pyRepr(milestone)})`];
      }
    }
    rules.push({ rule: "milestone", name: milestone });
    return [true, `added milestone rule for ${pyRepr(milestone)}`];
  }

  if (issue !== null && issue !== undefined) {
    for (const rule of rules) {
      if (
        typeof rule === "object" &&
        rule !== null &&
        rule.rule === "explicit-watch" &&
        Array.isArray(rule.issues)
      ) {
        const issues = rule.issues as Array<Record<string, unknown>>;
        if (issues.some((e) => e.n === issue)) {
          return [false, `already-subscribed (explicit-watch issue #${issue})`];
        }
        issues.push({ n: issue, note: issueNote });
        return [true, `added #${issue} to existing explicit-watch`];
      }
    }
    rules.push({
      rule: "explicit-watch",
      issues: [{ n: issue, note: issueNote }],
    });
    return [true, `created new explicit-watch rule for #${issue}`];
  }

  return [false, "no-op"];
}

function applyUnsubscribe(
  rules: TriageRule[],
  label: string | null | undefined,
  milestone: string | null | undefined,
  issue: number | null | undefined,
): [boolean, string] {
  if (label !== null && label !== undefined) {
    for (let i = 0; i < rules.length; i += 1) {
      const rule = rules[i];
      if (rule === undefined) continue;
      if (typeof rule !== "object" || rule === null || rule.rule !== "labels") {
        continue;
      }
      for (const key of ["any-of", "all-of"] as const) {
        const items = rule[key];
        if (Array.isArray(items) && items.includes(label)) {
          const idx = items.indexOf(label);
          items.splice(idx, 1);
          if (items.length === 0) {
            rules.splice(i, 1);
          }
          return [true, `removed ${pyRepr(label)} from labels.${key}`];
        }
      }
    }
    return [false, `not-subscribed (no labels rule mentions ${pyRepr(label)})`];
  }

  if (milestone !== null && milestone !== undefined) {
    for (let i = 0; i < rules.length; i += 1) {
      const rule = rules[i];
      if (rule === undefined) continue;
      if (
        typeof rule === "object" &&
        rule !== null &&
        rule.rule === "milestone" &&
        rule.name === milestone
      ) {
        rules.splice(i, 1);
        return [true, `removed milestone rule for ${pyRepr(milestone)}`];
      }
    }
    return [false, `not-subscribed (no milestone rule for ${pyRepr(milestone)})`];
  }

  if (issue !== null && issue !== undefined) {
    for (let i = 0; i < rules.length; i += 1) {
      const rule = rules[i];
      if (rule === undefined) continue;
      if (typeof rule !== "object" || rule === null || rule.rule !== "explicit-watch") {
        continue;
      }
      const items = rule.issues;
      if (!Array.isArray(items)) {
        continue;
      }
      const newItems = items.filter(
        (e) => !(typeof e === "object" && e !== null && (e as Record<string, unknown>).n === issue),
      );
      if (newItems.length !== items.length) {
        if (newItems.length === 0) {
          rules.splice(i, 1);
        } else {
          rule.issues = newItems;
        }
        return [true, `removed #${issue} from explicit-watch`];
      }
    }
    return [false, `not-subscribed (no explicit-watch entry for #${issue})`];
  }

  return [false, "no-op"];
}

function mutate(
  projectRoot: string,
  options: {
    op: "subscribe" | "unsubscribe";
    label?: string | null;
    milestone?: string | null;
    issue?: number | null;
    issueNote?: string;
    actor?: string | null;
  },
): [boolean, string] {
  const chosen = (
    [
      ["label", options.label],
      ["milestone", options.milestone],
      ["issue", options.issue],
    ] as const
  )
    .filter(([, val]) => val !== null && val !== undefined)
    .map(([name]) => name);

  if (chosen.length !== 1) {
    throw new Error(
      `${options.op}() requires exactly one of --label / --milestone / --issue; got ${JSON.stringify(chosen)}`,
    );
  }

  // Serialise the read-modify-write + subscription-history append under the
  // shared PROJECT-DEFINITION mutation lock so concurrent mutators cannot lose
  // an update or emit out-of-order audit rows (#1260).
  return withProjectDefinitionMutation(projectRoot, (mutation): [boolean, string] => {
    const data = mutation.load();
    if (typeof data.plan !== "object" || data.plan === null || Array.isArray(data.plan)) {
      throw new Error(
        `PROJECT-DEFINITION at ${mutation.artifactLabel} has a non-object 'plan' key`,
      );
    }
    const plan = data.plan as Record<string, unknown>;
    migrateLegacyPolicyKey(plan);
    const existingPolicy = plan[PLAN_POLICY_KEY];
    if (
      typeof existingPolicy !== "object" ||
      existingPolicy === null ||
      Array.isArray(existingPolicy)
    ) {
      if (existingPolicy === undefined) {
        plan[PLAN_POLICY_KEY] = {};
      } else {
        throw new Error(
          `PROJECT-DEFINITION at ${mutation.artifactLabel} has a non-object 'plan.policy' key`,
        );
      }
    }
    const policy = plan[PLAN_POLICY_KEY] as Record<string, unknown>;
    if (!Array.isArray(policy.triageScope)) {
      if (policy.triageScope === undefined) {
        policy.triageScope = [];
      } else {
        throw new Error(
          `PROJECT-DEFINITION at ${mutation.artifactLabel} has a non-list 'plan.policy.triageScope'`,
        );
      }
    }
    const rules = policy.triageScope as TriageRule[];

    const before = snapshotRules(rules);
    let changed: boolean;
    let message: string;
    if (options.op === "subscribe") {
      [changed, message] = applySubscribe(
        rules,
        options.label,
        options.milestone,
        options.issue,
        options.issueNote ?? "added via task triage:subscribe",
      );
    } else {
      [changed, message] = applyUnsubscribe(rules, options.label, options.milestone, options.issue);
    }

    if (!changed) {
      return [false, message];
    }

    mutation.persist(data);
    const after = snapshotRules(rules);
    recordSubscriptionChange(projectRoot, {
      op: options.op,
      label: options.label,
      milestone: options.milestone,
      issue: options.issue,
      before,
      after,
      actor: options.actor,
    });
    return [true, message];
  });
}

export function subscribe(
  projectRoot: string,
  options: {
    label?: string | null;
    milestone?: string | null;
    issue?: number | null;
    issueNote?: string;
    actor?: string | null;
  } = {},
): [boolean, string] {
  return mutate(projectRoot, { op: "subscribe", ...options });
}

export function unsubscribe(
  projectRoot: string,
  options: {
    label?: string | null;
    milestone?: string | null;
    issue?: number | null;
    actor?: string | null;
  } = {},
): [boolean, string] {
  return mutate(projectRoot, { op: "unsubscribe", ...options });
}

export const RECONCILE_HINT =
  "  Reconciliation: run `task triage:bootstrap` to " +
  "backfill / mark out-of-scope cached entries.";
