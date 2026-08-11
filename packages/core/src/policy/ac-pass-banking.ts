/**
 * Typed plan.policy.acPassBanking (#3285).
 *
 * Surplus-threshold policy for post-AC-pass deepening: after the first
 * stated-AC bank, agents may deepen only when remaining budget is at least
 * this fraction of the hard max (default 0.2 = 20%).
 *
 * Composes #3266 bank-the-pass and product-first done-gate (#3284).
 */

import { readPlanPolicy } from "./plan-extensions.js";
import { loadProjectDefinition } from "./resolve.js";

/** Canonical dotted path for policy:show / PROJECT-DEFINITION. */
export const FIELD_AC_PASS_BANKING = "plan.policy.acPassBanking";

/** CLI alias for `task policy:show --field=acPassBanking`. */
export const FIELD_AC_PASS_BANKING_CLI_ALIAS = "acPassBanking";

/**
 * Default surplus fraction of max turns/cost that must remain after bank
 * before self-imposed deepening is allowed (#3285).
 */
export const DEFAULT_SURPLUS_THRESHOLD = 0.2;

/** Floor / ceiling for surplusThreshold (inclusive). */
export const SURPLUS_THRESHOLD_MIN = 0;
export const SURPLUS_THRESHOLD_MAX = 1;

/** Optional env override (fraction 0–1 or percent 0–100). */
export const ENV_SURPLUS_THRESHOLD = "DEFT_AC_PASS_SURPLUS_THRESHOLD";

export interface AcPassBankingConfig {
  /**
   * When false, surplus gate is inactive (unbounded / optional discipline only).
   * Default true — the gate still only binds under a hard effort budget.
   */
  readonly enabled: boolean;
  /**
   * Minimum remaining fraction of max turns/cost required to deepen after bank.
   * Default {@link DEFAULT_SURPLUS_THRESHOLD} (0.2).
   */
  readonly surplusThreshold: number;
}

export type AcPassBankingSource = "typed" | "env" | "default" | "default-on-error";

export interface AcPassBankingResolved extends AcPassBankingConfig {
  readonly source: AcPassBankingSource;
  readonly error: string | null;
}

function defaultResolved(
  source: AcPassBankingSource,
  error: string | null = null,
  override?: Partial<AcPassBankingConfig>,
): AcPassBankingResolved {
  return {
    enabled: override?.enabled ?? true,
    surplusThreshold: override?.surplusThreshold ?? DEFAULT_SURPLUS_THRESHOLD,
    source,
    error,
  };
}

/** Parse a 0–1 fraction or a 0–100 percent string/number into a fraction. */
export function parseSurplusThreshold(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    if (raw >= 0 && raw <= 1) return raw;
    // Allow 20 meaning 20% when clearly a percent.
    if (raw > 1 && raw <= 100) return raw / 100;
    return null;
  }
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text) return null;
    const percent = text.endsWith("%");
    const n = Number(percent ? text.slice(0, -1).trim() : text);
    if (!Number.isFinite(n)) return null;
    if (percent) {
      if (n < 0 || n > 100) return null;
      return n / 100;
    }
    if (n >= 0 && n <= 1) return n;
    if (n > 1 && n <= 100) return n / 100;
    return null;
  }
  return null;
}

/** Validate a `plan.policy.acPassBanking` payload. */
export function validateAcPassBanking(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return [`${FIELD_AC_PASS_BANKING} must be an object; got ${typeof value}`];
  }
  const rec = value as Record<string, unknown>;
  const errors: string[] = [];
  if ("enabled" in rec && typeof rec.enabled !== "boolean") {
    errors.push(`${FIELD_AC_PASS_BANKING}.enabled must be a boolean`);
  }
  if ("surplusThreshold" in rec) {
    const parsed = parseSurplusThreshold(rec.surplusThreshold);
    if (parsed === null) {
      errors.push(
        `${FIELD_AC_PASS_BANKING}.surplusThreshold must be a fraction 0–1 ` +
          `(or percent 0–100); got ${JSON.stringify(rec.surplusThreshold)}`,
      );
    }
  }
  return errors;
}

/**
 * Resolve surplus policy from typed plan.policy.acPassBanking, then env,
 * then defaults (#3285).
 */
export function resolveAcPassBanking(
  projectRoot?: string | null,
  environ: Readonly<Record<string, string | undefined>> = process.env,
): AcPassBankingResolved {
  if (projectRoot !== undefined && projectRoot !== null && projectRoot.length > 0) {
    const [data, err] = loadProjectDefinition(projectRoot);
    if (data !== null) {
      const policyBlock = readPlanPolicy(data.plan);
      if (
        typeof policyBlock === "object" &&
        policyBlock !== null &&
        !Array.isArray(policyBlock) &&
        "acPassBanking" in (policyBlock as Record<string, unknown>)
      ) {
        const raw = (policyBlock as Record<string, unknown>).acPassBanking;
        const errors = validateAcPassBanking(raw);
        if (errors.length > 0) {
          return defaultResolved("default-on-error", errors[0] ?? "invalid acPassBanking");
        }
        if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
          const rec = raw as Record<string, unknown>;
          const enabled = typeof rec.enabled === "boolean" ? rec.enabled : true;
          const threshold =
            "surplusThreshold" in rec
              ? (parseSurplusThreshold(rec.surplusThreshold) ?? DEFAULT_SURPLUS_THRESHOLD)
              : DEFAULT_SURPLUS_THRESHOLD;
          return {
            enabled,
            surplusThreshold: threshold,
            source: "typed",
            error: null,
          };
        }
      }
    } else if (err !== null && err.length > 0) {
      // Fall through to env/default; record nothing as fatal.
    }
  }

  const envRaw = environ[ENV_SURPLUS_THRESHOLD];
  if (envRaw !== undefined && envRaw.trim() !== "") {
    const parsed = parseSurplusThreshold(envRaw);
    if (parsed !== null) {
      return defaultResolved("env", null, { surplusThreshold: parsed });
    }
    return defaultResolved(
      "default-on-error",
      `${ENV_SURPLUS_THRESHOLD} is not a valid fraction/percent: ${envRaw}`,
    );
  }

  return defaultResolved("default");
}

export interface AcPassBankingPolicyField {
  readonly name: typeof FIELD_AC_PASS_BANKING;
  readonly current: AcPassBankingConfig;
  readonly default: AcPassBankingConfig;
  readonly source: string;
}

/** Inspector row for `task policy:show --field=acPassBanking` (#3285). */
export function inspectAcPassBanking(
  _data: Record<string, unknown> | null,
  projectRoot?: string,
): AcPassBankingPolicyField {
  const resolved = resolveAcPassBanking(projectRoot);
  return {
    name: FIELD_AC_PASS_BANKING,
    current: {
      enabled: resolved.enabled,
      surplusThreshold: resolved.surplusThreshold,
    },
    default: {
      enabled: true,
      surplusThreshold: DEFAULT_SURPLUS_THRESHOLD,
    },
    source: resolved.source,
  };
}
