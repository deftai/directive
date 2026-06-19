import {
  REFERENCED_BY_VBRIEF_SCOPES,
  SLICED_FROM_SCOPES,
  VALID_IGNORE_KEYS,
  VALID_IGNORE_RULES,
  VALID_RULE_TYPES,
} from "./constants.js";
import { parseDurationMs } from "./duration.js";
import { validateMilestoneRule } from "./milestone.js";
import { pyListRepr, pyStrRepr, pythonTypeName } from "./python-repr.js";

const INDEXED_ERROR_RE = /^plan\.policy\.triageScopeIgnores\[(\d+)\]/;

export interface ValidationResult {
  readonly errors: string[];
  readonly warnings: string[];
}

function validateRuleBody(
  rule: Record<string, unknown>,
  prefix: string,
  errors: string[],
  warnings: string[],
): void {
  const kind = rule.rule;
  if (kind === "all-open") {
    const extra = Object.keys(rule)
      .filter((k) => k !== "rule")
      .sort();
    if (extra.length > 0) {
      warnings.push(
        `${prefix}: all-open takes no parameters; ignoring extra keys ${JSON.stringify(extra)}`,
      );
    }
    return;
  }

  if (kind === "labels") {
    const anyOf = rule["any-of"];
    const allOf = rule["all-of"];
    if (anyOf === undefined && allOf === undefined) {
      errors.push(`${prefix}.labels requires 'any-of' or 'all-of'`);
      return;
    }
    if (anyOf !== undefined && allOf !== undefined) {
      errors.push(`${prefix}.labels: 'any-of' and 'all-of' are mutually exclusive`);
      return;
    }
    const target = anyOf !== undefined ? anyOf : allOf;
    const which = anyOf !== undefined ? "any-of" : "all-of";
    if (!Array.isArray(target) || target.length === 0) {
      errors.push(`${prefix}.labels.${which} must be a non-empty list of strings`);
      return;
    }
    for (let j = 0; j < target.length; j += 1) {
      const label = target[j];
      if (typeof label !== "string" || !label) {
        errors.push(`${prefix}.labels.${which}[${j}] must be a non-empty string`);
      }
    }
    return;
  }

  if (kind === "milestone") {
    validateMilestoneRule(rule, prefix, errors, warnings);
    return;
  }

  if (kind === "opened-since" || kind === "updated-since") {
    const duration = rule.duration;
    if (typeof duration !== "string" || !duration) {
      errors.push(`${prefix}.${kind} requires a non-empty 'duration' string`);
      return;
    }
    try {
      parseDurationMs(duration);
    } catch (err) {
      errors.push(`${prefix}.${kind}.duration: ${String(err)}`);
    }
    return;
  }

  if (kind === "referenced-by-vbrief") {
    const scope = rule.scope;
    if (!REFERENCED_BY_VBRIEF_SCOPES.has(String(scope))) {
      errors.push(
        `${prefix}.referenced-by-vbrief.scope must be one of ` +
          `${pyListRepr([...REFERENCED_BY_VBRIEF_SCOPES].sort())}; got ${pyStrRepr(String(scope))}`,
      );
    }
    return;
  }

  if (kind === "sliced-from") {
    const scope = rule.scope;
    if (!SLICED_FROM_SCOPES.has(String(scope))) {
      errors.push(
        `${prefix}.sliced-from.scope must be one of ` +
          `${pyListRepr([...SLICED_FROM_SCOPES].sort())}; got ${pyStrRepr(String(scope))}`,
      );
    }
    return;
  }

  if (kind === "explicit-watch") {
    const issues = rule.issues;
    if (!Array.isArray(issues) || issues.length === 0) {
      errors.push(
        `${prefix}.explicit-watch.issues must be a non-empty list of ` +
          "{n: <int>, note: <str>} objects",
      );
      return;
    }
    for (let j = 0; j < issues.length; j += 1) {
      const entry = issues[j];
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        errors.push(
          `${prefix}.explicit-watch.issues[${j}] must be an object, ` +
            `got ${pythonTypeName(entry)}`,
        );
        continue;
      }
      const rec = entry as Record<string, unknown>;
      const n = rec.n;
      const note = rec.note;
      if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
        errors.push(`${prefix}.explicit-watch.issues[${j}].n must be a positive integer`);
      }
      if (typeof note !== "string" || !note.trim()) {
        errors.push(
          `${prefix}.explicit-watch.issues[${j}].note must be a non-empty string ` +
            "(Decision 4: per-issue note required for future-operator legibility)",
        );
      }
    }
  }
}

