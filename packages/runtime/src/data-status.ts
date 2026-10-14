/**
 * Read-only equal-version data-status diagnostic (AC4.10 / Contract 1 / F-017).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CURRENT_DATA_SCHEMA_VERSION,
  DATA_SCHEMA_MARKER_REL,
  projectNeedsXbriefMigration,
} from "./migrate.js";

export type DataStatusValue = "current" | "migration_needed" | "diagnosis_failed";

export interface DataStatusResult {
  readonly contract: 1;
  readonly dataStatus: DataStatusValue;
}

/**
 * Inspect project data schema currency without mutating anything.
 * Marker behind/missing OR unmigrated vbrief/residual envelopes → migration_needed.
 */
export function readProjectDataStatus(projectRoot: string): DataStatusResult {
  const abs = join(projectRoot, DATA_SCHEMA_MARKER_REL);
  if (!existsSync(abs)) {
    return { contract: 1, dataStatus: "migration_needed" };
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(abs, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { contract: 1, dataStatus: "diagnosis_failed" };
    }
    const ver = (parsed as { schemaVersion?: unknown }).schemaVersion;
    if (typeof ver !== "number" || !Number.isInteger(ver) || ver < 0) {
      return { contract: 1, dataStatus: "diagnosis_failed" };
    }
    if (ver < CURRENT_DATA_SCHEMA_VERSION) {
      return { contract: 1, dataStatus: "migration_needed" };
    }
    if (ver > CURRENT_DATA_SCHEMA_VERSION) {
      return { contract: 1, dataStatus: "diagnosis_failed" };
    }
    if (projectNeedsXbriefMigration(projectRoot)) {
      return { contract: 1, dataStatus: "migration_needed" };
    }
    return { contract: 1, dataStatus: "current" };
  } catch {
    return { contract: 1, dataStatus: "diagnosis_failed" };
  }
}
