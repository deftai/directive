/**
 * Check-resume / local suite-stamp policy (#3189).
 *
 * Consent / SoT surface for consumer expansion of local suite-stamp resume
 * (#3188). Unset is fail-closed (localStamp off). CI never trusts a local
 * stamp in v1 — `ciTrustsLocalStamp` is fixed false.
 */

import { readFileSync } from "node:fs";
import {
  atomicWriteProjectDefinition,
  projectDefinitionMutationLock,
} from "../vbrief-build/project-definition-io.js";
import { migrateLegacyPolicyKey, PLAN_POLICY_KEY, readPlanPolicy } from "./plan-extensions.js";
import { policyColonInvocation } from "./policy-invocation.js";
import { appendAuditLog, loadProjectDefinition, projectDefinitionPath } from "./resolve.js";

/** Canonical registered policy field name. */
export const FIELD_CHECK_RESUME = "plan.policy.checkResume";

/** Short alias for `policy:show --field=checkResume`. */
export const FIELD_CHECK_RESUME_CLI_ALIAS = "checkResume";

export const CHECK_RESUME_STATUSES = ["unset", "decided"] as const;
export type CheckResumeStatus = (typeof CHECK_RESUME_STATUSES)[number];

export const CHECK_RESUME_LOCAL_STAMP = ["off", "on"] as const;
export type CheckResumeLocalStamp = (typeof CHECK_RESUME_LOCAL_STAMP)[number];

/** Fail-closed when unset / missing. */
export const DEFAULT_CHECK_RESUME_LOCAL_STAMP: CheckResumeLocalStamp = "off";

/**
 * FIXED false in v1 (#3189 non-goal). Separate RFC required to ever allow CI
 * to trust a laptop suite stamp.
 */
export const CHECK_RESUME_CI_TRUSTS_LOCAL_STAMP_V1 = false as const;

export interface CheckResumeConfig {
  readonly status: CheckResumeStatus;
  readonly localStamp: CheckResumeLocalStamp;
  /** Always false in v1; present for schema visibility. */
  readonly ciTrustsLocalStamp: false;
  /** Present when decided via dismiss-with-reason. */
  readonly dismissReason: string | null;
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
    status: "unset",
    localStamp: DEFAULT_CHECK_RESUME_LOCAL_STAMP,
    ciTrustsLocalStamp: CHECK_RESUME_CI_TRUSTS_LOCAL_STAMP_V1,
    dismissReason: null,
    source,
    error,
  };
}

function isStatus(value: unknown): value is CheckResumeStatus {
  return typeof value === "string" && (CHECK_RESUME_STATUSES as readonly string[]).includes(value);
}

function isLocalStamp(value: unknown): value is CheckResumeLocalStamp {
  return (
    typeof value === "string" && (CHECK_RESUME_LOCAL_STAMP as readonly string[]).includes(value)
  );
}

/** Validate a `plan.policy.checkResume` payload. */
export function validateCheckResume(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return [`${FIELD_CHECK_RESUME} must be an object; got ${typeof value}`];
  }
  const rec = value as Record<string, unknown>;
  const errors: string[] = [];
  if ("status" in rec && !isStatus(rec.status)) {
    errors.push(`${FIELD_CHECK_RESUME}.status must be one of ${CHECK_RESUME_STATUSES.join("|")}`);
  }
  if ("localStamp" in rec && !isLocalStamp(rec.localStamp)) {
    errors.push(
      `${FIELD_CHECK_RESUME}.localStamp must be one of ${CHECK_RESUME_LOCAL_STAMP.join("|")}`,
    );
  }
  if ("ciTrustsLocalStamp" in rec && rec.ciTrustsLocalStamp !== false) {
    errors.push(
      `${FIELD_CHECK_RESUME}.ciTrustsLocalStamp must be false in v1 (CI never trusts local stamps)`,
    );
  }
  if (
    "dismissReason" in rec &&
    rec.dismissReason !== null &&
    typeof rec.dismissReason !== "string"
  ) {
    errors.push(`${FIELD_CHECK_RESUME}.dismissReason must be a string or null`);
  }
  return errors;
}

/**
 * Resolve a typed block. Missing/invalid → localStamp off, status unset.
 * `ciTrustsLocalStamp` is always forced false regardless of input truthiness
 * (malformed non-false is validation error → fail-closed default).
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
  const status: CheckResumeStatus = isStatus(block.status) ? block.status : "unset";
  const localStampRaw: CheckResumeLocalStamp = isLocalStamp(block.localStamp)
    ? block.localStamp
    : DEFAULT_CHECK_RESUME_LOCAL_STAMP;
  // Fail-closed: local stamp only when decided.
  const localStamp: CheckResumeLocalStamp =
    status === "decided" ? localStampRaw : DEFAULT_CHECK_RESUME_LOCAL_STAMP;
  const dismissReason =
    typeof block.dismissReason === "string" && block.dismissReason.trim().length > 0
      ? block.dismissReason.trim()
      : null;
  return {
    status,
    localStamp,
    ciTrustsLocalStamp: CHECK_RESUME_CI_TRUSTS_LOCAL_STAMP_V1,
    dismissReason: status === "decided" ? dismissReason : null,
    source: "typed",
    error: null,
  };
}

/** Resolve `plan.policy.checkResume` from PROJECT-DEFINITION (#3189). */
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

