import { resolveVersion } from "../doctor/paths.js";
import { detectBranch } from "./git.js";
import { detectLatestActiveVbrief, writeSentinel } from "./ritual-sentinel.js";

export interface SessionStartHookOptions {
  readonly resolveVersionFn?: () => string;
  readonly detectBranchFn?: (projectRoot: string) => string | null;
  readonly detectLatestActiveVbriefFn?: (projectRoot: string) => string | null;
  readonly writeSentinelFn?: typeof writeSentinel;
}

/** Write ``.deft/last-session.json`` from current git state (#1269). */
export function runSessionStartHookWrite(
  projectRoot: string,
  options: SessionStartHookOptions = {},
): { code: number; stdout: string; stderr: string } {
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
