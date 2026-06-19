import { createScopeVbrief } from "./build.js";
import {
  DEFAULT_STATUS_FOR_FOLDER,
  FOLDER_TO_STATUSES,
  MIGRATOR_METADATA_KEY,
  STATUS_TO_FOLDER,
} from "./constants.js";
import type { JsonObject } from "./types.js";

export {
  DEFAULT_STATUS_FOR_FOLDER,
  FOLDER_TO_STATUSES,
  LIFECYCLE_FOLDERS,
  STATUS_TO_FOLDER,
} from "./constants.js";

/** Return an ISO-8601 UTC timestamp for ``vBRIEFInfo.updated`` stamps. */
export function migrationTimestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Return the canonical lifecycle folder for a schema status. */
export function folderForStatus(status: string): string {
  const folder = STATUS_TO_FOLDER[status];
  if (folder === undefined) {
    throw new Error(
      `No lifecycle folder defined for status '${status}'; expected one of ${JSON.stringify(Object.keys(STATUS_TO_FOLDER).sort())}.`,
    );
  }
  return folder;
}

/** Return the canonical default status the migrator uses for a folder. */
export function defaultStatusForFolder(folder: string): string {
  const status = DEFAULT_STATUS_FOR_FOLDER[folder];
  if (status === undefined) {
    throw new Error(
      `Unknown lifecycle folder '${folder}'; expected one of ${JSON.stringify(Object.keys(DEFAULT_STATUS_FOR_FOLDER).sort())}.`,
    );
  }
  return status;
}

/** Return true if ``status`` is permitted inside ``folder/`` per #506. */
export function planStatusMatchesFolder(status: string, folder: string): boolean {
  const statuses = FOLDER_TO_STATUSES[folder];
  if (statuses === undefined) {
    return false;
  }
  return statuses.includes(status);
}

function narrativeStr(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value.trim();
  }
  return String(value).trim();
}

/** Build a scope vBRIEF dict from a reconciled item (#496 + #499 + #616). */
export function buildScopeVbriefFromReconciled(
  reconciled: JsonObject,
  repoUrl = "",
  migrationTimestampOverride: string | null = null,
): JsonObject {
  const folder = String(reconciled.folder ?? "pending");
  const status = String(reconciled.status ?? defaultStatusForFolder(folder));

  const seedItem: JsonObject = {
    number: reconciled.number ?? "",
    title: reconciled.title ?? "Untitled",
    phase: reconciled.phase ?? "",
    tier: reconciled.tier ?? "",
  };
  const scope = createScopeVbrief(
    seedItem,
    repoUrl,
    status,
    String(reconciled.phase_description ?? ""),
  );

  const plan = scope.plan as JsonObject;
  const planMeta = (plan.metadata ?? {}) as JsonObject;
  const migratorMeta = (planMeta[MIGRATOR_METADATA_KEY] ?? {}) as JsonObject;

  const store = (key: string, value: unknown): void => {
    const coerced = narrativeStr(value);
    if (coerced) {
      migratorMeta[key] = coerced;
    }
  };

  store("Description", reconciled.description);
  store("Description_source", reconciled.description_source);
  store("Status_source", reconciled.status_source);
  store("Title_source", reconciled.title_source);
  store("SpecPhase", reconciled.spec_phase);
  store("RoadmapSummary", reconciled.roadmap_summary);
  store("SourceConflict", reconciled.source_conflict);

  const sourceSection = narrativeStr(reconciled.source_section);
  if (sourceSection) {
    const narratives = (plan.narratives ?? {}) as JsonObject;
    narratives.SourceSection = sourceSection;
    plan.narratives = narratives;
  }

  if (Object.keys(migratorMeta).length > 0) {
    planMeta[MIGRATOR_METADATA_KEY] = migratorMeta;
    plan.metadata = planMeta;
  } else {
    delete planMeta[MIGRATOR_METADATA_KEY];
    if (Object.keys(planMeta).length > 0) {
      plan.metadata = planMeta;
    } else {
      delete plan.metadata;
    }
  }

  if (reconciled.status === "completed") {
    const envelope = (scope.vBRIEFInfo ?? {}) as JsonObject;
    if (typeof envelope === "object" && envelope !== null && !Array.isArray(envelope)) {
      if (envelope.updated === undefined) {
        envelope.updated = migrationTimestampOverride ?? migrationTimestamp();
      }
      scope.vBRIEFInfo = envelope;
    }
  }

  const extraRefs = reconciled.references;
  if (Array.isArray(extraRefs) && extraRefs.length > 0) {
    const existing = ((plan.references ?? []) as JsonObject[]).slice();
    for (const ref of extraRefs) {
      if (typeof ref === "object" && ref !== null && !Array.isArray(ref)) {
        if (!existing.some((r) => JSON.stringify(r) === JSON.stringify(ref))) {
          existing.push(ref as JsonObject);
        }
      }
    }
    plan.references = existing;
  }

  return scope;
}
