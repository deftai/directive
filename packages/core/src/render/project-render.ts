import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EMITTED_VBRIEF_VERSION } from "../vbrief-build/constants.js";
import { PROJECT_LIFECYCLE_FOLDERS, SKELETON_NARRATIVES } from "./constants.js";
import { splitCamel, splitWords } from "./text-utils.js";

type JsonObject = Record<string, unknown>;

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
        const status = String(plan.status ?? folderName);
        const references = plan.references;
        const item: LifecycleItem = {
          id: vbriefFile.replace(/\.vbrief\.json$/, "").replace(/\.vbrief$/, ""),
          title,
          status,
          metadata: {
            source_path: `${folderName}/${vbriefFile}`,
            lifecycle_folder: folderName,
          },
        };
        if (Array.isArray(references) && references.length > 0) {
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

export function createSkeleton(items: LifecycleItem[], now: string): JsonObject {
  const completedItems = items.filter((i) => i.status === "completed");
  const stalenessFlags = flagStaleNarratives({ ...SKELETON_NARRATIVES }, completedItems);
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
    const flags = flagStaleNarratives(narratives, completedItems);
    if (
      typeof plan.metadata !== "object" ||
      plan.metadata === null ||
      Array.isArray(plan.metadata)
    ) {
      plan.metadata = {};
    }
    (plan.metadata as JsonObject).staleness_flags = flags;
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

/** CLI entry (mirrors ``scripts/project_render.main``). */
export function main(argv: readonly string[]): number {
  if (argv.length > 1) {
    process.stderr.write("Usage: project_render.py [vbrief_dir]\n");
    return 2;
  }
  const vbriefDir = argv[0] ?? "vbrief";
  const [ok, message] = renderProjectDefinition(vbriefDir);
  process.stdout.write(`${message}\n`);
  return ok ? 0 : 1;
}
