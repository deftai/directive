/**
 * Resolve product-first check composition mode (#3284).
 *
 * Priority (highest wins):
 *  1. DEFT_CHECK_AC_ONLY / DEFT_CHECK_MODE=rapid → rapid (AC-only)
 *  2. DEFT_CHECK_MODE=pressure|degraded or DEFT_HYGIENE_ADVISORY → pressure
 *  3. ceremony dial depth rapid|minimal → rapid
 *  4. hard effort budget (#3266) → pressure
 *  5. default full
 */

import {
  CEREMONY_DEPTHS,
  type CeremonyDepth,
  readCeremonyDialAudit,
} from "../policy/ceremony-dial.js";
import { detectHardEffortBudget } from "../session/effort-budget.js";
import {
  ENV_CHECK_AC_ONLY,
  ENV_CHECK_MODE,
  ENV_HYGIENE_ADVISORY,
  HYGIENE_GATE_ID_PREFIXES,
  PRODUCT_AC_GATE_ID,
  type ProductFirstCheckMode,
} from "./types.js";

function asCeremonyDepth(value: unknown): CeremonyDepth | null {
  return typeof value === "string" && (CEREMONY_DEPTHS as readonly string[]).includes(value)
    ? (value as CeremonyDepth)
    : null;
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);

function isTruthy(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  return TRUTHY.has(raw.trim().toLowerCase());
}

function normalizeModeToken(raw: string): ProductFirstCheckMode | null {
  const t = raw.trim().toLowerCase();
  if (t === "full" || t === "standard") return "full";
  if (t === "pressure" || t === "degraded" || t === "advisory") return "pressure";
  if (t === "rapid" || t === "minimal" || t === "ac-only" || t === "ac_only") return "rapid";
  return null;
}

export interface ResolveProductFirstCheckModeInput {
  readonly environ?: Readonly<Record<string, string | undefined>>;
  readonly projectRoot?: string;
  /** Inject ceremony depth (tests); when unset, reads ritual-state audit. */
  readonly ceremonyDepth?: CeremonyDepth | null;
  /** Inject hard-budget detected flag (tests). */
  readonly hardBudgetDetected?: boolean;
}

export interface ProductFirstCheckModeResolution {
  readonly mode: ProductFirstCheckMode;
  readonly sources: readonly string[];
  readonly hygieneAdvisory: boolean;
  readonly acOnly: boolean;
  /** AC remains mandatory whenever mode is not a pure no-op. */
  readonly acMandatory: true;
}

/**
 * Resolve the active product-first check mode from env + ceremony + budget.
 */
export function resolveProductFirstCheckMode(
  input: ResolveProductFirstCheckModeInput = {},
): ProductFirstCheckModeResolution {
  const env = input.environ ?? process.env;
  const sources: string[] = [];

  if (isTruthy(env[ENV_CHECK_AC_ONLY])) {
    sources.push(`${ENV_CHECK_AC_ONLY}=truthy`);
    return {
      mode: "rapid",
      sources,
      hygieneAdvisory: true,
      acOnly: true,
      acMandatory: true,
    };
  }

  const modeEnv = env[ENV_CHECK_MODE];
  if (typeof modeEnv === "string" && modeEnv.trim().length > 0) {
    const parsed = normalizeModeToken(modeEnv);
    if (parsed !== null) {
      sources.push(`${ENV_CHECK_MODE}=${modeEnv.trim()}`);
      return {
        mode: parsed,
        sources,
        hygieneAdvisory: parsed !== "full",
        acOnly: parsed === "rapid",
        acMandatory: true,
      };
    }
  }

  if (isTruthy(env[ENV_HYGIENE_ADVISORY])) {
    sources.push(`${ENV_HYGIENE_ADVISORY}=truthy`);
    return {
      mode: "pressure",
      sources,
      hygieneAdvisory: true,
      acOnly: false,
      acMandatory: true,
    };
  }

  let depth: CeremonyDepth | null | undefined = input.ceremonyDepth;
  if (depth === undefined && input.projectRoot !== undefined) {
    try {
      const audit = readCeremonyDialAudit(input.projectRoot);
      depth = asCeremonyDepth(audit.depth);
      if (depth !== null) sources.push(`ceremony_dial.depth=${depth}`);
    } catch {
      depth = null;
    }
  }
  if (depth === "rapid" || depth === "minimal") {
    if (!sources.some((s) => s.startsWith("ceremony_dial"))) {
      sources.push(`ceremonyDepth=${depth}`);
    }
    return {
      mode: "rapid",
      sources,
      hygieneAdvisory: true,
      acOnly: true,
      acMandatory: true,
    };
  }

  let hardBudget = input.hardBudgetDetected;
  if (hardBudget === undefined) {
    hardBudget = detectHardEffortBudget({ environ: env }).detected;
    if (hardBudget) sources.push("hard_effort_budget");
  } else if (hardBudget) {
    sources.push("hard_effort_budget(injected)");
  }
  if (hardBudget === true) {
    return {
      mode: "pressure",
      sources,
      hygieneAdvisory: true,
      acOnly: false,
      acMandatory: true,
    };
  }

  sources.push("default:full");
  return {
    mode: "full",
    sources,
    hygieneAdvisory: false,
    acOnly: false,
    acMandatory: true,
  };
}

/** True when this gate id is the product AC gate. */
export function isProductAcGate(gateId: string): boolean {
  return gateId === PRODUCT_AC_GATE_ID || gateId === "verify:literal-ac";
}

/** True when this gate is classified as hygiene (may be advisory under pressure). */
export function isHygieneGate(gateId: string): boolean {
  if (isProductAcGate(gateId)) return false;
  return HYGIENE_GATE_ID_PREFIXES.includes(gateId);
}

/**
 * Filter / annotate gate list for the resolved mode.
 * - rapid: only product AC gates
 * - pressure/full: full list (pressure marks hygiene advisory at run time)
 */
export function applyProductFirstGateMode<T extends string | { readonly task: string }>(
  gates: readonly T[],
  mode: ProductFirstCheckMode,
  gateIdOf: (g: T) => string = (g) => (typeof g === "string" ? g : g.task),
): readonly T[] {
  if (mode === "rapid") {
    const ac = gates.filter((g) => isProductAcGate(gateIdOf(g)));
    return ac.length > 0 ? ac : gates.filter((g) => gateIdOf(g) === PRODUCT_AC_GATE_ID);
  }
  return gates;
}
