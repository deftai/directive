import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  hasArtifactSuffix,
  resolveLayoutRootOrCanonical,
  stripArtifactSuffix,
} from "../layout/resolve.js";
import { EMITTED_VBRIEF_VERSION } from "../vbrief-build/constants.js";
import { withProjectDefinitionMutation } from "../vbrief-build/project-definition-mutation.js";
import {
  deriveRegistryItemStatus,
  registryMetadataReferencesFromScope,
} from "../vbrief-validate/registry-status.js";
import {
  LEGACY_ARTIFACT_SUFFIX,
  LEGACY_INFO_ROOT_KEY,
  MIGRATED_ARTIFACT_DIR,
  MIGRATED_ARTIFACT_SUFFIX,
  MIGRATED_INFO_ROOT_KEY,
  VBRIEF_VERSION,
} from "../xbrief-migrate/constants.js";
import { PROJECT_LIFECYCLE_FOLDERS, SKELETON_NARRATIVES } from "./constants.js";
import { splitCamel, splitWords } from "./text-utils.js";

type JsonObject = Record<string, unknown>;

/** PROJECT-DEFINITION artifact shape (filename + envelope key + emitted version). */
interface ProjectDefinitionLayout {
  readonly filename: string;
  readonly infoRootKey: typeof MIGRATED_INFO_ROOT_KEY | typeof LEGACY_INFO_ROOT_KEY;
  readonly infoVersion: string;
}

/**
 * Resolve the PROJECT-DEFINITION artifact shape for a lifecycle root directory.
 *
 * The decision is STRUCTURAL and keyed on the lifecycle root directory name -- the
 * same signal `resolveLifecycleLayout` / `resolveLifecycleRoot` produce, so ingest and
 * render never diverge (#2149). A migrated `xbrief/` root gets `PROJECT-DEFINITION.xbrief.json`
 * + `xBRIEFInfo`; a legacy `vbrief/` root keeps `PROJECT-DEFINITION.vbrief.json` + `vBRIEFInfo`.
 * This prevents render from writing a legacy-named/enveloped artifact into a migrated tree.
 */
