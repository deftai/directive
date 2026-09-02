/**
 * Runtime writer paths that land in a consumer working tree (#3612 / #4116).
 *
 * Two classes, lockstepped with runtime-writer-paths.json (Go reads that file):
 * - local-cache MUST be covered by both ignore baselines
 * - tracked-provenance MUST NOT be covered (records stay stageable with plain git add)
 *
 * Glob-only sidecar rules do not satisfy registry coverage because
 * ignoreSetCoversPath does not expand globs. New writers join this registry;
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

/** Local-only writer roots. Both ignore baselines MUST cover every entry. */
export const RUNTIME_WRITER_PATHS_LOCAL_CACHE: readonly string[] = Object.freeze([
  AC_PASS_BANK_DIR,
  VERIFY_AC_SESSION_CACHE_DIR,
  SESSION_COMPLETED_MARKER_REL.join("/"),
  AUTHZ_DIR,
  DELIVERY_ATTEMPT_DIR,
  PROJECT_LOCAL_METRICS_DIR,
  ESCALATION_DIR,
  DEFAULT_TASK_CACHE_ROOT,
]);

/**
 * Tracked provenance writer roots. Both ignore baselines MUST NOT cover these
 * as a directory; record kinds stay stageable without git add -f.
 */
export const RUNTIME_WRITER_PATHS_TRACKED_PROVENANCE: readonly string[] = Object.freeze([
  APPROVED_SCOPE_DIR,
]);

/**
 * Union of both classes (local-cache first). Order is the lockstep contract
 * with runtime-writer-paths.json.
 */
export const RUNTIME_WRITER_PATHS: readonly string[] = Object.freeze([
  ...RUNTIME_WRITER_PATHS_LOCAL_CACHE,
  ...RUNTIME_WRITER_PATHS_TRACKED_PROVENANCE,
]);
