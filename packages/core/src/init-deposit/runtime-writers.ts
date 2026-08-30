/**
 * Runtime writer paths that land in a consumer working tree (#3612).
 *
 * The ignore baselines and this list are coupled: every exported writer path
 * constant MUST appear here, and a fail-closed test asserts the ignore set
 * covers each entry on both shipped surfaces. New writers join this registry;
 * they do not get a silent extra .deft/ name.
 */

import { AUTHZ_DIR } from "../authz/types.js";
import { DEFAULT_TASK_CACHE_ROOT } from "../cache/task-cache/constants.js";
import { SESSION_COMPLETED_MARKER_REL } from "../check/session-completed-ac.js";
import { DELIVERY_ATTEMPT_DIR } from "../delivery-attempt/types.js";
import { ESCALATION_DIR } from "../escalation/types.js";
import { PROJECT_LOCAL_METRICS_DIR } from "../metrics/resolve-metrics-home.js";
import { APPROVED_SCOPE_DIR } from "../scope-provenance/digest.js";
import { AC_PASS_BANK_DIR } from "../session/ac-pass-banking.js";
import { VERIFY_AC_SESSION_CACHE_DIR } from "../session/verify-ac-session-cache.js";

/** Deliberate miss used to prove ignoreSetCoversPath is not vacuous. */
export const UNCOVERED_WRITER_PROBE_PATH = ".deft/uncovered-writer-probe";

/**
 * Imported writer path constants. Order is the lockstep contract with
 * runtime-writer-paths.json (Go reads that file).
 */
export const RUNTIME_WRITER_PATHS: readonly string[] = Object.freeze([
  AC_PASS_BANK_DIR,
  VERIFY_AC_SESSION_CACHE_DIR,
  SESSION_COMPLETED_MARKER_REL.join("/"),
  AUTHZ_DIR,
  DELIVERY_ATTEMPT_DIR,
  PROJECT_LOCAL_METRICS_DIR,
  ESCALATION_DIR,
  APPROVED_SCOPE_DIR,
  DEFAULT_TASK_CACHE_ROOT,
]);