/** Local suite stamp resume only when decided localStamp=on. */
export function isLocalStampResumeAllowed(policy: CheckResumeResolved): boolean {
  return policy.status === "decided" && policy.localStamp === "on";
}

/** Always false in v1 — CI must re-run suite, never trust a laptop stamp. */
export function isCiTrustsLocalStampAllowed(_policy?: CheckResumeResolved): false {
  return CHECK_RESUME_CI_TRUSTS_LOCAL_STAMP_V1;
}

export function formatCheckResumeStatusLine(policy: CheckResumeResolved): string {
  const dismiss =
    policy.dismissReason !== null ? ` dismissReason=${JSON.stringify(policy.dismissReason)}` : "";
  return (
    `[deft policy] checkResume status=${policy.status} localStamp=${policy.localStamp} ` +
    `ciTrustsLocalStamp=${String(policy.ciTrustsLocalStamp)}${dismiss} (source=${policy.source}).`
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
      status: resolved.status,
      localStamp: resolved.localStamp,
      ciTrustsLocalStamp: CHECK_RESUME_CI_TRUSTS_LOCAL_STAMP_V1,
      dismissReason: resolved.dismissReason,
    },
    default: {
      status: "unset",
      localStamp: DEFAULT_CHECK_RESUME_LOCAL_STAMP,
      ciTrustsLocalStamp: CHECK_RESUME_CI_TRUSTS_LOCAL_STAMP_V1,
      dismissReason: null,
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

export interface WriteCheckResumeOptions {
  readonly localStamp: CheckResumeLocalStamp;
  readonly dismissReason?: string | null;
  readonly actor?: string;
  readonly note?: string;
}

export interface WriteCheckResumeResult {
  readonly exitCode: 0 | 2;
  readonly stdout: string;
  readonly changed: boolean;
}

/** Persist decided checkResume (preset or dismiss-with-reason). */
export function writeCheckResume(
  projectRoot: string,
  options: WriteCheckResumeOptions,
): WriteCheckResumeResult {
  const path = projectDefinitionPath(projectRoot);
  try {
    const { changed } = projectDefinitionMutationLock(projectRoot, () => {
      const parsed: unknown = JSON.parse(readFileSync(path, { encoding: "utf8" }));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`PROJECT-DEFINITION at ${path} top-level value is not a JSON object`);
      }
      const data = parsed as Record<string, unknown>;
      if (typeof data.plan !== "object" || data.plan === null || Array.isArray(data.plan)) {
        if (data.plan === undefined) {
          data.plan = {};
        } else {
          throw new Error("PROJECT-DEFINITION 'plan' is not an object");
        }
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
          throw new Error("plan.policy is not an object");
        }
      }
      const policyBlock = plan[PLAN_POLICY_KEY] as Record<string, unknown>;
      const previous = policyBlock.checkResume;
      const dismissReason =
        typeof options.dismissReason === "string" && options.dismissReason.trim().length > 0
          ? options.dismissReason.trim()
          : null;
      const nextBlock: CheckResumeConfig = {
        status: "decided",
        localStamp: options.localStamp,
        ciTrustsLocalStamp: CHECK_RESUME_CI_TRUSTS_LOCAL_STAMP_V1,
        dismissReason,
      };
      const previousNormalized = resolveCheckResumeFromTypedBlock(previous);
      const changedFlag =
        previousNormalized.status !== nextBlock.status ||
        previousNormalized.localStamp !== nextBlock.localStamp ||
        previousNormalized.dismissReason !== nextBlock.dismissReason;
      policyBlock.checkResume = nextBlock;
      if (changedFlag) {
        atomicWriteProjectDefinition(path, data);
      }

      const actor = options.actor ?? policyColonInvocation("set-check-resume");
      const note = options.note ?? "";
      const parts = [
        `actor=${actor}`,
        "checkResume.status=decided",
        `localStamp=${nextBlock.localStamp}`,
        "ciTrustsLocalStamp=false",
        `dismissReason=${JSON.stringify(nextBlock.dismissReason)}`,
        `previous=${JSON.stringify(previous ?? null)}`,
      ];
      if (note) {
        parts.push(`note=${note.replace(/\n/g, " ").replace(/\r/g, " ")}`);
      }
      appendAuditLog(projectRoot, parts.join(" "));
      return { changed: changedFlag };
    });

    const resolved = resolveCheckResume(projectRoot);
    const lines = [
      `\u2713 ${FIELD_CHECK_RESUME} status=decided localStamp=${resolved.localStamp}.`,
      changed
        ? "  audit: meta/policy-changes.log updated."
        : "  no-op: value already matched (audit entry still appended for trail).",
      formatCheckResumeStatusLine(resolved),
    ];
    return { exitCode: 0, stdout: `${lines.join("\n")}\n`, changed };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes("PROJECT-DEFINITION not found") ||
      message.includes("ENOENT") ||
      message.includes("no such file")
    ) {
      return {
        exitCode: 2,
        stdout: `\u274c PROJECT-DEFINITION not found under ${projectRoot}\n`,
        changed: false,
      };
    }
    return { exitCode: 2, stdout: `\u274c Config error: ${message}\n`, changed: false };
  }
}
