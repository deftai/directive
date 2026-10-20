/**
 * Contract 1 migrate entry (Wave 2b / R7 / F-017).
 * Bumps the committed schema marker and runs supported vbrief→xbrief migration.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ContainedWriteError,
  containedWrite,
} from "@deftai/directive-core/dist/fs/contained-write.js";
import {
  detectLegacyVbriefLayout,
  detectXbriefConvergence,
  runXbriefMigration,
  type XbriefMigrationOutcome,
} from "@deftai/directive-core/xbrief-migrate";

export const DATA_SCHEMA_MARKER_REL = ".deft/directive/data-schema.json";
/** YOLO initial supported schema version recorded by migrate. */
export const CURRENT_DATA_SCHEMA_VERSION = 1;

export interface MigrateResult {
  readonly contract: 1;
  readonly entry: "migrate";
  readonly stub: false;
  readonly from: string;
  readonly root: string;
  readonly migrated: string[];
  readonly archived: string[];
  readonly created: string[];
  readonly modified: string[];
  readonly removed: string[];
  /** Failed paths when migrate stops after partial progress (AC14.18). */
  readonly conflicts: readonly string[];
  readonly message: string;
}

function readMarkerVersion(projectRoot: string): number | null | "invalid" {
  const abs = join(projectRoot, DATA_SCHEMA_MARKER_REL);
  if (!existsSync(abs)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(abs, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "invalid";
    const ver = (parsed as { schemaVersion?: unknown }).schemaVersion;
    if (typeof ver !== "number" || !Number.isInteger(ver) || ver < 0) return "invalid";
    return ver;
  } catch {
    return "invalid";
  }
}

function emptyResult(from: string, root: string, message: string): MigrateResult {
  return {
    contract: 1,
    entry: "migrate",
    stub: false,
    from,
    root,
    migrated: [],
    archived: [],
    created: [],
    modified: [],
    removed: [],
    conflicts: [],
    message,
  };
}

/**
 * True when install-management migrate still has lifecycle work (F-017).
 * Marker currency alone is insufficient — unmigrated vbrief/ must stay behind.
 */
export function projectNeedsXbriefMigration(projectRoot: string): boolean {
  const convergence = detectXbriefConvergence(projectRoot);
  if (
    convergence.state === "legacy-only" ||
    convergence.state === "dual-populated" ||
    convergence.state === "empty-vbrief"
  ) {
    return true;
  }
  // Marked vbrief/ retention is intentional; still migrate residual legacy
  // envelopes under xbrief/ (detectLegacyVbriefLayout would otherwise stay true
  // forever from the mere presence of vbrief/). Reasons embed absolute paths —
  // ignore only files under THIS project's retained vbrief/ tree (not a parent
  // folder that happens to be named vbrief/).
  if (convergence.state === "xbrief-marker") {
    const legacy = detectLegacyVbriefLayout(projectRoot);
    const retainedRoot = resolve(projectRoot, "vbrief").replace(/\\/g, "/");
    const retainedPrefix = retainedRoot.endsWith("/") ? retainedRoot : `${retainedRoot}/`;
    return legacy.reasons.some((reason) => {
      if (reason === "vbrief/ directory present" || reason.startsWith("vbrief/")) {
        return false;
      }
      const normalized = reason.replace(/\\/g, "/");
      const pathMatch = normalized.match(/ in (.+)$/) ?? normalized.match(/filename: (.+)$/);
      if (pathMatch) {
        const filePath = pathMatch[1] ?? "";
        if (filePath === retainedRoot || filePath.startsWith(retainedPrefix)) {
          return false;
        }
      }
      return true;
    });
  }
  return detectLegacyVbriefLayout(projectRoot).legacyLayout;
}

function applyXbriefMigration(root: string):
  | {
      ok: true;
      migrated: string[];
      archived: string[];
      message: string;
    }
  | {
      ok: false;
      message: string;
    } {
  if (!projectNeedsXbriefMigration(root)) {
    return { ok: true, migrated: [], archived: [], message: "xbrief lifecycle already current" };
  }

  // Upgrade already approved the operation; skip interactive git-clean refuse.
  const outcome: XbriefMigrationOutcome = runXbriefMigration(
    { projectRoot: root, force: true },
    {
      writeOut: () => {},
      writeErr: () => {},
    },
  );

  switch (outcome.kind) {
    case "migrated":
      return {
        ok: true,
        migrated: [...outcome.migratedPaths],
        archived: [...outcome.archivedPaths],
        message:
          `xbrief migrate: ${outcome.migratedPaths.length} migrated` +
          (outcome.archivedPaths.length > 0 ? `, ${outcome.archivedPaths.length} archived` : ""),
      };
    case "rewritten":
      return {
        ok: true,
        migrated: [`xbrief/ (rewrote ${outcome.files} residual envelope(s))`],
        archived: [],
        message: outcome.message,
      };
    case "converged":
      return {
        ok: true,
        migrated: outcome.already ? [] : [`vbrief/ (${outcome.action})`],
        archived: [],
        message: outcome.message,
      };
    case "noop":
      return { ok: true, migrated: [], archived: [], message: outcome.message };
    case "refused":
    case "config":
      return { ok: false, message: `xbrief migrate failed: ${outcome.message}` };
    default: {
      const _exhaustive: never = outcome;
      return { ok: false, message: `xbrief migrate failed: ${String(_exhaustive)}` };
    }
  }
}

/**
 * Migrate supported project data schemas for the pinned runtime.
 * Writes/updates {@link DATA_SCHEMA_MARKER_REL} and runs vbrief→xbrief migration.
 */
export function runMigrate(options: {
  readonly from: string;
  readonly root: string;
  /** Test seam for ContainedWrite failure injection (AC14.18). */
  readonly write?: typeof containedWrite;
}): MigrateResult {
  const { from, root } = options;
  const write = options.write ?? containedWrite;
  const created: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  const migrated: string[] = [];
  const archived: string[] = [];
  /** True only while the schema-marker write is in flight (Greptile: do not blame marker for earlier failures). */
  let markerWritePending = false;

  try {
    const prior = readMarkerVersion(root);
    // Refuse to erase unreadable or newer markers so the original state remains for recovery.
    if (prior === "invalid") {
      return emptyResult(
        from,
        root,
        `migrate failed: unreadable schema marker at ${DATA_SCHEMA_MARKER_REL}; refusing overwrite`,
      );
    }
    if (typeof prior === "number" && prior > CURRENT_DATA_SCHEMA_VERSION) {
      return emptyResult(
        from,
        root,
        `migrate failed: schema marker is newer (${prior} > ${CURRENT_DATA_SCHEMA_VERSION}); refusing overwrite`,
      );
    }

    const xbrief = applyXbriefMigration(root);
    if (!xbrief.ok) {
      return emptyResult(from, root, `migrate failed: ${xbrief.message}`);
    }
    migrated.push(...xbrief.migrated);
    archived.push(...xbrief.archived);

    const markerCurrent = prior === CURRENT_DATA_SCHEMA_VERSION;
    if (!markerCurrent) {
      const body = `${JSON.stringify({ schemaVersion: CURRENT_DATA_SCHEMA_VERSION }, null, 2)}\n`;
      const existed = prior !== null;
      markerWritePending = true;
      write({
        root,
        target: DATA_SCHEMA_MARKER_REL,
        data: body,
        mode: "replace",
        mkdir: true,
      });
      markerWritePending = false;
      if (!existed) created.push(DATA_SCHEMA_MARKER_REL);
      else modified.push(DATA_SCHEMA_MARKER_REL);
      migrated.push(DATA_SCHEMA_MARKER_REL);
    }

    const parts = [xbrief.message];
    if (!markerCurrent) {
      parts.push(`schema marker → ${CURRENT_DATA_SCHEMA_VERSION}`);
    } else if (migrated.length === 0 && archived.length === 0) {
      return {
        contract: 1,
        entry: "migrate",
        stub: false,
        from,
        root,
        migrated,
        archived,
        created,
        modified,
        removed,
        conflicts: [],
        message: `migrate: data schema already at ${CURRENT_DATA_SCHEMA_VERSION}`,
      };
    }

    return {
      contract: 1,
      entry: "migrate",
      stub: false,
      from,
      root,
      migrated,
      archived,
      created,
      modified,
      removed,
      conflicts: [],
      message: `migrate completed: ${parts.filter(Boolean).join("; ")}`,
    };
  } catch (err) {
    const msg =
      err instanceof ContainedWriteError
        ? `migrate write refused: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    // AC14.18: keep paths already migrated; name only the step that failed.
    const conflictTarget =
      err instanceof ContainedWriteError
        ? err.target
        : markerWritePending
          ? DATA_SCHEMA_MARKER_REL
          : null;
    return {
      contract: 1,
      entry: "migrate",
      stub: false,
      from,
      root,
      migrated,
      archived,
      created,
      modified,
      removed,
      conflicts: conflictTarget === null ? [] : [conflictTarget],
      message: `migrate failed: ${msg}`,
    };
  }
}
