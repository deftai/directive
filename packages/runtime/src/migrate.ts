/**
 * Contract 1 migrate entry (Wave 2b / R7).
 * YOLO: bumps a committed schema marker; full xbrief inventory is follow-up.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ContainedWriteError,
  containedWrite,
} from "@deftai/directive-core/dist/fs/contained-write.js";

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
  readonly created: string[];
  readonly modified: string[];
  readonly removed: string[];
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

/**
 * Migrate supported project data schemas for the pinned runtime.
 * Writes/updates {@link DATA_SCHEMA_MARKER_REL}; retries are idempotent.
 */
export function runMigrate(options: {
  readonly from: string;
  readonly root: string;
}): MigrateResult {
  const { from, root } = options;
  const created: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  const migrated: string[] = [];

  try {
    const prior = readMarkerVersion(root);
    if (prior === CURRENT_DATA_SCHEMA_VERSION) {
      return {
        contract: 1,
        entry: "migrate",
        stub: false,
        from,
        root,
        migrated,
        created,
        modified,
        removed,
        message: `migrate: data schema already at ${CURRENT_DATA_SCHEMA_VERSION}`,
      };
    }

    const body = `${JSON.stringify({ schemaVersion: CURRENT_DATA_SCHEMA_VERSION }, null, 2)}\n`;
    const existed = prior !== null && prior !== "invalid";
    containedWrite({
      root,
      target: DATA_SCHEMA_MARKER_REL,
      data: body,
      mode: "replace",
      mkdir: true,
    });
    if (!existed) created.push(DATA_SCHEMA_MARKER_REL);
    else modified.push(DATA_SCHEMA_MARKER_REL);
    migrated.push(DATA_SCHEMA_MARKER_REL);

    return {
      contract: 1,
      entry: "migrate",
      stub: false,
      from,
      root,
      migrated,
      created,
      modified,
      removed,
      message: `migrate completed to schema ${CURRENT_DATA_SCHEMA_VERSION}`,
    };
  } catch (err) {
    const msg =
      err instanceof ContainedWriteError
        ? `migrate write refused: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    return {
      contract: 1,
      entry: "migrate",
      stub: false,
      from,
      root,
      migrated,
      created,
      modified,
      removed,
      message: `migrate failed: ${msg}`,
    };
  }
}