function resolveProjectDefinitionLayout(vbriefDir: string): ProjectDefinitionLayout {
  const migrated = basename(vbriefDir) === MIGRATED_ARTIFACT_DIR;
  return migrated
    ? {
        filename: `PROJECT-DEFINITION${MIGRATED_ARTIFACT_SUFFIX}`,
        infoRootKey: MIGRATED_INFO_ROOT_KEY,
        infoVersion: VBRIEF_VERSION,
      }
    : {
        filename: `PROJECT-DEFINITION${LEGACY_ARTIFACT_SUFFIX}`,
        infoRootKey: LEGACY_INFO_ROOT_KEY,
        infoVersion: EMITTED_VBRIEF_VERSION,
      };
}

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
        .filter((n) => hasArtifactSuffix(n))
        .sort();
    } catch {
      continue;
    }
    for (const vbriefFile of files) {
      const full = join(folder, vbriefFile);
      try {
        const data = JSON.parse(readFileSync(full, "utf8")) as JsonObject;
        const plan = (data.plan ?? {}) as JsonObject;
        const title = String(plan.title ?? stripArtifactSuffix(vbriefFile));
        const status = deriveRegistryItemStatus(plan.status, folderName);
        const references = registryMetadataReferencesFromScope(plan.references);
        const item: LifecycleItem = {
          id: stripArtifactSuffix(vbriefFile),
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
          id: stripArtifactSuffix(vbriefFile),
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

export function createSkeleton(
  items: LifecycleItem[],
  now: string,
  layout: ProjectDefinitionLayout,
): JsonObject {
  const completedItems = items.filter((i) => i.status === "completed");
  const stalenessFlags = computeStalenessFlags({ ...SKELETON_NARRATIVES }, completedItems);
  return {
    [layout.infoRootKey]: {
      version: layout.infoVersion,
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

/**
 * Regenerate the PROJECT-DEFINITION artifact for `vbriefDir`.
 *
 * Layout-aware (#2149): on a migrated `xbrief/` root it targets
 * `PROJECT-DEFINITION.xbrief.json` with an `xBRIEFInfo` envelope; on a legacy `vbrief/`
 * root it keeps `PROJECT-DEFINITION.vbrief.json` + `vBRIEFInfo`.
 * (Mirrors ``scripts/project_render.render_project_definition``.)
 */
export function renderProjectDefinition(
  vbriefDir: string,
  options: RenderProjectOptions = {},
): RenderProjectResult {
  // Serialise the whole read-modify-write of PROJECT-DEFINITION under the shared
  // mutation lock so a concurrent policy/triage mutator cannot be clobbered by the
  // materialised items/metadata write (or vice versa) (#1260).
  const projectRoot = resolve(vbriefDir, "..");
  return withProjectDefinitionMutation(projectRoot, (mutation): RenderProjectResult => {
    const nowDate = options.now ?? new Date();
    const now = nowDate.toISOString().replace(/\.\d{3}Z$/, "Z");
    const layout = resolveProjectDefinitionLayout(vbriefDir);
    // Read and write the artifact the lock captured, not a second independent
    // resolution of the same file (#3796). Resolving it again here is how a
    // render could lock one identity and materialise items into another.
    const projectDefPath = mutation.artifactPath;
    const items = scanLifecycleFolders(vbriefDir);
    const createdNew = !existsSync(projectDefPath);

    let projectDef: JsonObject;
    if (existsSync(projectDefPath)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(projectDefPath, "utf8"));
      } catch (exc) {
        return [false, `✗ Failed to read ${projectDefPath}: ${String(exc)}`];
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return [false, `✗ ${projectDefPath} top-level value is not a JSON object`];
      }
      projectDef = parsed as JsonObject;
      const plan = (projectDef.plan ?? {}) as JsonObject;
      plan.items = items;
      if (
        typeof projectDef[layout.infoRootKey] !== "object" ||
        projectDef[layout.infoRootKey] === null
      ) {
        projectDef[layout.infoRootKey] = {};
      }
      (projectDef[layout.infoRootKey] as JsonObject).updated = now;
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
      projectDef = createSkeleton(items, now, layout);
    }

    mkdirSync(vbriefDir, { recursive: true });
    // Atomic temp+rename write under the lock so external readers never observe
    // a partially-written PROJECT-DEFINITION (#1260).
    mutation.persist(projectDef);

    const itemCount = items.length;
    const planMeta = ((projectDef.plan as JsonObject)?.metadata ?? {}) as JsonObject;
    const flagCount = Array.isArray(planMeta.staleness_flags) ? planMeta.staleness_flags.length : 0;
    const action = createdNew ? "created" : "updated";
    const parts = [`✓ ${layout.filename} ${action} (${itemCount} scope items)`];
    if (flagCount > 0) parts.push(`⚠ ${flagCount} staleness flag(s) -- agent review recommended`);
    return [true, parts.join("\n")];
  });
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
  // Serialise the read-modify-write of PROJECT-DEFINITION under the shared
  // mutation lock so a concurrent policy/triage mutator is not clobbered (#1260).
  const projectRoot = resolve(vbriefDir, "..");
  return withProjectDefinitionMutation(projectRoot, (mutation): RenderProjectResult => {
    const nowDate = options.now ?? new Date();
    const now = isoTimestamp(nowDate);
    const layout = resolveProjectDefinitionLayout(vbriefDir);
    // Read and write the artifact the lock captured (#3796) -- see the note in
    // `renderProjectDefinition`.
    const projectDefPath = mutation.artifactPath;
    if (!existsSync(projectDefPath)) {
      return [false, `✗ ${projectDefPath} not found — run project:render first`];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(projectDefPath, "utf8"));
    } catch (exc) {
      return [false, `✗ Failed to read ${projectDefPath}: ${String(exc)}`];
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [false, `✗ ${projectDefPath} top-level value is not a JSON object`];
    }
    const projectDef = parsed as JsonObject;

    const plan = (projectDef.plan ?? {}) as JsonObject;
    if (
      typeof plan.metadata !== "object" ||
      plan.metadata === null ||
      Array.isArray(plan.metadata)
    ) {
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
    if (
      typeof projectDef[layout.infoRootKey] !== "object" ||
      projectDef[layout.infoRootKey] === null
    ) {
      projectDef[layout.infoRootKey] = {};
    }
    (projectDef[layout.infoRootKey] as JsonObject).updated = now;
    projectDef.plan = plan;

    // Atomic temp+rename write under the lock so external readers never observe
    // a partially-written PROJECT-DEFINITION (#1260).
    mutation.persist(projectDef);
    const ackCount = completedItems.length;
    return [
      true,
      `✓ PROJECT-DEFINITION staleness acknowledged (${ackCount} completed scope(s) watermarked)`,
    ];
  });
}

const USAGE = "Usage: project-render [--help] [--acknowledge-staleness] [--project-root <dir>]\n";

/** CLI entry (mirrors ``scripts/project_render.main``). */
export function main(argv: readonly string[]): number {
  // Handle --help / -h before any other parsing so the flag is never treated
  // as a positional output path and no stray ./--help/ directory is created
  // (#2236).
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }

  // Parse all flags in a single positional-independent pass so that
  // --acknowledge-staleness is recognised at any position (not only argv[0]).
  let acknowledge = false;
  let projectRoot: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--acknowledge-staleness") {
      acknowledge = true;
    } else if (arg === "--project-root") {
      projectRoot = argv[i + 1] as string | undefined;
      i += 1;
    } else if (arg.startsWith("--project-root=")) {
      projectRoot = arg.slice("--project-root=".length);
    } else if (arg.startsWith("-")) {
      // Reject unknown flags rather than consuming them as positional output
      // paths (would otherwise create stray directories like ./--help/).
      process.stderr.write(`Unknown flag: ${arg}\n${USAGE}`);
      return 2;
    } else {
      positional.push(arg);
    }
  }

  if (positional.length > 1) {
    process.stderr.write(USAGE);
    return 2;
  }

  let vbriefDir: string;
  if (positional[0] !== undefined) {
    vbriefDir = positional[0];
  } else {
    const effectiveRoot = resolve(projectRoot !== undefined ? projectRoot : ".");
    try {
      vbriefDir = resolveLayoutRootOrCanonical(effectiveRoot);
    } catch {
      process.stderr.write(
        `No xbrief/ layout found at ${effectiveRoot}. Run \`deft migrate:xbrief\` to convert your project from the legacy vbrief/ layout.\n`,
      );
      return 2;
    }
  }

  const [ok, message] = acknowledge
    ? acknowledgeProjectDefinitionStaleness(vbriefDir)
    : renderProjectDefinition(vbriefDir);
  process.stdout.write(`${message}\n`);
  return ok ? 0 : 1;
}
