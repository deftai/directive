/**
 * Shared constants for the in-sync / install-health module (R2, AC9.7).
 */

/** Exact pin package name under the target architecture (UNIFIED Part A). */
export const RUNTIME_PIN_PACKAGE = "@deftai/directive-runtime";

/**
 * Path prefix every managed wiring target must use (version-free).
 * Absolute under the project root once the runtime is installed.
 */
export const RUNTIME_PACKAGE_PATH_PREFIX = "node_modules/@deftai/directive-runtime/";

/**
 * Standard installation/wiring recovery guidance (AC9.7 / AC2.6).
 * Teach global launcher install, then repair of the existing exact pin.
 */
export const INSTALLATION_RECOVERY_GUIDANCE =
  "npm i -g @deftai/directive, then directive install --repair";

/** Relative path of the committed setup record. */
export const GENERATION_REL = ".deft/GENERATION.json";

/** Directory holding per-checkout readiness markers. */
export const READINESS_DIR_REL = ".deft/directive";

/** Filename pattern for readiness: wiring-ready.<runtime-version>.json (AC8.6). */
export function readinessFileName(runtimeVersion: string): string {
  return `wiring-ready.${runtimeVersion}.json`;
}

/**
 * Doctor and every diagnostic hook/helper set this env so self-completing
 * setup and readiness/Git writes are suppressed (AC8.6 / AC9.10).
 * Non-empty values other than "0"/"false"/"no" suppress writes.
 */
export const DEFT_DOCTOR_HOOK_DIAGNOSTIC = "DEFT_DOCTOR_HOOK_DIAGNOSTIC";
