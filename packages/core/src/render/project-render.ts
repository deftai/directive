import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EMITTED_VBRIEF_VERSION } from "../vbrief-build/constants.js";
import {
  deriveRegistryItemStatus,
  registryMetadataReferencesFromScope,
} from "../vbrief-validate/registry-status.js";
import { PROJECT_LIFECYCLE_FOLDERS, SKELETON_NARRATIVES } from "./constants.js";
import { splitCamel, splitWords } from "./text-utils.js";

type JsonObject = Record<string, unknown>;

/** Durable review state for PROJECT-DEFINITION narrative staleness (#640). */
export interface StalenessReviewMetadata {
  /** ISO-8601 UTC when narratives were last reviewed/acknowledged. */
  acknowledged_at: string;
  /** Completed scope IDs incorporated at acknowledgement time (watermark). */
  acknowledged_completed_scope_ids: readonly string[];
}

export interface LifecycleItem {
  id: string;
  title: string;
  status: string;
  metadata: Record<string, unknown>;
}

export function scanLifecycleFolders(vbriefDir: string): LifecycleItem[] {
  const items: LifecycleItem[] = [];
  for (const folderName of PROJECT_LIFECYCLE_FOLDERS) {
    const folder = join(vbriefDir, folderName);
    if (!existsSync(folder)) continue;
    let files: string[];
    try {
      files = readdirSync(folder)
        .filter((n) => n.endsWith(".vbrief.json"))
        .sort();
    } catch {
      continue;
    }
    for (const vbriefFile of files) {
      const full = join(folder, vbriefFile);
      try {
        const data = JSON.parse(readFileSync(full, "utf8")) as JsonObject;
        const plan = (data.plan ?? {}) as JsonObject;
        const title = String(plan.title ?? vbriefFile.replace(/\.vbrief\.json$/, ""));
        const status = deriveRegistryItemStatus(plan.status, folderName);
        const references = registryMetadataReferencesFromScope(plan.references);
        const item: LifecycleItem = {
          id: vbriefFile.replace(/\.vbrief\.json$/, "").replace(/\.vbrief$/, ""),
          title,
          status,
          metadata: {
            source_path: `${folderName}/${vbriefFile}`,
            lifecycle_folder: folderName,
          },
        };
        if (references.length > 0) {
          item.metadata.references = references;
        }
        items.push(item);
      } catch {
        items.push({
          id: vbriefFile.replace(/\.vbrief\.json$/, "").replace(/\.vbrief$/, ""),
          title: `[unreadable] ${vbriefFile}`,
          status: "draft",
          metadata: {
            source_path: `${folderName}/${vbriefFile}`,
            lifecycle_folder: folderName,
            error: "Failed to read or parse file",
          },
        });
      }
    }
  }
  return items;
}

export function flagStaleNarratives(
  narratives: Record<string, string>,
  completedItems: LifecycleItem[],
): string[] {
  if (completedItems.length === 0 || Object.keys(narratives).length === 0) {
    if (completedItems.length >= 3) {
      return [
        `${completedItems.length} scopes completed since last narrative update -- review recommended`,
      ];
    }
    return [];
  }

  const flags: string[] = [];
  const flaggedNarratives = new Set<string>();

  for (const narrativeKey of Object.keys(narratives).sort()) {
    const keyWords = new Set(splitCamel(narrativeKey).filter((w) => w.length > 3));
    if (keyWords.size === 0) continue;
    for (const item of completedItems) {
      const titleLower = item.title.toLowerCase();
      const titleWords = new Set(splitWords(titleLower));
      const overlap = [...keyWords].filter((w) => titleWords.has(w));
      if (overlap.length > 0) {
        flags.push(
          `Narrative '${narrativeKey}' may be stale: completed scope '${item.title}' shares topics (${overlap.sort().join(", ")})`,
        );
        flaggedNarratives.add(narrativeKey);
      }
    }
  }

  if (completedItems.length >= 3 && flaggedNarratives.size === 0) {
    flags.push(
      `${completedItems.length} scopes completed since last narrative update -- review recommended`,
    );
  }

  return flags.sort();
}

function isoTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Parse `plan.metadata.staleness_review` when present and well-formed. */
export function parseStalenessReview(metadata: unknown): StalenessReviewMetadata | null {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return null;
  }
  const review = (metadata as JsonObject).staleness_review;
  if (typeof review !== "object" || review === null || Array.isArray(review)) {
    return null;
  }
  const acknowledgedAt = (review as JsonObject).acknowledged_at;
  const scopeIds = (review as JsonObject).acknowledged_completed_scope_ids;
  if (typeof acknowledgedAt !== "string" || acknowledgedAt.length === 0) {
    return null;
  }
  if (!Array.isArray(scopeIds) || !scopeIds.every((id) => typeof id === "string")) {
    return null;
  }
  return {
    acknowledged_at: acknowledgedAt,
    acknowledged_completed_scope_ids: [...scopeIds].sort(),
  };
}

/** Completed scopes not yet covered by the acknowledgement watermark. */
export function unacknowledgedCompletedItems(
  completedItems: readonly LifecycleItem[],
  review: StalenessReviewMetadata | null,
): LifecycleItem[] {
  if (!review) return [...completedItems];
  const acknowledged = new Set(review.acknowledged_completed_scope_ids);
  return completedItems.filter((item) => !acknowledged.has(item.id));
}

/** Build acknowledgement metadata for the current completed-scope set. */
export function buildStalenessAcknowledgement(
  completedItems: readonly LifecycleItem[],
  options: { now?: Date; existing?: StalenessReviewMetadata | null } = {},
): StalenessReviewMetadata {
  const now = isoTimestamp(options.now ?? new Date());
  const mergedIds = new Set([
    ...(options.existing?.acknowledged_completed_scope_ids ?? []),
    ...completedItems.map((item) => item.id),
  ]);
  return {
    acknowledged_at: now,
    acknowledged_completed_scope_ids: [...mergedIds].sort(),
  };
}

export function computeStalenessFlags(
  narratives: Record<string, string>,
  completedItems: readonly LifecycleItem[],
  review: StalenessReviewMetadata | null = null,
): string[] {
  const pending = unacknowledgedCompletedItems(completedItems, review);
  return flagStaleNarratives(narratives, pending);
}

export function createSkeleton(items: LifecycleItem[], now: string): JsonObject {
  const completedItems = items.filter((i) => i.status === "completed");
  const stalenessFlags = computeStalenessFlags({ ...SKELETON_NARRATIVES }, completedItems);
  return {
    vBRIEFInfo: {
      version: EMITTED_VBRIEF_VERSION,
      description: "Project definition -- synthesized gestalt of the project",
      created: now,
      updated: now,
    },
    plan: {
      title: "PROJECT-DEFINITION",
      status: "running",
      narratives: { ...SKELETON_NARRATIVES },
      items,
      metadata: { staleness_flags: stalenessFlags },
    },
  };
}

export interface RenderProjectOptions {
  readonly now?: Date;
}

export type RenderProjectResult = readonly [boolean, string];

/** Regenerate PROJECT-DEFINITION.vbrief.json (mirrors ``scripts/project_render.render_project_definition``). */
export function renderProjectDefinition(
  vbriefDir: string,
  options: RenderProjectOptions = {},
): RenderProjectResult {
  const nowDate = options.now ?? new Date();
  const now = nowDate.toISOString().replace(/\.\d{3}Z$/, "Z");
  const projectDefPath = join(vbriefDir, "PROJECT-DEFINITION.vbrief.json");
  const items = scanLifecycleFolders(vbriefDir);
  const createdNew = !existsSync(projectDefPath);

  let projectDef: JsonObject;
  if (existsSync(projectDefPath)) {
    try {
      projectDef = JSON.parse(readFileSync(projectDefPath, "utf8")) as JsonObject;
    } catch (exc) {
      return [false, `✗ Failed to read ${projectDefPath}: ${String(exc)}`];
    }
    const plan = (projectDef.plan ?? {}) as JsonObject;
    plan.items = items;
    if (typeof projectDef.vBRIEFInfo !== "object" || projectDef.vBRIEFInfo === null) {
      projectDef.vBRIEFInfo = {};
    }
    (projectDef.vBRIEFInfo as JsonObject).updated = now;
    const narratives =
      typeof plan.narratives === "object" &&
      plan.narratives !== null &&
      !Array.isArray(plan.narratives)
        ? (plan.narratives as Record<string, string>)
        : {};
    const completedItems = items.filter((i) => i.status === "completed");
    if (
      typeof plan.metadata !== "object" ||
      plan.metadata === null ||
      Array.isArray(plan.metadata)
    ) {
      plan.metadata = {};
    }
    const planMetadata = plan.metadata as JsonObject;
    const review = parseStalenessReview(planMetadata);
    const flags = computeStalenessFlags(narratives, completedItems, review);
    planMetadata.staleness_flags = flags;
    projectDef.plan = plan;
  } else {
    projectDef = createSkeleton(items, now);
  }

  mkdirSync(vbriefDir, { recursive: true });
  writeFileSync(projectDefPath, `${JSON.stringify(projectDef, null, 2)}\n`, "utf8");

  const itemCount = items.length;
  const planMeta = ((projectDef.plan as JsonObject)?.metadata ?? {}) as JsonObject;
  const flagCount = Array.isArray(planMeta.staleness_flags) ? planMeta.staleness_flags.length : 0;
  const action = createdNew ? "created" : "updated";
  const parts = [`✓ PROJECT-DEFINITION.vbrief.json ${action} (${itemCount} scope items)`];
  if (flagCount > 0) parts.push(`⚠ ${flagCount} staleness flag(s) -- agent review recommended`);
  return [true, parts.join("\n")];
}

