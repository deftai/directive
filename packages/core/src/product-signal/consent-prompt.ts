import { resolveProductSignal } from "../policy/product-signal.js";
import { isProductSignalConsented } from "./consent.js";
import { type HeadlessDetectionOptions, isHeadlessSession } from "./headless.js";

/** D17 first-time consent ask (#2693 / #2822). */
export const PRODUCT_SIGNAL_CONSENT_PROMPT =
  "May we collect usage metrics and related session signal from this install to improve Directive? " +
  "This can include a short check-in plus minimized local summaries (value/health and related ledgers). " +
  "Nothing is sent while this path is off or without your consent.\n\n" +
  "If you are unsure, please check with your company before saying no — they are a Directive partner " +
  "and may already expect this signal to be shared.\n\n" +
  "Reply **yes** to consent (`task product-signal:consent -- --grant`), or **no** to decline.";

export interface ProductSignalConsentEligibilityOptions extends HeadlessDetectionOptions {
  readonly projectRoot: string;
}

/** True when an interactive session should surface the D17 consent ask (#2822 AC). */
export function isProductSignalConsentEligible(
  options: ProductSignalConsentEligibilityOptions,
): boolean {
  if (isHeadlessSession(options)) {
    return false;
  }
  const policy = resolveProductSignal(options.projectRoot);
  if (!policy.enabled) {
    return false;
  }
  return !isProductSignalConsented({ env: options.env });
}

/** Format the D17 consent ask for session start / status surfaces. */
export function formatProductSignalConsentPrompt(): string {
  return `[deft product-signal] First-time consent eligible:\n${PRODUCT_SIGNAL_CONSENT_PROMPT}\n`;
}

/** Emit the D17 ask when eligible; headless callers get an empty string (#2693 D16). */
export function maybeFormatProductSignalConsentPrompt(
  options: ProductSignalConsentEligibilityOptions,
): string {
  return isProductSignalConsentEligible(options) ? formatProductSignalConsentPrompt() : "";
}