/** Validate plan.policy.triageScope payload (#1131). */
export function validateScopeRules(rules: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (rules === null || rules === undefined) {
    return { errors, warnings };
  }

  if (!Array.isArray(rules)) {
    errors.push(
      `plan.policy.triageScope must be a list of rule objects; got ${pythonTypeName(rules)}`,
    );
    return { errors, warnings };
  }

  for (let i = 0; i < rules.length; i += 1) {
    const prefix = `plan.policy.triageScope[${i}]`;
    const rule = rules[i];
    if (typeof rule !== "object" || rule === null || Array.isArray(rule)) {
      errors.push(`${prefix} must be an object, got ${pythonTypeName(rule)}`);
      continue;
    }
    const rec = rule as Record<string, unknown>;
    const kind = rec.rule;
    if (typeof kind !== "string" || !kind) {
      errors.push(`${prefix}.rule must be a non-empty string`);
      continue;
    }
    if (!VALID_RULE_TYPES.has(kind)) {
      errors.push(
        `${prefix}.rule ${pyStrRepr(kind)} is not a valid rule type; ` +
          `expected one of ${pyListRepr([...VALID_RULE_TYPES].sort())}`,
      );
      continue;
    }
    validateRuleBody(rec, prefix, errors, warnings);
  }

  return { errors, warnings };
}