/**
 * Mark current completed scopes as reviewed for PROJECT-DEFINITION narratives.
 *
 * Distinct from `task reconcile:issues`, which reconciles origin freshness on scope
 * vBRIEFs — this path only clears narrative staleness heuristics on render.
 */
export function acknowledgeProjectDefinitionStaleness(
  vbriefDir: string,
  options: RenderProjectOptions = {},
): RenderProjectResult {
  const nowDate = options.now ?? new Date();
  const now = isoTimestamp(nowDate);
  const projectDefPath = join(vbriefDir, "PROJECT-DEFINITION.vbrief.json");
  if (!existsSync(projectDefPath)) {
    return [false, `✗ ${projectDefPath} not found — run project:render first`];
  }

  let projectDef: JsonObject;
  try {
    projectDef = JSON.parse(readFileSync(projectDefPath, "utf8")) as JsonObject;
  } catch (exc) {
    return [false, `✗ Failed to read ${projectDefPath}: ${String(exc)}`];
  }

  const plan = (projectDef.plan ?? {}) as JsonObject;
  if (typeof plan.metadata !== "object" || plan.metadata === null || Array.isArray(plan.metadata)) {
    plan.metadata = {};
  }
  const planMetadata = plan.metadata as JsonObject;
  const items = scanLifecycleFolders(vbriefDir);
  const completedItems = items.filter((i) => i.status === "completed");
  const existing = parseStalenessReview(planMetadata);
  planMetadata.staleness_review = buildStalenessAcknowledgement(completedItems, {
    now: nowDate,
    existing,
  });
  const narratives =
    typeof plan.narratives === "object" &&
    plan.narratives !== null &&
    !Array.isArray(plan.narratives)
      ? (plan.narratives as Record<string, string>)
      : {};
  planMetadata.staleness_flags = computeStalenessFlags(
    narratives,
    completedItems,
    parseStalenessReview(planMetadata),
  );
  if (typeof projectDef.vBRIEFInfo !== "object" || projectDef.vBRIEFInfo === null) {
    projectDef.vBRIEFInfo = {};
  }
  (projectDef.vBRIEFInfo as JsonObject).updated = now;
  projectDef.plan = plan;

  writeFileSync(projectDefPath, `${JSON.stringify(projectDef, null, 2)}\n`, "utf8");
  const ackCount = completedItems.length;
  return [
    true,
    `✓ PROJECT-DEFINITION staleness acknowledged (${ackCount} completed scope(s) watermarked)`,
  ];
}

/** CLI entry (mirrors ``scripts/project_render.main``). */
export function main(argv: readonly string[]): number {
  const acknowledge = argv[0] === "--acknowledge-staleness";
  const rest = acknowledge ? argv.slice(1) : argv;
  if (rest.length > 1) {
    process.stderr.write("Usage: project_render.py [--acknowledge-staleness] [vbrief_dir]\n");
    return 2;
  }
  const vbriefDir = rest[0] ?? "vbrief";
  const [ok, message] = acknowledge
    ? acknowledgeProjectDefinitionStaleness(vbriefDir)
    : renderProjectDefinition(vbriefDir);
  process.stdout.write(`${message}\n`);
  return ok ? 0 : 1;
}
