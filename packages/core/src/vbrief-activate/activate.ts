import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname } from "node:path";
import { utcNowIso } from "../scope/vbrief-json.js";
import { pythonJsonPretty } from "../vbrief-build/json.js";
import {
  ACTIVE_FOLDER,
  ELIGIBLE_STATUSES_FOR_FLIP,
  formatEligibleStatusList,
  SOURCE_FOLDERS,
  TARGET_STATUS,
} from "./constants.js";

export interface ActivateResult {
  readonly exitCode: 0 | 1;
  readonly message: string;
}

/** Map Node ``JSON.parse`` errors to CPython ``json.JSONDecodeError.msg`` for parity. */
function nodeJsonErrorToPythonMsg(nodeMessage: string): string {
  if (
    nodeMessage.includes("Expected property name") ||
    nodeMessage.includes("Expected double-quoted property name")
  ) {
    return "Expecting property name enclosed in double quotes";
  }
  if (
    nodeMessage.startsWith("Unexpected token") ||
    nodeMessage.startsWith("Unexpected end of JSON input")
  ) {
    return "Expecting value";
  }
  if (nodeMessage.includes("Unexpected non-whitespace character after JSON")) {
    return "Extra data";
  }
  const atPos = nodeMessage.indexOf(" at position ");
  return atPos >= 0 ? nodeMessage.slice(0, atPos) : nodeMessage;
}

function loadVbrief(vbriefPath: string): {
  payload: Record<string, unknown> | null;
  error: string | null;
} {
  let raw: string;
  try {
    raw = readFileSync(vbriefPath, "utf8");
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    return {
      payload: null,
      error: `Could not read vBRIEF at ${vbriefPath}: ${String(e.message)}.`,
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch (err: unknown) {
    const e = err as SyntaxError;
    const lineCol = /\(line (\d+) column \d+\)/.exec(e.message);
    const line = lineCol ? Number(lineCol[1]) : 1;
    const pyMsg = nodeJsonErrorToPythonMsg(e.message);
    return {
      payload: null,
      error: `vBRIEF at ${vbriefPath} is not valid JSON: ${pyMsg} (line ${line}).`,
    };
  }

  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      payload: null,
      error: `vBRIEF at ${vbriefPath} top-level value is not a JSON object.`,
    };
  }

  return { payload: payload as Record<string, unknown>, error: null };
}

export interface ActivateOptions {
  readonly now?: Date;
}

/**
 * Pure activator — returns ``{ exitCode, message }``. Faithful to
 * ``scripts/vbrief_activate.py::activate``.
 */
export function activate(vbriefPath: string, options: ActivateOptions = {}): ActivateResult {
  const now = options.now ?? new Date();

  if (!existsSync(vbriefPath)) {
    return { exitCode: 1, message: `vBRIEF not found at ${vbriefPath}.` };
  }

  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(vbriefPath);
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    return {
      exitCode: 1,
      message: `Could not read vBRIEF at ${vbriefPath}: ${String(e.message)}.`,
    };
  }

  if (!st.isFile()) {
    return { exitCode: 1, message: `vBRIEF path ${vbriefPath} is not a regular file.` };
  }

  const { payload, error } = loadVbrief(vbriefPath);
  if (error !== null || payload === null) {
    return { exitCode: 1, message: error ?? "vBRIEF could not be loaded." };
  }

  const plan = payload.plan;
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) {
    return {
      exitCode: 1,
      message: `vBRIEF at ${vbriefPath} lacks a \`plan\` object -- malformed.`,
    };
  }
  const planObj = plan as Record<string, unknown>;

  const status = planObj.status;
  if (typeof status !== "string" || status.length === 0) {
    return { exitCode: 1, message: `vBRIEF at ${vbriefPath} lacks \`plan.status\` -- malformed.` };
  }

  const folder = basename(dirname(vbriefPath));

  if (folder === ACTIVE_FOLDER && status === TARGET_STATUS) {
    return { exitCode: 0, message: `No-op: ${vbriefPath} already active.` };
  }

  if (folder === ACTIVE_FOLDER) {
    return {
      exitCode: 1,
      message:
        `vBRIEF is already in active/ but plan.status is '${status}', ` +
        `not '${TARGET_STATUS}'. Use the appropriate task (e.g. ` +
        "`task scope:unblock`) instead of `task vbrief:activate`.",
    };
  }

  if (!SOURCE_FOLDERS.has(folder)) {
    return {
      exitCode: 1,
      message:
        `vBRIEF is in ${folder}/ -- only pending/ vBRIEFs can be activated. ` +
        "Use the lifecycle tasks (`task scope:promote`, etc.) to move it " +
        "into pending/ first.",
    };
  }

  if (!ELIGIBLE_STATUSES_FOR_FLIP.has(status)) {
    return {
      exitCode: 1,
      message:
        `plan.status is '${status}' -- only ${formatEligibleStatusList()} can be flipped to ` +
        `'${TARGET_STATUS}'.`,
    };
  }

  planObj.status = TARGET_STATUS;

  let info = payload.vBRIEFInfo;
  if (info === undefined) {
    info = {};
    payload.vBRIEFInfo = info;
  }
  if (info === null || typeof info !== "object" || Array.isArray(info)) {
    return {
      exitCode: 1,
      message: `vBRIEF at ${vbriefPath} has a non-object \`vBRIEFInfo\` -- malformed.`,
    };
  }
  (info as Record<string, unknown>).updated = utcNowIso(now);

  const vbriefDir = dirname(dirname(vbriefPath));
  const activeDir = `${vbriefDir}/${ACTIVE_FOLDER}`;
  try {
    mkdirSync(activeDir, { recursive: true });
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    return { exitCode: 1, message: `Could not create ${activeDir}: ${String(e.message)}.` };
  }

  const fileName = basename(vbriefPath);
  const dest = `${activeDir}/${fileName}`;
  if (existsSync(dest)) {
    return {
      exitCode: 1,
      message:
        `Refusing to overwrite existing destination ${dest}. Resolve the ` +
        "collision manually before re-running `task vbrief:activate`.",
    };
  }

  const tmp = `${dest}.tmp`;
  try {
    writeFileSync(tmp, pythonJsonPretty(payload), "utf8");
    renameSync(tmp, dest);
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    return { exitCode: 1, message: `Could not write ${dest}: ${String(e.message)}.` };
  }

  try {
    unlinkSync(vbriefPath);
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    return {
      exitCode: 1,
      message:
        `Wrote ${dest} but could not remove source ${vbriefPath}: ${String(e.message)}. ` +
        "Manual cleanup required.",
    };
  }

  return {
    exitCode: 0,
    message: `Activated ${fileName}: pending/ -> active/ (status: ${TARGET_STATUS}).`,
  };
}