function validateSingleKeyIgnore(
  entry: Record<string, unknown>,
  prefix: string,
  errors: string[],
  warnings: string[],
): void {
  const known = Object.keys(entry)
    .filter((k) => VALID_IGNORE_KEYS.has(k))
    .sort();
  const unknown = Object.keys(entry)
    .filter((k) => !VALID_IGNORE_KEYS.has(k))
    .sort();
  if (known.length === 0) {
    errors.push(
      `${prefix} must have a 'label' / 'milestone' key OR a ` +
        `'rule' discriminator (v1 single-key keys: ${JSON.stringify([...VALID_IGNORE_KEYS].sort())}; ` +
        `v1 rule kinds: ${JSON.stringify([...VALID_IGNORE_RULES].sort())})`,
    );
    return;
  }
  if (known.length > 1) {
    errors.push(`${prefix}: 'label' and 'milestone' are mutually exclusive`);
    return;
  }
  if (unknown.length > 0) {
    warnings.push(
      `${prefix}: ignoring unrecognised keys ${JSON.stringify(unknown)} ` +
        "(forward-compat: future ignore-entry variants will surface here)",
    );
  }
  const key = known[0] ?? "label";
  const value = entry[key];
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${prefix}.${key} must be a non-empty string`);
  }
}

function validateRuleIgnore(
  entry: Record<string, unknown>,
  prefix: string,
  errors: string[],
  warnings: string[],
): void {
  const kind = entry.rule;
  if (typeof kind !== "string" || !kind.trim()) {
    errors.push(`${prefix}.rule must be a non-empty string`);
    return;
  }
  if (!VALID_IGNORE_RULES.has(kind)) {
    errors.push(
      `${prefix}.rule ${JSON.stringify(kind)} is not a recognised ignore-rule ` +
        `kind; expected one of ${JSON.stringify([...VALID_IGNORE_RULES].sort())}`,
    );
    return;
  }
  if (kind === "author") {
    const anyOf = entry["any-of"];
    if (!Array.isArray(anyOf) || anyOf.length === 0) {
      errors.push(
        `${prefix}.author requires 'any-of' as a non-empty list ` +
          "of GitHub login strings (e.g. ['dependabot[bot]'])",
      );
      return;
    }
    for (let j = 0; j < anyOf.length; j += 1) {
      const name = anyOf[j];
      if (typeof name !== "string" || !name.trim()) {
        errors.push(`${prefix}.author.any-of[${j}] must be a non-empty string`);
      }
    }
    const extra = Object.keys(entry)
      .filter((k) => k !== "rule" && k !== "any-of")
      .sort();
    if (extra.length > 0) {
      warnings.push(
        `${prefix}.author: ignoring unrecognised keys ${JSON.stringify(extra)} ` +
          "(forward-compat: future author-rule variants will surface here)",
      );
    }
  }
}

/** Validate plan.policy.triageScopeIgnores payload (#1133 / #1182). */
export function validateScopeIgnores(ignores: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (ignores === null || ignores === undefined) {
    return { errors, warnings };
  }
  if (!Array.isArray(ignores)) {
    errors.push(
      "plan.policy.triageScopeIgnores must be a list of " +
        "{label|milestone: <name>} or {rule: <kind>, any-of: [...]} " +
        `objects; got ${pythonTypeName(ignores)}`,
    );
    return { errors, warnings };
  }
  for (let i = 0; i < ignores.length; i += 1) {
    const prefix = `plan.policy.triageScopeIgnores[${i}]`;
    const entry = ignores[i];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      errors.push(`${prefix} must be an object, got ${pythonTypeName(entry)}`);
      continue;
    }
    const rec = entry as Record<string, unknown>;
    if ("rule" in rec) {
      validateRuleIgnore(rec, prefix, errors, warnings);
    } else {
      validateSingleKeyIgnore(rec, prefix, errors, warnings);
    }
  }
  return { errors, warnings };
}

function pointerForError(err: string, rawList: unknown[]): string {
  const match = INDEXED_ERROR_RE.exec(err);
  if (match) {
    const idx = Number(match[1]);
    if (idx >= 0 && idx < rawList.length) {
      const entry = rawList[idx];
      if (typeof entry === "object" && entry !== null && !Array.isArray(entry) && "rule" in entry) {
        return "#1182";
      }
    }
  }
  return "#1133";
}

export function validateTriageScopeOnPlan(plan: unknown, filepath: string): string[] {
  const out: string[] = [];
  const policy =
    typeof plan === "object" && plan !== null && !Array.isArray(plan)
      ? (plan as Record<string, unknown>).policy
      : undefined;
  const rawScope =
    typeof policy === "object" && policy !== null && !Array.isArray(policy)
      ? (policy as Record<string, unknown>).triageScope
      : undefined;
  if (rawScope === undefined) return out;
  const { errors } = validateScopeRules(rawScope);
  for (const err of errors) {
    out.push(`${filepath}: ${err} (#1131)`);
  }
  return out;
}

export function validateTriageScopeIgnoresOnPlan(plan: unknown, filepath: string): string[] {
  const out: string[] = [];
  const policy =
    typeof plan === "object" && plan !== null && !Array.isArray(plan)
      ? (plan as Record<string, unknown>).policy
      : undefined;
  const raw =
    typeof policy === "object" && policy !== null && !Array.isArray(policy)
      ? (policy as Record<string, unknown>).triageScopeIgnores
      : undefined;
  if (raw === undefined) return out;
  const { errors } = validateScopeIgnores(raw);
  const rawList = Array.isArray(raw) ? raw : [];
  for (const err of errors) {
    out.push(`${filepath}: ${err} (${pointerForError(err, rawList)})`);
  }
  return out;
}
