/**
 * Coverage-debt hatch policy (#3189).
 *
 * Consent / SoT surface for consumer expansion of release-originated hatch
 * behavior (#3187). Unset is fail-closed for behavior (mode off) but still
 * nags on interactive session-start until decided or dismissed with reason.
 *
 * Non-goal: a consumer tree never auto-files coverage-debt issues on
 * deftai/directive -- ledger is always THIS repo.
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
export const FIELD_COVERAGE_DEBT = "plan.policy.coverageDebt";

/** Short alias for `policy:show --field=coverageDebt`. */
export const FIELD_COVERAGE_DEBT_CLI_ALIAS = "coverageDebt";

export const COVERAGE_DEBT_STATUSES = ["unset", "decided"] as const;
export type CoverageDebtStatus = (typeof COVERAGE_DEBT_STATUSES)[number];

export const COVERAGE_DEBT_MODES = ["off", "warn", "hatch"] as const;
export type CoverageDebtMode = (typeof COVERAGE_DEBT_MODES)[number];

/** Fail-closed effective mode when unset / missing / invalid. */
export const DEFAULT_COVERAGE_DEBT_MODE: CoverageDebtMode = "off";

/** Consumers default autoFile false even under hatch mode. */
export const DEFAULT_COVERAGE_DEBT_AUTO_FILE = false;

export interface CoverageDebtConfig {
  readonly status: CoverageDebtStatus;
  readonly mode: CoverageDebtMode;
  readonly autoFile: boolean;
  /** Present when decided via dismiss-with-reason (still visible to show/doctor). */
  readonly dismissReason: string | null;
}

export type CoverageDebtSource = "typed" | "default" | "default-on-error";

export interface CoverageDebtResolved extends CoverageDebtConfig {
  readonly source: CoverageDebtSource;
  readonly error: string | null;
}

function defaultResolved(
  source: CoverageDebtSource,
  error: string | null = null,
): CoverageDebtResolved {
  return {
    status: "unset",
    mode: DEFAULT_COVERAGE_DEBT_MODE,
    autoFile: DEFAULT_COVERAGE_DEBT_AUTO_FILE,
    dismissReason: null,
    source,
    error,
  };
}

function isMode(value: unknown): value is CoverageDebtMode {
  return typeof value === "string" && (COVERAGE_DEBT_MODES as readonly string[]).includes(value);
}

function isStatus(value: unknown): value is CoverageDebtStatus {
  return typeof value === "string" && (COVERAGE_DEBT_STATUSES as readonly string[]).includes(value);
}

/** Validate a `plan.policy.coverageDebt` payload. */
export function validateCoverageDebt(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return [`${FIELD_COVERAGE_DEBT} must be an object; got ${typeof value}`];
  }
  const rec = value as Record<string, unknown>;
  const errors: string[] = [];
  if ("status" in rec && !isStatus(rec.status)) {
    errors.push(`${FIELD_COVERAGE_DEBT}.status must be one of ${COVERAGE_DEBT_STATUSES.join("|")}`);
  }
  if ("mode" in rec && !isMode(rec.mode)) {
    errors.push(`${FIELD_COVERAGE_DEBT}.mode must be one of ${COVERAGE_DEBT_MODES.join("|")}`);
  }
  if ("autoFile" in rec && typeof rec.autoFile !== "boolean") {
    errors.push(`${FIELD_COVERAGE_DEBT}.autoFile must be a boolean`);
  }
  if (
    "dismissReason" in rec &&
    rec.dismissReason !== null &&
    typeof rec.dismissReason !== "string"
  ) {
    errors.push(`${FIELD_COVERAGE_DEBT}.dismissReason must be a string or null`);
  }
  return errors;
}

/**
 * Resolve a typed block. Missing/invalid → fail-closed mode off, status unset.
 * Unset is not the same as decided-off for nag purposes.
 */
export function resolveCoverageDebtFromTypedBlock(raw: unknown): CoverageDebtResolved {
  const errors = validateCoverageDebt(raw);
  if (errors.length > 0) {
    return defaultResolved("default-on-error", errors[0] ?? "invalid coverageDebt block");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return defaultResolved("default");
  }
  const block = raw as Record<string, unknown>;
  const status: CoverageDebtStatus = isStatus(block.status) ? block.status : "unset";
  const mode: CoverageDebtMode = isMode(block.mode) ? block.mode : DEFAULT_COVERAGE_DEBT_MODE;
  // Fail-closed: hatch modes only apply when decided.
  const effectiveMode: CoverageDebtMode = status === "decided" ? mode : DEFAULT_COVERAGE_DEBT_MODE;
  const autoFileRaw =
    typeof block.autoFile === "boolean" ? block.autoFile : DEFAULT_COVERAGE_DEBT_AUTO_FILE;
  // autoFile only meaningful under hatch; never on when not hatch.
  const autoFile = effectiveMode === "hatch" ? autoFileRaw : false;
  const dismissReason =
    typeof block.dismissReason === "string" && block.dismissReason.trim().length > 0
      ? block.dismissReason.trim()
      : null;
  return {
    status,
    mode: status === "decided" ? mode : DEFAULT_COVERAGE_DEBT_MODE,
    autoFile,
    dismissReason: status === "decided" ? dismissReason : null,
    source: "typed",
    error: null,
  };
}

/** Resolve `plan.policy.coverageDebt` from PROJECT-DEFINITION (#3189). */
export function resolveCoverageDebt(projectRoot: string): CoverageDebtResolved {
  const [data, err] = loadProjectDefinition(projectRoot);
  if (data === null) {
    return defaultResolved("default-on-error", err);
  }
  const policyBlock = readPlanPolicy(data.plan);
  if (
    typeof policyBlock !== "object" ||
    policyBlock === null ||
    Array.isArray(policyBlock) ||
    !("coverageDebt" in (policyBlock as Record<string, unknown>))
  ) {
    return defaultResolved("default");
  }
  return resolveCoverageDebtFromTypedBlock((policyBlock as Record<string, unknown>).coverageDebt);
}

