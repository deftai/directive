import { readFileSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";

/** Canonical eligibility folder — only vbrief/active/ may spawn implementation. */
export const ACTIVE_FOLDER = "active";

/** Canonical eligibility status — only `running` signals an active handoff. */
export const ELIGIBLE_STATUS = "running";

/** Actionable redirect appended to every reject path (#810). */
export const ACTIVATE_HINT =
  "Run `task vbrief:activate {path}` before spawning an implementation agent.";

/** Result of a vBRIEF preflight evaluation; mirrors the Python `evaluate` tuple. */
export interface EvaluateResult {
  readonly exitCode: 0 | 1;
  readonly message: string;
}

/** Substitute `{path}` without `$`-pattern expansion in user paths (#1721). */
export function formatActivateHint(path: string): string {
  return ACTIVATE_HINT.replace("{path}", () => path);
}

function buildReject(path: string, reason: string): string {
  return `${reason}\n  ${formatActivateHint(path)}`;
}

/** Map Node `JSON.parse` errors to CPython `json.JSONDecodeError.msg` for parity (#1721). */
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

/**
 * Pure evaluator — returns `{ exitCode, message }`. Never throws; every error
 * path collapses to exit 1 with an actionable message. Faithful to
 * `scripts/preflight_implementation.py::evaluate`.
 */
export function evaluate(vbriefPath: string): EvaluateResult {
  const path = vbriefPath;

  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(vbriefPath);
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return {
        exitCode: 1,
        message: buildReject(path, `vBRIEF not found at ${path}.`),
      };
    }
    return {
      exitCode: 1,
      message: buildReject(path, `Could not read vBRIEF at ${path}: ${String(e.message)}.`),
    };
  }

  if (!st.isFile()) {
    return {
      exitCode: 1,
      message: buildReject(path, `vBRIEF path ${path} is not a regular file.`),
    };
  }

  let raw: string;
  try {
    raw = readFileSync(vbriefPath, "utf8");
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    return {
      exitCode: 1,
      message: buildReject(path, `Could not read vBRIEF at ${path}: ${String(e.message)}.`),
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
      exitCode: 1,
      message: buildReject(path, `vBRIEF at ${path} is not valid JSON: ${pyMsg} (line ${line}).`),
    };
  }

  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      exitCode: 1,
      message: buildReject(path, `vBRIEF at ${path} top-level value is not a JSON object.`),
    };
  }

  const folder = basename(dirname(vbriefPath));
  if (folder !== ACTIVE_FOLDER) {
    return {
      exitCode: 1,
      message: buildReject(
        path,
        `vBRIEF is in ${folder}/ -- only vbrief/active/ is eligible for implementation.`,
      ),
    };
  }

  const record = payload as Record<string, unknown>;
  const plan = record.plan;
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) {
    return {
      exitCode: 1,
      message: buildReject(path, `vBRIEF at ${path} lacks a \`plan\` object -- malformed.`),
    };
  }

  const planRecord = plan as Record<string, unknown>;
  const status = planRecord.status;
  if (typeof status !== "string" || status.length === 0) {
    return {
      exitCode: 1,
      message: buildReject(path, `vBRIEF at ${path} lacks \`plan.status\` -- malformed.`),
    };
  }

  if (status !== ELIGIBLE_STATUS) {
    return {
      exitCode: 1,
      message: buildReject(
        path,
        `plan.status is '${status}' -- only '${ELIGIBLE_STATUS}' is eligible for implementation.`,
      ),
    };
  }

  return {
    exitCode: 0,
    message: `OK ${path} -- ready for implementation.`,
  };
}

/** Structured `--json` payload (sorted keys), mirroring Python `_emit_json`. */
export function emitJson(vbriefPath: string, exitCode: number, message: string): string {
  const payload = {
    ready: exitCode === 0,
    exit_code: exitCode,
    vbrief_path: vbriefPath,
    message,
  };
  return JSON.stringify(payload, Object.keys(payload).sort());
}
