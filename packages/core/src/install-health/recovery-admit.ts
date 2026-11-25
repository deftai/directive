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

import { classifyHookAuthzOps } from "../authz/classify.js";
import { isMcpProxyWrapper, isMcpTool, isMcpWriteShaped } from "../hooks/tools.js";
import { classifyMcpTool } from "../policy/runtime-authority.js";
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
 *
 * Source string is shared with the deposited host-hook outer (#7275) so the
 * missing-runtime admit stays token-parity with pin-mismatch recovery.
 */
export const PIN_MISMATCH_SIMPLE_COMMAND_SOURCE =
  "^[A-Za-z0-9@/._=-]+(?:[ \\t]+[A-Za-z0-9@/._=-]+)*$";

const SIMPLE_COMMAND = new RegExp(PIN_MISMATCH_SIMPLE_COMMAND_SOURCE);

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

/**
 * Root-mismatch recovery admit (#6599).
 *
 * The root-mismatch refusal (payload root is not the launching checkout) names
 * diagnostics and the host-hook disable as its recovery, and each is a shell
 * command the refusal itself blocks. Only these exact simple commands are
 * admitted; anything chained, extended or from another tool stays refused.
 * The foreign-runtime-link refusal (#6185) never calls this.
 */
const ROOT_MISMATCH_DIAGNOSTIC_COMMANDS: readonly (readonly string[])[] = [
  ["directive", "--version"],
  ["deft", "--version"],
  ["directive", "doctor"],
];

const ROOT_MISMATCH_CLIS: readonly string[] = ["directive", "deft"];

/** Like {@link SIMPLE_COMMAND}, plus `:` for the `policy:disable-host-hooks` verb. */
const SIMPLE_VERB_COMMAND = /^[A-Za-z0-9@/._=:-]+(?:[ \t]+[A-Za-z0-9@/._=:-]+)*$/;

/** The exact commands admitted under a root mismatch for `host` (#6599). */
export function rootMismatchRecoveryCommands(host: string): readonly string[] {
  return [
    ...ROOT_MISMATCH_DIAGNOSTIC_COMMANDS.map((tokens) => tokens.join(" ")),
    ...ROOT_MISMATCH_CLIS.map((cli) => `${cli} policy:disable-host-hooks --host ${host} --confirm`),
  ];
}

/** Canonical command when `command` is exactly an admitted one for `host`, else null. */
export function matchRootMismatchRecoveryCommand(
  command: string | null,
  host: string,
): string | null {
  if (command === null) return null;
  const trimmed = command.trim();
  if (!SIMPLE_VERB_COMMAND.test(trimmed)) return null;
  const normalized = trimmed.split(/[ \t]+/).join(" ");
  return rootMismatchRecoveryCommands(host).includes(normalized) ? normalized : null;
}

export interface RootMismatchRecoveryAdmitInput {
  /** True when the tool is a host shell tool that carries a command string. */
  readonly shellTool: boolean;
  readonly command: string | null;
  readonly host: string;
}

/** Canonical recovery command to admit under a root mismatch, or null to refuse (#6599). */
export function admitRootMismatchRecovery(input: RootMismatchRecoveryAdmitInput): string | null {
  if (!input.shellTool) return null;
  return matchRootMismatchRecoveryCommand(input.command, input.host);
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

export interface HardRefuseNonGatedMcpAdmitInput {
  readonly toolName: string;
  readonly mcpArgsText: string | null;
}

/**
 * Pure classifier AND for Claude hard-refuse non-gated MCP admit (#7352).
 *
 * Admits only MCP tools a healthy session already fail-opens: isMcpTool, not a
 * proxy wrapper, classifyMcpTool null, empty classifyHookAuthzOps, and not
 * isMcpWriteShaped. Callers gate host/event (Claude tool.before) and placement
 * before installationIdentityDeny on local root-mismatch / pin-overlay arms.
 */
export function admitHardRefuseNonGatedMcp(input: HardRefuseNonGatedMcpAdmitInput): boolean {
  const toolName = input.toolName.trim();
  if (toolName.length === 0) return false;
  if (!isMcpTool(toolName)) return false;
  if (isMcpProxyWrapper(toolName)) return false;
  if (classifyMcpTool(toolName, input.mcpArgsText) !== null) return false;
  if (isMcpWriteShaped(toolName)) return false;
  const ops = classifyHookAuthzOps({
    toolName,
    shellCommand: null,
    isDirectWrite: false,
    mcpArgsText: input.mcpArgsText,
  });
  return ops.length === 0;
}
