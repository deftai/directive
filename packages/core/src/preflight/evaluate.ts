import { readFileSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { evaluateIntentCeilingFromEnv } from "../policy/intent-ceiling.js";
import {
  evaluateParentLineage,
  formatParentLineageLine,
  type ParentLineageResult,
} from "../scope/parent-lineage.js";
import {
  evaluateOriginFreshness,
  type FetchOriginUpdatedAt,
} from "../vbrief-reconcile/origin-freshness.js";
import { evaluateIntendedPlacement, resolveProjectRootFromBrief } from "./intended-placement.js";
import {
  evaluateProjectInvariantsGate,
  resolveProjectRootForInvariants,
} from "./project-invariants-gate.js";

/** Canonical eligibility folder — only vbrief/active/ may spawn implementation. */
export const ACTIVE_FOLDER = "active";

/** Canonical eligibility status — only `running` signals an active handoff. */
export const ELIGIBLE_STATUS = "running";

/** Actionable redirect appended to every reject path (#810 / #2449). */
export const ACTIVATE_HINT =
  "Run `task scope:activate -- {path}` (or legacy `task vbrief:activate -- {path}`) before spawning an implementation agent.";

/** Lifecycle folder names eligible for implementation (#810). */
export const ELIGIBLE_LIFECYCLE_DIRS = ["xbrief/active", "vbrief/active"] as const;

export const PREFLIGHT_USAGE_HINT =
  "Expected: `task xbrief:preflight -- xbrief/active/<story>.xbrief.json` (legacy: `task vbrief:preflight -- <path>`).";

/** Result of a vBRIEF preflight evaluation; mirrors the Python `evaluate` tuple. */
export interface EvaluateResult {
  readonly exitCode: 0 | 1;
  readonly message: string;
  /** #3241 parent-lineage probe when structural checks passed far enough to load the payload. */
  readonly parentLineage?: ParentLineageResult;
}

export interface EvaluateOptions {
  /** Project root for resolving child planRef → parent (#3241). */
  readonly projectRoot?: string;
  /** Skip parent-lineage check (tests / opt-out). Default false. */
  readonly skipParentLineage?: boolean;
  /** Skip origin timestamp freshness (#3363). Default false. */
  readonly skipOriginFreshness?: boolean;
  /** Skip project-invariant coverage (#3425). Default false. */
  readonly skipProjectInvariants?: boolean;
  /** Skip intended-placement size check (#3424). Default false. */
  readonly skipIntendedPlacement?: boolean;
  /** Injected origin fetch for tests. Default: live `gh api` REST. */
  readonly fetchOriginUpdatedAt?: FetchOriginUpdatedAt;
}

/** Substitute `{path}` without `$`-pattern expansion in user paths (#1721). */
export function formatActivateHint(path: string): string {
  return ACTIVATE_HINT.replace("{path}", () => path);
}

function buildReject(path: string, reason: string): string {
  return `${reason}\n  ${PREFLIGHT_USAGE_HINT}\n  ${formatActivateHint(path)}`;
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
 *
 * #3241: after active+running + intent ceiling, re-check parent requirement
 * lineage (coverage + approved behavioral deltas). Fail closed on missing
 * coverage or undeclared deltas when the parent authors requirement IDs.
 */
export function evaluate(vbriefPath: string, options: EvaluateOptions = {}): EvaluateResult {
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
  const parent = basename(dirname(dirname(vbriefPath)));
  const lifecycleDir = `${parent}/${folder}`;
  if (folder !== ACTIVE_FOLDER) {
    return {
      exitCode: 1,
      message: buildReject(
        path,
        `xBRIEF is in ${lifecycleDir}/ -- only xbrief/active/ (or legacy vbrief/active/) is eligible for implementation.`,
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

  // Slash-command intent containment (#1193 / extends #810): non-implement session
  // verbs must not authorize implementation preflight even when the xBRIEF is active.
  const intent = evaluateIntentCeilingFromEnv("implement");
  if (!intent.allowed) {
    return {
      exitCode: 1,
      message: buildReject(path, intent.reason),
    };
  }

  // #3241 pre-PR / implementation preflight: parent lineage fail-closed.
  const lineage = evaluateParentLineage({
    child: record,
    childPath: path,
    projectRoot: options.projectRoot,
    skip: options.skipParentLineage === true,
  });
  if (!lineage.ok) {
    const defect = lineage.defect_class !== null ? ` [defect_class=${lineage.defect_class}]` : "";
    return {
      exitCode: 1,
      parentLineage: lineage,
      message: buildReject(
        path,
        `${lineage.message}${defect}\n  ${formatParentLineageLine(lineage)}`,
      ),
    };
  }

  // #3363: fail closed when the live GitHub origin is newer than the brief.
  const originFreshness = evaluateOriginFreshness(record, {
    skip: options.skipOriginFreshness === true,
    fetchOriginUpdatedAt: options.fetchOriginUpdatedAt,
    cwd: options.projectRoot,
  });
  if (!originFreshness.ok) {
    return {
      exitCode: 1,
      parentLineage: lineage,
      message: buildReject(path, originFreshness.message),
    };
  }

  // #3425: fail closed when an applicable project invariant has no disposition.
  const invariants = evaluateProjectInvariantsGate(record, {
    projectRoot: resolveProjectRootForInvariants(path, options.projectRoot),
    skip: options.skipProjectInvariants === true,
  });
  if (!invariants.ok) {
    return {
      exitCode: 1,
      parentLineage: lineage,
      message: buildReject(path, invariants.message),
    };
  }

  // #3424: declared files vs review-trigger SoT. Missing field is grandfathered
  // (warning). Inspect anomalies fail closed. Size alone is not a hard cap (#1488).
  let placementWarning: string | undefined;
  if (options.skipIntendedPlacement !== true) {
    const projectRoot = resolveProjectRootFromBrief(path, options.projectRoot);
    const placement = evaluateIntendedPlacement(planRecord, { projectRoot });
    if (!placement.ok) {
      return {
        exitCode: 1,
        parentLineage: lineage,
        message: buildReject(path, placement.message),
      };
    }
    if (placement.warning === true) {
      placementWarning = placement.message;
    }
  }

  // Keep the historical OK line when lineage is N/A (backward-compatible tests / agents).
  let message = lineage.applicable
    ? `OK ${path} -- ready for implementation. parent lineage OK ` +
      `(${lineage.parent_requirement_ids.length} req IDs` +
      (lineage.negative_invariant_ids.length > 0
        ? `, ${lineage.negative_invariant_ids.length} negative invariants`
        : "") +
      `).`
    : `OK ${path} -- ready for implementation.`;
  if (placementWarning !== undefined) {
    message = `${message} ${placementWarning}`;
  }

  return {
    exitCode: 0,
    parentLineage: lineage,
    message,
  };
}

export {
  evaluateParentLineage,
  formatParentLineageLine,
  type ParentLineageResult,
} from "../scope/parent-lineage.js";

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
