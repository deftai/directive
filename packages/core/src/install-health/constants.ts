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
 * Standard installation/wiring recovery guidance (AC9.7).
 * Global launcher install, then repair — for deposits/wiring after the pin
 * packages already match. Not the pin≠installed project-skew message (#6013).
 */
export const INSTALLATION_RECOVERY_GUIDANCE =
  "npm i -g @deftai/directive, then directive install --repair";

/**
 * Pin≠installed recovery when only project node_modules lags the pin (#6013 / #5893).
 * Settled OVPR map (#5798 / AC9.12): project PM install first; do not lead with
 * AC9.7 global+repair. Repair remains for deposits after packages match.
 * Fail-closed still applies. The hook admits only the project install commands
 * (`pnpm install --frozen-lockfile`, `npm install`, `npm ci`), and only when
 * pin ≠ installed is the sole fault (#6313, `recovery-admit.ts`). This is not
 * the sealed #5956 allow-list; the global AC9.7 pair stays refused.
 * The hook refusal for that sole fault shows root-specific text instead
 * (`renderPinMismatchRecoveryGuidance`, #6375); this constant stays the
 * `recoveryGuidance` of the cheap check.
 */
export const PIN_MISMATCH_PROJECT_PM_RECOVERY_GUIDANCE =
  "Run `npm install` or `pnpm install` in this project (use `--frozen-lockfile` when the lockfile already records the pin). Global `npm i -g @deftai/directive` / `directive install --repair` is not the fix when only node_modules lags the pin.";

/**
 * Recovery when payload project root does not match launching checkout (SEC-WT / #6100).
 * Distinct from {@link INSTALLATION_RECOVERY_GUIDANCE} (pin ladder).
 * Prep the linked worktree under the primary session, then open that worktree
 * as the host project root so launchRoot matches. Primary global repair does
 * not rebind a primary-rooted host session (operator note 6692738765).
 */
export const HOOK_ROOT_MISMATCH_RECOVERY_GUIDANCE =
  "Prep the linked worktree (`deft swarm-worktrees prep --path <dest>`), then open that worktree as the host project root so launchRoot matches payloadRoot. Primary `npm i -g @deftai/directive` / `directive install --repair` does not rebind a primary-rooted session.";

/**
 * Recovery when the runtime that launched the hook is linked in from another
 * checkout (#6185). Names the one mismatch it clears; later gates still apply.
 */
export const FOREIGN_RUNTIME_LINK_RECOVERY_GUIDANCE =
  "Open a terminal outside this locked agent session. Remove the link at `<payloadRoot>/node_modules` or `<payloadRoot>/node_modules/@deftai/directive-runtime`, then install the runtime in `<payloadRoot>` (`pnpm install --frozen-lockfile` or `npm install`). This clears the foreign-runtime root mismatch; existing install and policy gates still apply.";

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
