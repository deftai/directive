/**
 * Namespaced directive-config keys on a vBRIEF `plan` object (#1650 / #2034).
 *
 * "Category B" keys (`policy`, `completedNote`) are directive's OWN engine
 * config -- not generic xbrief/consumer-extension data -- so they live under
 * the `x-directive/` extension prefix that the conformance gate already
 * accepts (#1620 EXTENSION_PREFIXES). Once the corpus is namespaced the
 * conformance allow-list is removed, so any future bare `plan.policy` /
 * `plan.completedNote` fails the gate.
 *
 * Read accessors accept the legacy bare key as a back-compat fallback so an
 * un-migrated consumer PROJECT-DEFINITION keeps resolving while the operator
 * migrates; writers always emit (and fold a legacy block into) the namespaced
 * key.
 */

/** Namespaced directive policy block key. */
export const PLAN_POLICY_KEY = "x-directive/policy";

/** Namespaced directive scope-completion note key. */
export const PLAN_COMPLETED_NOTE_KEY = "x-directive/completedNote";

/** Legacy bare policy key (pre-#1650); read-side fallback / write-side migration source. */
export const LEGACY_PLAN_POLICY_KEY = "policy";

/** Legacy bare completedNote key (pre-#1650); read-side fallback / write-side migration source. */
export const LEGACY_PLAN_COMPLETED_NOTE_KEY = "completedNote";

function asPlanObject(plan: unknown): Record<string, unknown> | null {
  return typeof plan === "object" && plan !== null && !Array.isArray(plan)
    ? (plan as Record<string, unknown>)
    : null;
}

function readPlanExtension(plan: unknown, namespacedKey: string, legacyKey: string): unknown {
  const planObj = asPlanObject(plan);
  if (planObj === null) {
    return undefined;
  }
  const namespaced = planObj[namespacedKey];
  return namespaced !== undefined ? namespaced : planObj[legacyKey];
}

/** Read the directive policy block from a plan (namespaced first, bare fallback). */
export function readPlanPolicy(plan: unknown): unknown {
  return readPlanExtension(plan, PLAN_POLICY_KEY, LEGACY_PLAN_POLICY_KEY);
}

/** Read the directive completedNote from a plan (namespaced first, bare fallback). */
export function readPlanCompletedNote(plan: unknown): unknown {
  return readPlanExtension(plan, PLAN_COMPLETED_NOTE_KEY, LEGACY_PLAN_COMPLETED_NOTE_KEY);
}

/**
 * Rename a legacy bare `policy` key to the namespaced key in place when only
 * the bare key is present. No-op when the namespaced key already exists or no
 * policy key is present. Used by writers so a mutation never strands a legacy
 * bare block alongside the namespaced one.
 */
export function migrateLegacyPolicyKey(plan: Record<string, unknown>): void {
  if (plan[PLAN_POLICY_KEY] === undefined && plan[LEGACY_PLAN_POLICY_KEY] !== undefined) {
    plan[PLAN_POLICY_KEY] = plan[LEGACY_PLAN_POLICY_KEY];
    delete plan[LEGACY_PLAN_POLICY_KEY];
  }
}
