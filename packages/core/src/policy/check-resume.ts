/**
 * Check-resume / local suite-stamp policy (#3189 / #3314).
 *
 * Plain optional setting. Default off. Fail-closed when absent or invalid.
 * Reserved — consumer expansion not implemented. CI never trusts a laptop stamp.
 */

import { readPlanPolicy } from "./plan-extensions.js";
import { loadProjectDefinition } from "./resolve.js";

/** Canonical registered policy field name. */
export const FIELD_CHECK_RESUME = "plan.policy.checkResume";

/** Short alias for `policy:show --field=checkResume`. */
export const FIELD_CHECK_RESUME_CLI_ALIAS = "checkResume";

export const CHECK_RESUME_LOCAL_STAMP = ["off", "on"] as const;
export type CheckResumeLocalStamp = (typeof CHECK_RESUME_LOCAL_STAMP)[number];

/** Fail-closed when absent / missing / invalid. */
export const DEFAULT_CHECK_RESUME_LOCAL_STAMP: CheckResumeLocalStamp = "off";

export interface CheckResumeConfig {
  readonly localStamp: CheckResumeLocalStamp;
}

export type CheckResumeSource = "typed" | "default" | "default-on-error";

export interface CheckResumeResolved extends CheckResumeConfig {
  readonly source: CheckResumeSource;
  readonly error: string | null;
}

function defaultResolved(
  source: CheckResumeSource,
  error: string | null = null,
): CheckResumeResolved {
  return {
    localStamp: DEFAULT_CHECK_RESUME_LOCAL_STAMP,
    source,
    error,
  };
}

function isLocalStamp(value: unknown): value is CheckResumeLocalStamp {
  return (
    typeof value === "string" && (CHECK_RESUME_LOCAL_STAMP as readonly string[]).includes(value)
  );
}

/** Validate a `plan.policy.checkResume` payload. Extra keys are ignored. */
export function validateCheckResume(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return [`${FIELD_CHECK_RESUME} must be an object; got ${typeof value}`];
  }
  const rec = value as Record<string, unknown>;
  if ("localStamp" in rec && !isLocalStamp(rec.localStamp)) {
    return [
      `${FIELD_CHECK_RESUME}.localStamp must be one of ${CHECK_RESUME_LOCAL_STAMP.join("|")}`,
    ];
  }
  return [];
}

/**
 * Resolve a typed block. Missing/invalid → localStamp off.
 * Leftover ritual fields (status/dismissReason/ciTrustsLocalStamp) are ignored.
 */
export function resolveCheckResumeFromTypedBlock(raw: unknown): CheckResumeResolved {
  const errors = validateCheckResume(raw);
  if (errors.length > 0) {
    return defaultResolved("default-on-error", errors[0] ?? "invalid checkResume block");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return defaultResolved("default");
  }
  const block = raw as Record<string, unknown>;
  const localStamp: CheckResumeLocalStamp = isLocalStamp(block.localStamp)
    ? block.localStamp
    : DEFAULT_CHECK_RESUME_LOCAL_STAMP;
  return {
    localStamp,
    source: "typed",
    error: null,
  };
}

/** Resolve `plan.policy.checkResume` from PROJECT-DEFINITION (#3314). */
export function resolveCheckResume(projectRoot: string): CheckResumeResolved {
  const [data, err] = loadProjectDefinition(projectRoot);
  if (data === null) {
    return defaultResolved("default-on-error", err);
  }
  const policyBlock = readPlanPolicy(data.plan);
  if (
    typeof policyBlock !== "object" ||
    policyBlock === null ||
    Array.isArray(policyBlock) ||
    !("checkResume" in (policyBlock as Record<string, unknown>))
  ) {
    return defaultResolved("default");
  }
  return resolveCheckResumeFromTypedBlock((policyBlock as Record<string, unknown>).checkResume);
}

/** Local suite stamp resume only when localStamp=on. Reserved — unused by check/release. */
export function isLocalStampResumeAllowed(policy: CheckResumeResolved): boolean {
  return policy.localStamp === "on";
}

export function formatCheckResumeStatusLine(policy: CheckResumeResolved): string {
  return (
    `[deft policy] checkResume localStamp=${policy.localStamp} ` + `(source=${policy.source}).`
  );
}

export interface CheckResumePolicyField {
  readonly name: typeof FIELD_CHECK_RESUME;
  readonly current: CheckResumeConfig;
  readonly default: CheckResumeConfig;
  readonly source: string;
}

function fieldFromResolved(resolved: CheckResumeResolved): CheckResumePolicyField {
  return {
    name: FIELD_CHECK_RESUME,
    current: {
      localStamp: resolved.localStamp,
    },
    default: {
      localStamp: DEFAULT_CHECK_RESUME_LOCAL_STAMP,
    },
    source: resolved.source,
  };
}

/** Inspector row for `policy:show --field=checkResume`. */
export function inspectCheckResume(
  data: Record<string, unknown> | null,
  projectRoot?: string,
): CheckResumePolicyField {
  if (data === null) {
    return fieldFromResolved(defaultResolved("default"));
  }
  const policyBlock = readPlanPolicy(data.plan);
  if (
    typeof policyBlock !== "object" ||
    policyBlock === null ||
    Array.isArray(policyBlock) ||
    !("checkResume" in (policyBlock as Record<string, unknown>))
  ) {
    if (projectRoot !== undefined) {
      return fieldFromResolved(resolveCheckResume(projectRoot));
    }
    return fieldFromResolved(defaultResolved("default"));
  }
  return fieldFromResolved(
    resolveCheckResumeFromTypedBlock((policyBlock as Record<string, unknown>).checkResume),
  );
}
