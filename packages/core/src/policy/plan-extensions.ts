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

/**
 * Namespaced onboarding decision-provenance block (#1694 / #1695).
 *
 * Holds facts that must NOT be smuggled through policy value fields (e.g.
 * `plan.policy.wipCap` presence must not mean "operator decided a WIP cap").
 * Out-of-band from `x-directive/policy` so value and decision stay orthogonal.
 */
export const PLAN_ONBOARDING_KEY = "x-directive/onboarding";

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

/** Read the namespaced onboarding decision-provenance block (#1694). */
export function readPlanOnboarding(plan: unknown): unknown {
  const planObj = asPlanObject(plan);
  if (planObj === null) {
    return undefined;
  }
  return planObj[PLAN_ONBOARDING_KEY];
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

/** The namespaced/legacy key pairs a bare block can silently shadow (#2301). */
export const SHADOWABLE_PLAN_EXTENSIONS: ReadonlyArray<{
  readonly namespacedKey: string;
  readonly legacyKey: string;
}> = [
  { namespacedKey: PLAN_POLICY_KEY, legacyKey: LEGACY_PLAN_POLICY_KEY },
  { namespacedKey: PLAN_COMPLETED_NOTE_KEY, legacyKey: LEGACY_PLAN_COMPLETED_NOTE_KEY },
];

/** A plan-extension key whose bare form is silently shadowed by the namespaced form. */
export interface ShadowedPlanExtension {
  /** The namespaced key that wins the read (e.g. `x-directive/policy`). */
  readonly namespacedKey: string;
  /** The bare legacy key that is silently ignored (e.g. `policy`). */
  readonly legacyKey: string;
  /**
   * Best-effort list of sub-keys present in the shadowed bare object (e.g.
   * `["triageScope", "wipCap"]`). Empty when the bare value is not an object.
   */
  readonly shadowedSubKeys: readonly string[];
}

/**
 * Detect every plan-extension key where a bare (legacy) block coexists with the
 * namespaced form (#2301). Because `readPlanExtension` is namespace-first, the
 * bare block is never read once the namespaced key exists -- edits to it take no
 * effect. Detecting the coexistence lets callers emit a loud diagnostic instead
 * of the silent no-op that the #2295 onboarding trap exhibited.
 */
export function detectShadowedPlanExtensions(plan: unknown): ShadowedPlanExtension[] {
  const planObj = asPlanObject(plan);
  if (planObj === null) {
    return [];
  }
  const shadows: ShadowedPlanExtension[] = [];
  for (const { namespacedKey, legacyKey } of SHADOWABLE_PLAN_EXTENSIONS) {
    if (planObj[namespacedKey] === undefined || planObj[legacyKey] === undefined) {
      continue;
    }
    const legacyValue = planObj[legacyKey];
    const shadowedSubKeys =
      typeof legacyValue === "object" && legacyValue !== null && !Array.isArray(legacyValue)
        ? Object.keys(legacyValue as Record<string, unknown>)
        : [];
    shadows.push({ namespacedKey, legacyKey, shadowedSubKeys });
  }
  return shadows;
}

/**
 * Render a human-readable, loud diagnostic for a single shadowed plan-extension
 * key. The message is surface-agnostic (no leading tag) so each caller can
 * prefix it (`[policy:show]`, a doctor finding, ...).
 */
export function describeShadowedPlanExtension(shadow: ShadowedPlanExtension): string {
  const subKeys =
    shadow.shadowedSubKeys.length > 0
      ? ` Shadowed field(s): ${shadow.shadowedSubKeys
          .map((k) => `plan.${shadow.legacyKey}.${k}`)
          .join(", ")}.`
      : "";
  return (
    `bare \`plan.${shadow.legacyKey}\` coexists with namespaced \`plan.${shadow.namespacedKey}\`; ` +
    `the bare block is IGNORED (namespaced-first read) so edits to it silently take no effect.${subKeys} ` +
    `Fold its values into \`plan.${shadow.namespacedKey}\` and delete \`plan.${shadow.legacyKey}\`.`
  );
}
