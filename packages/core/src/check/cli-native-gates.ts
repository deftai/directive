/**
 * CLI-native check-gate dispatch (#3335).
 *
 * Consumer `verify:*` (and sibling CLI verbs) must run via global
 * `deft`/`directive` when go-task is absent. Coordinate with the #3324
 * engine-invoke deposit marker: same global-CLI surface, no install-go-task
 * remedy when every composed gate is CLI-dispatchable.
 */

import type { CheckGateSpec } from "./gate-lists.js";
import { checkGateId } from "./gate-lists.js";

/** Install the published CLI — not go-task — when a deposit has no global deft. */
export const GLOBAL_CLI_REMEDY = "Install: npm i -g @deftai/directive@latest";

const WIN32_CMD_METACHAR_RE = /[\s"&|<>^()%!]/;

export type GateDispatchMode = "task" | "cli";

/** True when the gate is a native CLI verb and does not require go-task. */
export function isCliNativeGate(gateId: string): boolean {
  if (gateId.startsWith("verify:") || gateId.startsWith("verify-")) return true;
  return (
    gateId === "doctor" ||
    gateId === "vbrief:validate" ||
    gateId === "toolchain:check" ||
    gateId === "toolchain:check-consumer" ||
    gateId === "ts:check-lane"
  );
}

export function allGatesCliDispatchable(gates: readonly CheckGateSpec[]): boolean {
  return gates.every((spec) => isCliNativeGate(checkGateId(spec)));
}

/**
 * Argv for `deft <verb> …` (no go-task `--` separator, no `--taskfile`).
 */
export function checkGateCliArgv(spec: CheckGateSpec): string[] {
  const id = checkGateId(spec);
  const extra = typeof spec === "string" ? [] : (spec.args ?? []);
  if (id === "toolchain:check-consumer") {
    return ["toolchain-check", "--consumer", ...extra];
  }
  if (id === "toolchain:check") {
    return ["toolchain-check", ...extra];
  }
  if (id === "ts:check-lane") {
    return ["ts-check-lane", ...extra];
  }
  return [id, ...extra];
}

export function resolveGlobalCliBin(which: (name: string) => string | null): string | null {
  return which("deft") ?? which("directive");
}

/** Quote one argv token for `cmd.exe /d /s /c` (mirrors tasks/engine-invoke.cjs). */
export function quoteWin32Arg(arg: string): string {
  if (arg.length > 0 && !WIN32_CMD_METACHAR_RE.test(arg)) {
    return arg;
  }
  return `"${arg.replace(/"/g, '""')}"`;
}

/**
 * Spawn plan for the global CLI. Win32 uses cmd.exe so `.cmd` shims run
 * without `shell: true` (#3324 / #2547).
 */
export function cliSpawnPlan(
  cliBin: string,
  argv: readonly string[],
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform === "win32") {
    const commandLine = [cliBin, ...argv].map(quoteWin32Arg).join(" ");
    return { command: "cmd.exe", args: ["/d", "/s", "/c", commandLine] };
  }
  return { command: cliBin, args: [...argv] };
}

export function resolveGateDispatch(input: {
  readonly gateId: string;
  readonly taskPresent: boolean;
  readonly cliBin: string | null;
}):
  | { readonly mode: GateDispatchMode; readonly bin: string }
  | { readonly skip: true; readonly cause: string; readonly remedy: string } {
  if (input.taskPresent) {
    return { mode: "task", bin: "task" };
  }
  if (isCliNativeGate(input.gateId) && input.cliBin !== null) {
    return { mode: "cli", bin: input.cliBin };
  }
  if (isCliNativeGate(input.gateId)) {
    return {
      skip: true,
      cause: "no go-task and no global deft/directive CLI",
      remedy: GLOBAL_CLI_REMEDY,
    };
  }
  return {
    skip: true,
    cause: "go-task binary not found on PATH",
    remedy: "Install go-task: https://taskfile.dev/installation/",
  };
}
