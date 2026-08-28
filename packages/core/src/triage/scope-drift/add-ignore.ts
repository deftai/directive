import { migrateLegacyPolicyKey, PLAN_POLICY_KEY } from "../../policy/plan-extensions.js";
import { withProjectDefinitionMutation } from "../../vbrief-build/project-definition-mutation.js";

export interface AddIgnoreResult {
  readonly changed: boolean;
  readonly message: string;
}

/** Append a label/milestone ignore entry — mirrors Python `add_ignore`. */
export function addIgnore(
  projectRoot: string,
  options: { readonly label?: string; readonly milestone?: string },
): AddIgnoreResult {
  const hasLabel = options.label !== undefined;
  const hasMilestone = options.milestone !== undefined;
  if (hasLabel === hasMilestone) {
    throw new Error("add_ignore() requires exactly one of label= / milestone=");
  }
  const key = hasLabel ? "label" : "milestone";
  const value = (hasLabel ? options.label : options.milestone) ?? "";
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} must be a non-empty string; got ${JSON.stringify(value)}`);
  }

  // Serialise the read-modify-write under the shared PROJECT-DEFINITION
  // mutation lock so concurrent mutators cannot lose an update (#1260).
  return withProjectDefinitionMutation(projectRoot, (mutation): AddIgnoreResult => {
    const data = mutation.load();
    const plan = data.plan;
    if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
      throw new Error(
        `PROJECT-DEFINITION at ${mutation.artifactLabel} has a non-object 'plan' key`,
      );
    }
    const planRec = plan as Record<string, unknown>;
    migrateLegacyPolicyKey(planRec);
    let policy = planRec[PLAN_POLICY_KEY];
    if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
      policy = {};
      planRec[PLAN_POLICY_KEY] = policy;
    }
    const policyRec = policy as Record<string, unknown>;
    const raw: unknown[] = Array.isArray(policyRec.triageScopeIgnores)
      ? (policyRec.triageScopeIgnores as unknown[])
      : [];
    policyRec.triageScopeIgnores = raw;
    for (const entry of raw) {
      if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
        if ((entry as Record<string, unknown>)[key] === value) {
          return { changed: false, message: `already-ignored (${key}=${value})` };
        }
      }
    }
    raw.push({ [key]: value });
    mutation.persist(data);
    return { changed: true, message: `added ignore (${key}=${value})` };
  });
}
