import { resolveVersion } from "../doctor/paths.js";
import {
  detectDeftDirectiveDisable,
  formatDeftDirectiveDisableMessage,
} from "../policy/deft-directive-disable.js";
import {
  detectNoDeftDirective,
  NO_DEFT_DIRECTIVE_DISABLED_MESSAGE,
  NO_DEFT_DIRECTIVE_INCONSISTENT_MESSAGE,
} from "../policy/no-deft-directive.js";
import { detectBranch } from "./git.js";
import { detectLatestActiveVbrief, writeSentinel } from "./ritual-sentinel.js";

export interface SessionStartHookOptions {
  readonly resolveVersionFn?: () => string;
  readonly detectBranchFn?: (projectRoot: string) => string | null;
  readonly detectLatestActiveVbriefFn?: (projectRoot: string) => string | null;
  readonly writeSentinelFn?: typeof writeSentinel;
  /** Test seam for #2926 opt-out detection. */
  readonly detectNoDeftDirectiveFn?: typeof detectNoDeftDirective;
  /** Test seam for #3039 test kill-switch detection. */
  readonly detectDeftDirectiveDisableFn?: typeof detectDeftDirectiveDisable;
}

/** Write ``.deft/last-session.json`` from current git state (#1269). */
export function runSessionStartHookWrite(
  projectRoot: string,
  options: SessionStartHookOptions = {},
): { code: number; stdout: string; stderr: string } {
  const detectKill = options.detectDeftDirectiveDisableFn ?? detectDeftDirectiveDisable;
  // #3039: local (untracked) kill-switch — skip ritual bookkeeping (deposit OK).
  // Tracked flags do not short-circuit (enforcement stays on).
  const kill = detectKill(projectRoot);
  if (kill.active) {
    const detectOptOut = options.detectNoDeftDirectiveFn ?? detectNoDeftDirective;
    const optOut = detectOptOut(projectRoot);
    const message = formatDeftDirectiveDisableMessage({
      permanentOptOutAlsoPresent: optOut.present,
      trackedByGit: false,
    });
    return {
      code: 0,
      stdout: `${message}\n`,
      stderr: "",
    };
  }

  const detectOptOut = options.detectNoDeftDirectiveFn ?? detectNoDeftDirective;
  // #2926: root opt-out wins — host SessionStart must not write ritual bookkeeping.
  const optOut = detectOptOut(projectRoot);
  if (optOut.present) {
    const lines = [NO_DEFT_DIRECTIVE_DISABLED_MESSAGE];
    if (optOut.inconsistent) {
      lines.push(NO_DEFT_DIRECTIVE_INCONSISTENT_MESSAGE);
    }
    return {
      code: optOut.inconsistent ? 1 : 0,
      stdout: `${lines.join("\n")}\n`,
      stderr: optOut.inconsistent ? `${NO_DEFT_DIRECTIVE_INCONSISTENT_MESSAGE}\n` : "",
    };
  }

  const detectBranchFn = options.detectBranchFn ?? detectBranch;
  const detectVbriefFn = options.detectLatestActiveVbriefFn ?? detectLatestActiveVbrief;
  const resolveVersionFn = options.resolveVersionFn ?? resolveVersion;
  const writeFn = options.writeSentinelFn ?? writeSentinel;

  const branch = detectBranchFn(projectRoot);
  if (!branch) {
    return {
      code: 2,
      stdout: "",
      stderr:
        "_session_start_hook.py: could not determine current git branch; skipping sentinel write.\n",
    };
  }
  const lastActive = detectVbriefFn(projectRoot);
  if (!lastActive) {
    return {
      code: 2,
      stdout: "",
      stderr:
        "_session_start_hook.py: no active vBRIEF found under vbrief/active/; skipping sentinel write.\n",
    };
  }
  let deftVersion: string;
  try {
    deftVersion = resolveVersionFn();
  } catch (exc) {
    return {
      code: 2,
      stdout: "",
      stderr: `_session_start_hook.py: resolve_version failed: ${String(exc)}; skipping sentinel write.\n`,
    };
  }
  try {
    const sentinelPath = writeFn(projectRoot, {
      deftVersion,
      lastActiveVbrief: lastActive,
      lastBranch: branch,
    });
    return { code: 0, stdout: `${sentinelPath}\n`, stderr: "" };
  } catch (exc) {
    return {
      code: 1,
      stdout: "",
      stderr: `_session_start_hook.py: sentinel write failed: ${String(exc)}\n`,
    };
  }
}
