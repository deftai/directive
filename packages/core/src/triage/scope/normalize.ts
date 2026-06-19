import { createHash } from "node:crypto";
import { SUBSCRIPTION_HASH_LEN } from "./constants.js";

function sortRuleObject(rule: Record<string, unknown>): Record<string, unknown> {
  const nRule: Record<string, unknown> = {};
  for (const key of Object.keys(rule).sort()) {
    let value = rule[key];
    if (rule.rule === "labels" && (key === "any-of" || key === "all-of") && Array.isArray(value)) {
      value = [...value].sort();
    } else if (rule.rule === "explicit-watch" && key === "issues" && Array.isArray(value)) {
      value = value
        .filter(
          (v): v is Record<string, unknown> =>
            typeof v === "object" && v !== null && !Array.isArray(v),
        )
        .map((v) => {
          const sorted: Record<string, unknown> = {};
          for (const k of Object.keys(v).sort()) sorted[k] = v[k];
          return sorted;
        })
        .sort((a, b) => Number(a.n ?? 0) - Number(b.n ?? 0));
    }
    nRule[key] = value;
  }
  return nRule;
}

/** Stable canonical-ordered copy of scope rules for hashing. */
export function normalizeScopeRules(
  rules: Iterable<Record<string, unknown>>,
): Record<string, unknown>[] {
  const normalised: Record<string, unknown>[] = [];
  for (const rule of rules) {
    if (typeof rule !== "object" || rule === null || Array.isArray(rule)) continue;
    normalised.push(sortRuleObject(rule));
  }
  return normalised.sort((a, b) => {
    const sa = JSON.stringify(a);
    const sb = JSON.stringify(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
}

/** Stable canonical-JSON SHA-256 digest truncated to SUBSCRIPTION_HASH_LEN. */
export function subscriptionHash(rules: Iterable<Record<string, unknown>>): string {
  const canonical = JSON.stringify(normalizeScopeRules(rules));
  const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
  return digest.slice(0, SUBSCRIPTION_HASH_LEN);
}
