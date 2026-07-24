import {
  LEGACY_VBRIEF_VERSION,
  VBRIEF_REFERENCE_PREFIX,
  VBRIEF_VERSION,
  XBRIEF_REFERENCE_PREFIX,
} from "@deftai/directive-types";
import { VALID_PLAN_ITEM_TYPES } from "../vbrief-validate/constants.js";

export { LEGACY_VBRIEF_VERSION, VBRIEF_REFERENCE_PREFIX, VBRIEF_VERSION, XBRIEF_REFERENCE_PREFIX };

/** PlanItem container `type` values introduced in xBRIEF v0.8 (excludes `task`). */
export const V08_CONTAINER_ITEM_TYPES = new Set(
  [...VALID_PLAN_ITEM_TYPES].filter((t) => t !== "task"),
);

export const LEGACY_ARTIFACT_DIR = "vbrief" as const;
export const MIGRATED_ARTIFACT_DIR = "xbrief" as const;

/**
 * Obsolete framework support narrative at the lifecycle root. Legacy
 * `migrate:xbrief` copied this to `xbrief/vbrief.md` with broken framework
 * links; consumer projections use `xbrief.md` instead (#2806).
 */
export const OBSOLETE_FRAMEWORK_NARRATIVE_FILENAME = "vbrief.md" as const;

export const LEGACY_ARTIFACT_SUFFIX = ".vbrief.json" as const;
export const MIGRATED_ARTIFACT_SUFFIX = ".xbrief.json" as const;

export const LEGACY_INFO_ROOT_KEY = "vBRIEFInfo" as const;
export const MIGRATED_INFO_ROOT_KEY = "xBRIEFInfo" as const;

/** Item-only status value added in xBRIEF v0.8. */
export const V08_ITEM_STATUS_AUTO = "auto" as const;

/**
 * Filename of the explicit deprecation marker written into a legacy `vbrief/`
 * root that is retained for read-compatibility after convergence (#2270). Its
 * presence is what tells `doctor` the folder is NOT an active source of truth.
 */
export const VBRIEF_DEPRECATION_MARKER_FILENAME = "DEPRECATED.md" as const;

/** Sentinel line identifying a deft-written `vbrief/` deprecation marker (#2270). */
export const VBRIEF_DEPRECATION_MARKER_SENTINEL = "<!-- deft:vbrief-deprecated -->" as const;

/** Body written into the retained legacy `vbrief/` deprecation marker (#2270). */
export const VBRIEF_DEPRECATION_MARKER_BODY = `${VBRIEF_DEPRECATION_MARKER_SENTINEL}
# Deprecated: legacy \`vbrief/\` root

This project has migrated to the \`xbrief/\` lifecycle layout. This \`vbrief/\`
directory is retained only for read-compatibility and is **not** an active
source of truth. Do not add new scope work here — use \`xbrief/\` instead.

Once you no longer need read-compatibility with the legacy layout, delete this
\`vbrief/\` directory. Re-running \`deft migrate:xbrief\` re-checks convergence.
` as const;
