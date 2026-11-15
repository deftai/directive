/**
 * Pin-mismatch recovery admit (#6313).
 *
 * The cheap hook check fails closed when the pin ≠ the installed runtime, and
 * its refusal names a project install as the recovery. That install is itself
 * a shell command, so without this admit the hook refuses its own recovery.
 *
 * Only the named project install commands are admitted, only as simple
 * uncompounded commands run at the project root, and only when pin ≠ installed
 * is the sole fault (no overlay; a root/identity mismatch is refused earlier).
 * The global AC9.7 pair (`npm i -g @deftai/directive`, `directive install
 * --repair`) is not admitted: it is not the pin-mismatch fix (AC9.12) and the
 * sealed #5956 allow-list bans it. Everything else stays refused until the
 * install matches the pin.
 */

import type { CheapInSyncResult } from "./types.js";

/** Exact project install token sequences admitted on pin mismatch (#6313). */
export const PIN_MISMATCH_RECOVERY_COMMANDS: readonly (readonly string[])[] = [
  ["pnpm", "install", "--frozen-lockfile"],
  ["npm", "install"],
  ["npm", "ci"],
];

/**
 * Characters a simple recovery command may contain. Anything else (`;`, `&`,
 * `|`, redirects, quotes, `$`, backticks, parentheses, newlines) means the
 * command is compound or shell-expanded, so it is not admitted.
 */
const SIMPLE_COMMAND = /^[A-Za-z0-9@/._=-]+(?:[ \t]+[A-Za-z0-9@/._=-]+)*$/;

/**
 * Return the canonical recovery command when `command` is exactly one of
 * {@link PIN_MISMATCH_RECOVERY_COMMANDS} as a simple command, else null.
 */
export function matchPinMismatchRecoveryCommand(command: string | null): string | null {
  if (command === null) return null;
  const trimmed = command.trim();
  if (!SIMPLE_COMMAND.test(trimmed)) return null;
  const tokens = trimmed.split(/[ \t]+/);
  for (const candidate of PIN_MISMATCH_RECOVERY_COMMANDS) {
    if (
      candidate.length === tokens.length &&
      candidate.every((token, index) => token === tokens[index])
    ) {
      return candidate.join(" ");
    }
  }
  return null;
}

/** True when pin ≠ installed is the only cheap fail-closed fault (#6313). */
export function isPinMismatchOnly(cheap: CheapInSyncResult): boolean {
  return cheap.failClosed && cheap.pinMismatchOnly === true;
}

export interface PinMismatchRecoveryAdmitInput {
  readonly cheap: CheapInSyncResult;
  /** True when the tool is a host shell tool that carries a command string. */
  readonly shellTool: boolean;
  readonly command: string | null;
  /** True when the command runs at the project root. */
  readonly atProjectRoot: boolean;
}

/**
 * Canonical recovery command to admit, or null to keep the refusal (#6313).
 */
export function admitPinMismatchRecovery(input: PinMismatchRecoveryAdmitInput): string | null {
  if (!isPinMismatchOnly(input.cheap)) return null;
  if (!input.shellTool || !input.atProjectRoot) return null;
  return matchPinMismatchRecoveryCommand(input.command);
}
