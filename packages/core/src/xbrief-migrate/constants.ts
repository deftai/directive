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

export const LEGACY_ARTIFACT_SUFFIX = ".vbrief.json" as const;
export const MIGRATED_ARTIFACT_SUFFIX = ".xbrief.json" as const;

export const LEGACY_INFO_ROOT_KEY = "vBRIEFInfo" as const;
export const MIGRATED_INFO_ROOT_KEY = "xBRIEFInfo" as const;

/** Item-only status value added in xBRIEF v0.8. */
export const V08_ITEM_STATUS_AUTO = "auto" as const;
