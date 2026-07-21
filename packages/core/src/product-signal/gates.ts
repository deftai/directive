import { resolveProductSignal } from "../policy/product-signal.js";
import { isProductSignalConsented } from "./consent.js";
import { isHeadlessSession } from "./headless.js";

export type ProductSignalOutcome =
  | "submitted"
  | "dry-run"
  | "disabled"
  | "no-consent"
  | "no-network"
  | "non-interactive"
  | "sink-unreachable"
  | "sink-unauthorized"
  | "validation"
  | "error-config";

export interface GateEvaluation {
  readonly allowed: boolean;
  readonly outcome: ProductSignalOutcome;
  readonly message: string;
}

export interface EvaluateGatesOptions {
  readonly projectRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly requireConsent?: boolean;
  readonly stdinIsTTY?: boolean;
}

/** Pre-submit gate evaluation (#2693 D11 soft-skip matrix). */
export function evaluateProductSignalGates(options: EvaluateGatesOptions): GateEvaluation {
  const env = options.env ?? process.env;
  const policy = resolveProductSignal(options.projectRoot);

  if (!policy.enabled) {
    return {
      allowed: false,
      outcome: "disabled",
      message: "product-signal disabled (plan.policy.productSignal.enabled=false).",
    };
  }

  if (env.DEFT_NO_NETWORK === "1") {
    return {
      allowed: false,
      outcome: "no-network",
      message: "product-signal skipped (DEFT_NO_NETWORK=1).",
    };
  }

  if (isHeadlessSession({ env, stdinIsTTY: options.stdinIsTTY })) {
    if (options.requireConsent !== false && !isProductSignalConsented({ env })) {
      return {
        allowed: false,
        outcome: "non-interactive",
        message: "product-signal skipped in headless/non-interactive session (no consent on file).",
      };
    }
  }

  if (options.requireConsent !== false && !isProductSignalConsented({ env })) {
    return {
      allowed: false,
      outcome: "no-consent",
      message: "product-signal requires consent (`task product-signal:consent -- --grant`).",
    };
  }

  if (policy.error !== null) {
    return {
      allowed: false,
      outcome: "error-config",
      message: `product-signal policy error: ${policy.error}`,
    };
  }

  return {
    allowed: true,
    outcome: "submitted",
    message: "gates passed",
  };
}

/** Map GhRestError-like conditions to soft-skip outcomes (#2693 D18). */
export function classifySinkError(stderr: string, exitCode: number): ProductSignalOutcome {
  const text = stderr.toLowerCase();
  if (
    text.includes("401") ||
    text.includes("403") ||
    text.includes("404") ||
    text.includes("not found") ||
    text.includes("permission")
  ) {
    return "sink-unauthorized";
  }
  if (exitCode !== 0) {
    return "sink-unreachable";
  }
  return "sink-unreachable";
}
