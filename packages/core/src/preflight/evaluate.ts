import { readFileSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { evaluateObservableMintPreflight } from "../observable-scope/mint.js";
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

/**
 * Recovery for the origin-freshness reject (#3828).
 *
 * Freshness is only reached after the active/ + running checks pass, so
 * `ACTIVATE_HINT` names a transition that cannot apply here: `activate` accepts
 * `pending/` alone and fails with `Invalid transition: 'activate' requires file
 * in pending/`. `block` -> `unblock` is in place (`targetFolder: null`), requires
 * and restores `running`, and stamps `plan.updated` plus `xBRIEFInfo.updated`,
 * the field this reject compares. It is interim: the pair also records a
 * `blocked` -> `running` transition for a brief that was never blocked, a
 * tradeoff accepted knowingly. #3857 owns the dedicated acknowledge verb.
 */
export const ORIGIN_FRESHNESS_HINT =
  "Recovery: this xBRIEF is already in active/ at status running. " +
  "Once you have re-read the origin delta, stamp xBRIEFInfo.updated in place with " +
  "`task scope:block -- {path}` then `task scope:unblock -- {path}`. " +
  "That pair is interim: it records a blocked -> running transition for a brief " +
  "that was never blocked, and #3857 owns the verb that records the " +
  "acknowledgement honestly. If the origin could not be fetched or compared, " +
  "restore `gh` REST access to the origin repository first -- a stamp does not " +
  "clear that.";

/** Lifecycle folder names eligible for implementation (#810). */
export const ELIGIBLE_LIFECYCLE_DIRS = ["xbrief/active", "vbrief/active"] as const;

export const PREFLIGHT_USAGE_HINT =
  "Expected: `task xbrief:preflight -- xbrief/active/<story>.xbrief.json` (legacy: `task vbrief:preflight -- <path>`).";

/** Preflight is never an authz allow. First-write remainder is #4709. */
export const PREFLIGHT_AUTHORIZATION_REMAINDER = "#4709" as const;

export interface PreflightAuthorizationResult {
  readonly allow: false;
  readonly remainder: typeof PREFLIGHT_AUTHORIZATION_REMAINDER;
  readonly reason: string;
}

export const PREFLIGHT_NOT_AUTHORIZATION: PreflightAuthorizationResult = {
  allow: false,
  remainder: PREFLIGHT_AUTHORIZATION_REMAINDER,
  reason:
    "xbrief:preflight exit 0 is lifecycle-ready (active/ plus running plus structural checks). It is not implementation authorization. Ordinary-session first-write remainder is #4709.",
};

/** Result of a vBRIEF preflight evaluation; mirrors the Python `evaluate` tuple. */
export interface EvaluateResult {
  readonly exitCode: 0 | 1;
  readonly message: string;
  /** #3241 parent-lineage probe when structural checks passed far enough to load the payload. */
  readonly parentLineage?: ParentLineageResult;
  /** Separate from lifecycle-ready / exit 0. Never an authz allow (#4690). */
  readonly authorization: PreflightAuthorizationResult;
}

function outcome(
  exitCode: 0 | 1,
  message: string,
  extra?: { parentLineage?: ParentLineageResult },
): EvaluateResult {
  if (extra?.parentLineage !== undefined) {
    return {
      exitCode,
      message,
      parentLineage: extra.parentLineage,
      authorization: PREFLIGHT_NOT_AUTHORIZATION,
    };
  }
  return { exitCode, message, authorization: PREFLIGHT_NOT_AUTHORIZATION };
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

/** Substitute every `{path}` without `$`-pattern expansion in user paths (#1721). */
export function formatOriginFreshnessHint(path: string): string {
  return ORIGIN_FRESHNESS_HINT.split("{path}").join(path);
}

function buildReject(path: string, reason: string, hint?: string): string {
  return `${reason}\n  ${PREFLIGHT_USAGE_HINT}\n  ${hint ?? formatActivateHint(path)}`;
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
      return outcome(1, buildReject(path, `vBRIEF not found at ${path}.`));
    }
    return outcome(1, buildReject(path, `Could not read vBRIEF at ${path}: ${String(e.message)}.`));
  }

  if (!st.isFile()) {
    return outcome(1, buildReject(path, `vBRIEF path ${path} is not a regular file.`));
  }

  let raw: string;
  try {
    raw = readFileSync(vbriefPath, "utf8");
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    return outcome(1, buildReject(path, `Could not read vBRIEF at ${path}: ${String(e.message)}.`));
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch (err: unknown) {
    const e = err as SyntaxError;
    const lineCol = /\(line (\d+) column \d+\)/.exec(e.message);
    const line = lineCol ? Number(lineCol[1]) : 1;
    const pyMsg = nodeJsonErrorToPythonMsg(e.message);
    return outcome(
      1,
      buildReject(path, `vBRIEF at ${path} is not valid JSON: ${pyMsg} (line ${line}).`),
    );
  }

  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return outcome(1, buildReject(path, `vBRIEF at ${path} top-level value is not a JSON object.`));
  }

  const folder = basename(dirname(vbriefPath));
  const parent = basename(dirname(dirname(vbriefPath)));
  const lifecycleDir = `${parent}/${folder}`;
  if (folder !== ACTIVE_FOLDER) {
    return outcome(
      1,
      buildReject(
        path,
        `xBRIEF is in ${lifecycleDir}/ -- only xbrief/active/ (or legacy vbrief/active/) is eligible for implementation.`,
      ),
    );
  }

  const record = payload as Record<string, unknown>;
  const plan = record.plan;
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) {
    return outcome(1, buildReject(path, `vBRIEF at ${path} lacks a \`plan\` object -- malformed.`));
  }

  const planRecord = plan as Record<string, unknown>;
  const status = planRecord.status;
  if (typeof status !== "string" || status.length === 0) {
    return outcome(1, buildReject(path, `vBRIEF at ${path} lacks \`plan.status\` -- malformed.`));
  }

  if (status !== ELIGIBLE_STATUS) {
    return outcome(
      1,
      buildReject(
        path,
        `plan.status is '${status}' -- only '${ELIGIBLE_STATUS}' is eligible for implementation.`,
      ),
    );
  }

  // Slash-command intent containment (#1193 / extends #810): non-implement session
  // verbs must not authorize implementation preflight even when the xBRIEF is active.
  const intent = evaluateIntentCeilingFromEnv("implement");
  if (!intent.allowed) {
    return outcome(1, buildReject(path, intent.reason));
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
    return outcome(
      1,
      buildReject(path, `${lineage.message}${defect}\n  ${formatParentLineageLine(lineage)}`),
      { parentLineage: lineage },
    );
  }

  // #3363: fail closed when the live GitHub origin is newer than the brief.
  const originFreshness = evaluateOriginFreshness(record, {
    skip: options.skipOriginFreshness === true,
    fetchOriginUpdatedAt: options.fetchOriginUpdatedAt,
    cwd: options.projectRoot,
  });
  if (!originFreshness.ok) {
    // #3828: the brief is active + running by this point, so the activate
    // hint would name a transition that hard-errors from the printed state.
    return outcome(1, buildReject(path, originFreshness.message, formatOriginFreshnessHint(path)), {
      parentLineage: lineage,
    });
  }

  // #3425: fail closed when an applicable project invariant has no disposition.
  const invariants = evaluateProjectInvariantsGate(record, {
    projectRoot: resolveProjectRootForInvariants(path, options.projectRoot),
    skip: options.skipProjectInvariants === true,
  });
  if (!invariants.ok) {
    return outcome(1, buildReject(path, invariants.message), { parentLineage: lineage });
  }

  // #3424: declared files vs review-trigger SoT. Missing field is grandfathered
  // (warning). Inspect anomalies fail closed. Size alone is not a hard cap (#1488).
  let placementWarning: string | undefined;
  if (options.skipIntendedPlacement !== true) {
    const projectRoot = resolveProjectRootFromBrief(path, options.projectRoot);
    const placement = evaluateIntendedPlacement(planRecord, { projectRoot });
    if (!placement.ok) {
      return outcome(1, buildReject(path, placement.message), { parentLineage: lineage });
    }
    if (placement.warning === true) {
      placementWarning = placement.message;
    }
    const mint = evaluateObservableMintPreflight(
      payload,
      resolveProjectRootFromBrief(path, options.projectRoot),
    );
    if (!mint.ok) {
      return outcome(1, buildReject(path, mint.message), { parentLineage: lineage });
    }
  }

  // Lifecycle-ready OK line. Not implementation authorization (#4690).
  let message = lineage.applicable
    ? `OK ${path} -- lifecycle-ready. parent lineage OK ` +
      `(${lineage.parent_requirement_ids.length} req IDs` +
      (lineage.negative_invariant_ids.length > 0
        ? `, ${lineage.negative_invariant_ids.length} negative invariants`
        : "") +
      `).`
    : `OK ${path} -- lifecycle-ready.`;
  if (placementWarning !== undefined) {
    message = `${message} ${placementWarning}`;
  }

  return outcome(0, message, { parentLineage: lineage });
}

export {
  evaluateParentLineage,
  formatParentLineageLine,
  type ParentLineageResult,
} from "../scope/parent-lineage.js";

/** Structured `--json` payload (sorted keys), mirroring Python `_emit_json`. */
export function emitJson(vbriefPath: string, exitCode: number, message: string): string {
  const payload: Record<string, unknown> = {
    ready: exitCode === 0,
    exit_code: exitCode,
    vbrief_path: vbriefPath,
    message,
    authorization: PREFLIGHT_NOT_AUTHORIZATION,
  };
  // Sort top-level keys only. An array replacer would strip nested
  // authorization.allow / remainder / reason (#4690).
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(payload).sort()) {
    sorted[key] = payload[key];
  }
  return JSON.stringify(sorted);
}
