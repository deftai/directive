/**
 * R16 / AC16.3–16.5: Node version gate before any other launcher work.
 */
import {
  EXIT_CODES,
  NODE_ENGINES_FLOOR_MAJOR,
  NODE_EOL_NOTE,
  NODE_SUPPORTED_MAJOR,
} from "./constants.js";

export interface NodeCheckResult {
  readonly ok: boolean;
  readonly warning: string | null;
  readonly message: string | null;
  readonly exitCode: number;
}

export function checkNodeVersion(version: string = process.versions.node): NodeCheckResult {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (!Number.isFinite(major) || major < NODE_ENGINES_FLOOR_MAJOR) {
    return {
      ok: false,
      warning: null,
      message: `Directive needs Node ${NODE_ENGINES_FLOOR_MAJOR} or later; you have ${version}.`,
      exitCode: EXIT_CODES.FAILURE,
    };
  }
  if (major < NODE_SUPPORTED_MAJOR) {
    return {
      ok: true,
      warning: NODE_EOL_NOTE,
      message: null,
      exitCode: EXIT_CODES.SUCCESS,
    };
  }
  return { ok: true, warning: null, message: null, exitCode: EXIT_CODES.SUCCESS };
}
