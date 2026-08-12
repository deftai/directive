/**
 * Coverage-debt hatch policy (#3189 / #3314).
 *
 * Plain optional setting. Default off. Fail-closed when absent or invalid.
 * Hatch / auto-file are reserved — not a ship gate. Live hatch is
 * `--allow-coverage-debt=#N` (#2866).
 */

import { type CheckResumeResolved, resolveCheckResume } from "./check-resume.js";
import { readPlanPolicy } from "./plan-extensions.js";
import { loadProjectDefinition } from "./resolve.js";

/** Canonical registered policy field name. */
export const FIELD_COVERAGE_DEBT = "plan.policy.coverageDebt";

/** Short alias for `policy:show --field=coverageDebt`. */
export const FIELD_COVERAGE_DEBT_CLI_ALIAS = "coverageDebt";

export const COVERAGE_DEBT_MODES = ["off", "warn", "hatch"] as const;
export type CoverageDebtMode = (typeof COVERAGE_DEBT_MODES)[number];

/** Fail-closed effective mode when absent / missing / invalid. */
export const DEFAULT_COVERAGE_DEBT_MODE: CoverageDebtMode = "off";

/** Consumers default autoFile false even under hatch mode. */
export const DEFAULT_COVERAGE_DEBT_AUTO_FILE = false;

export interface CoverageDebtConfig {
  readonly mode: CoverageDebtMode;
  readonly autoFile: boolean;
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
    mode: DEFAULT_COVERAGE_DEBT_MODE,
    autoFile: DEFAULT_COVERAGE_DEBT_AUTO_FILE,
    source,
    error,
  };
}

function isMode(value: unknown): value is CoverageDebtMode {
  return typeof value === "string" && (COVERAGE_DEBT_MODES as readonly string[]).includes(value);
}

/** Validate a `plan.policy.coverageDebt` payload. Extra keys are ignored. */
export function validateCoverageDebt(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return [`${FIELD_COVERAGE_DEBT} must be an object; got ${typeof value}`];
  }
  const rec = value as Record<string, unknown>;
  const errors: string[] = [];
  if ("mode" in rec && !isMode(rec.mode)) {
    errors.push(`${FIELD_COVERAGE_DEBT}.mode must be one of ${COVERAGE_DEBT_MODES.join("|")}`);
  }
  if ("autoFile" in rec && typeof rec.autoFile !== "boolean") {
    errors.push(`${FIELD_COVERAGE_DEBT}.autoFile must be a boolean`);
  }
  return errors;
}

/**
 * Resolve a typed block. Missing/invalid → fail-closed mode off.
 * `mode` is the setting; leftover ritual fields (status/dismissReason) are ignored.
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
  const mode: CoverageDebtMode = isMode(block.mode) ? block.mode : DEFAULT_COVERAGE_DEBT_MODE;
  const autoFileRaw =
    typeof block.autoFile === "boolean" ? block.autoFile : DEFAULT_COVERAGE_DEBT_AUTO_FILE;
  const autoFile = mode === "hatch" ? autoFileRaw : false;
  return {
    mode,
    autoFile,
    source: "typed",
    error: null,
  };
}

/** Resolve `plan.policy.coverageDebt` from PROJECT-DEFINITION (#3314). */
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

/** Effective hatch soft-pass allowed only when mode=hatch. Reserved — unused by check/release. */
export function isCoverageDebtHatchAllowed(policy: CoverageDebtResolved): boolean {
  return policy.mode === "hatch";
}

/** Auto-file debt issues only when hatch is allowed AND autoFile true. */
export function isCoverageDebtAutoFileAllowed(policy: CoverageDebtResolved): boolean {
  return isCoverageDebtHatchAllowed(policy) && policy.autoFile === true;
}

export function formatCoverageDebtStatusLine(policy: CoverageDebtResolved): string {
  return (
    `[deft policy] coverageDebt mode=${policy.mode} ` +
    `autoFile=${String(policy.autoFile)} (source=${policy.source}).`
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
      mode: resolved.mode,
      autoFile: resolved.autoFile,
    },
    default: {
      mode: DEFAULT_COVERAGE_DEBT_MODE,
      autoFile: DEFAULT_COVERAGE_DEBT_AUTO_FILE,
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

/**
 * One-line standing disclosure when either setting is non-default (#3314).
 * Silent when both default / invalid (invalid is fail-closed off).
 */
export function coverageCheckResumeDisclosureLine(
  debt: CoverageDebtResolved,
  resume: Pick<CheckResumeResolved, "localStamp" | "source">,
): string | null {
  const debtNonDefault =
    debt.source !== "default-on-error" && debt.mode !== DEFAULT_COVERAGE_DEBT_MODE;
  const resumeNonDefault = resume.source !== "default-on-error" && resume.localStamp === "on";
  if (!debtNonDefault && !resumeNonDefault) {
    return null;
  }
  const parts: string[] = [];
  if (debtNonDefault) {
    parts.push(`coverageDebt.mode=${debt.mode}`);
  }
  if (resumeNonDefault) {
    parts.push("checkResume.localStamp=on");
  }
  return `[deft policy] ${parts.join(" ")} (reserved; not a ship gate).`;
}

/** Resolve both settings and format the standing disclosure, or null. */
export function maybeFormatCoverageCheckResumeDisclosure(projectRoot: string): string | null {
  return coverageCheckResumeDisclosureLine(
    resolveCoverageDebt(projectRoot),
    resolveCheckResume(projectRoot),
  );
}