/** Effective hatch soft-pass allowed only when decided mode=hatch. */
export function isCoverageDebtHatchAllowed(policy: CoverageDebtResolved): boolean {
  return policy.status === "decided" && policy.mode === "hatch";
}

/** Auto-file debt issues only when hatch is allowed AND autoFile true. */
export function isCoverageDebtAutoFileAllowed(policy: CoverageDebtResolved): boolean {
  return isCoverageDebtHatchAllowed(policy) && policy.autoFile === true;
}

/**
 * Non-goal guard (#3189): consumer trees never auto-file coverage-debt on
 * deftai/directive. Ledger is always the project under check.
 */
export function coverageDebtLedgerRepoIsSelfOnly(): true {
  return true;
}

export function formatCoverageDebtStatusLine(policy: CoverageDebtResolved): string {
  const dismiss =
    policy.dismissReason !== null ? ` dismissReason=${JSON.stringify(policy.dismissReason)}` : "";
  return (
    `[deft policy] coverageDebt status=${policy.status} mode=${policy.mode} ` +
    `autoFile=${String(policy.autoFile)}${dismiss} (source=${policy.source}).`
  );
}

export interface CoverageDebtPolicyField {
  readonly name: typeof FIELD_COVERAGE_DEBT;
  readonly current: CoverageDebtConfig;
  readonly default: CoverageDebtConfig;
  readonly source: string;
}

function fieldFromResolved(resolved: CoverageDebtResolved): CoverageDebtPolicyField {
  return {
    name: FIELD_COVERAGE_DEBT,
    current: {
      status: resolved.status,
      mode: resolved.mode,
      autoFile: resolved.autoFile,
      dismissReason: resolved.dismissReason,
    },
    default: {
      status: "unset",
      mode: DEFAULT_COVERAGE_DEBT_MODE,
      autoFile: DEFAULT_COVERAGE_DEBT_AUTO_FILE,
      dismissReason: null,
    },
    source: resolved.source,
  };
}

/** Inspector row for `policy:show --field=coverageDebt`. */
export function inspectCoverageDebt(
  data: Record<string, unknown> | null,
  projectRoot?: string,
): CoverageDebtPolicyField {
  if (data === null) {
    return fieldFromResolved(defaultResolved("default"));
  }
  const policyBlock = readPlanPolicy(data.plan);
  if (
    typeof policyBlock !== "object" ||
    policyBlock === null ||
    Array.isArray(policyBlock) ||
    !("coverageDebt" in (policyBlock as Record<string, unknown>))
  ) {
    if (projectRoot !== undefined) {
      return fieldFromResolved(resolveCoverageDebt(projectRoot));
    }
    return fieldFromResolved(defaultResolved("default"));
  }
  return fieldFromResolved(
    resolveCoverageDebtFromTypedBlock((policyBlock as Record<string, unknown>).coverageDebt),
  );
}

export interface WriteCoverageDebtOptions {
  readonly mode: CoverageDebtMode;
  readonly autoFile?: boolean;
  readonly dismissReason?: string | null;
  readonly actor?: string;
  readonly note?: string;
}

export interface WriteCoverageDebtResult {
  readonly exitCode: 0 | 2;
  readonly stdout: string;
  readonly changed: boolean;
}

/** Persist decided coverageDebt (preset or dismiss-with-reason). */
export function writeCoverageDebt(
  projectRoot: string,
  options: WriteCoverageDebtOptions,
): WriteCoverageDebtResult {
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
      const previous = policyBlock.coverageDebt;
      const autoFile =
        options.mode === "hatch" ? (options.autoFile ?? DEFAULT_COVERAGE_DEBT_AUTO_FILE) : false;
      const dismissReason =
        typeof options.dismissReason === "string" && options.dismissReason.trim().length > 0
          ? options.dismissReason.trim()
          : null;
      const nextBlock: CoverageDebtConfig = {
        status: "decided",
        mode: options.mode,
        autoFile,
        dismissReason,
      };
      const previousNormalized = resolveCoverageDebtFromTypedBlock(previous);
      const changedFlag =
        previousNormalized.status !== nextBlock.status ||
        previousNormalized.mode !== nextBlock.mode ||
        previousNormalized.autoFile !== nextBlock.autoFile ||
        previousNormalized.dismissReason !== nextBlock.dismissReason;
      policyBlock.coverageDebt = nextBlock;
      if (changedFlag) {
        atomicWriteProjectDefinition(path, data);
      }

      const actor = options.actor ?? policyColonInvocation("set-coverage-debt");
      const note = options.note ?? "";
      const parts = [
        `actor=${actor}`,
        "coverageDebt.status=decided",
        `mode=${nextBlock.mode}`,
        `autoFile=${String(nextBlock.autoFile)}`,
        `dismissReason=${JSON.stringify(nextBlock.dismissReason)}`,
        `previous=${JSON.stringify(previous ?? null)}`,
      ];
      if (note) {
        parts.push(`note=${note.replace(/\n/g, " ").replace(/\r/g, " ")}`);
      }
      appendAuditLog(projectRoot, parts.join(" "));
      return { changed: changedFlag };
    });

    const resolved = resolveCoverageDebt(projectRoot);
    const lines = [
      `\u2713 ${FIELD_COVERAGE_DEBT} status=decided mode=${resolved.mode}.`,
      changed
        ? "  audit: meta/policy-changes.log updated."
        : "  no-op: value already matched (audit entry still appended for trail).",
      formatCoverageDebtStatusLine(resolved),
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
